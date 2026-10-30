// POST /api/v1/engines/turboquant?update=1 swaps the new release in at the same path, so it keeps the engine's
// registry entry: that entry must be re-probed, or it keeps the old build's version and capabilities (flags and KV
// types the new build added stay gated off). A new build that fails that probe is swapped back out for the old one, and
// a model loaded on the engine during the download refuses the swap. GitHub is a stubbed fetch; the binaries are shell
// scripts (POSIX only).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { ConfigStore } from '../config/config'
import { Registry } from '../engines/registry'
import { tmpDir } from '../test-support/tmp'
import { turboquantReleaseList } from '../test-support/turboquant-release'

const NEW_SERVER = '#!/bin/sh\necho "version: 200 (abcdef1)"\necho "  --cache-type-k TYPE"\n'

function writeExe(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

const OLD_SERVER = '#!/bin/sh\necho "version: 100 (old1234)"\n'
const BROKEN_SERVER = '#!/bin/sh\necho "error while loading shared libraries: libvulkan.so.1" >&2\nexit 127\n'
const skip = process.platform === 'win32' && 'TurboQuant has no Windows prebuilt; shell-script binaries'

/** A TurboQuant engine at engines/turboquant/llama-server, the route over it, and a stubbed GitHub release whose
 *  archive holds `newServer`. `update` POSTs ?update=1 and returns how the provision job ended. */
function harness(t: { after: (fn: () => void) => void }, newServer: string, newPath = 'llama-server') {
  const store = ConfigStore.load(join(tmpDir('tllm-tq-route-'), 'config.json'))
  const bin = join(store.dir(), 'engines', 'turboquant', 'llama-server')
  writeExe(bin, OLD_SERVER)
  store.update((c) => {
    c.engines.push({ id: 'tq', name: 'TurboQuant', kind: 'llama-server', binPath: bin, version: '100 (old1234)', capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z' })
  })
  const src = tmpDir('tllm-tq-src-')
  writeExe(join(src, newPath), newServer)
  const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', src, newPath.split('/')[0]!])
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).includes('api.github.com')
      ? new Response(JSON.stringify(turboquantReleaseList()))
      : new Response(readFileSync(archive))) as typeof fetch

  const settled: string[] = []
  const registry = new Registry(store)
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped' }), currentOpts: () => null, stopAndWait: async () => {} },
    provision: {
      get: () => ({ active: false }),
      start() {},
      progress() {},
      done: () => { settled.push('done') },
      fail: (m: string) => { settled.push(`fail:${m}`) },
    },
    build: { isActive: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  const update = async (): Promise<string[]> => {
    const res = await app.request('/api/v1/engines/turboquant?update=1', { method: 'POST' })
    assert.equal(res.status, 202)
    for (let i = 0; i < 200 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    return settled
  }
  return { d, registry, bin, root: join(store.dir(), 'engines'), update }
}

test('?update=1 re-probes the TurboQuant engine it keeps: the new build\'s version replaces the old one', { skip }, async (t) => {
  const h = harness(t, NEW_SERVER)
  assert.deepEqual(await h.update(), ['done'])
  assert.equal(readFileSync(h.bin, 'utf8'), NEW_SERVER)
  assert.equal(h.registry.get('tq')?.version, '200 (abcdef1)')
  assert.deepEqual(h.registry.list().engines.map((e) => e.id), ['tq'])
})

// The new release was swapped in and the old build deleted before the re-probe ran: a build that does not run here
// stayed in place under the old version string, and the same update kept being offered.
test('?update=1 whose new build fails its probe puts the old build back and keeps its version', { skip }, async (t) => {
  const h = harness(t, BROKEN_SERVER)
  const settled = await h.update()
  assert.equal(settled.length, 1)
  assert.match(settled[0]!, /^fail:Could not update TurboQuant — your existing build is unchanged: Could not run the binary/)
  assert.equal(readFileSync(h.bin, 'utf8'), OLD_SERVER, 'the old build is back in place')
  assert.equal(h.registry.get('tq')?.version, '100 (old1234)')
  assert.deepEqual(readdirSync(h.root), ['turboquant'], 'neither the new build nor a parked copy is left behind')
})

// The route stops what runs on TurboQuant before the download, which takes minutes; a model loaded on it meanwhile had
// its files swapped under it (on Windows the rename fails with an opaque EPERM). Re-checked at the swap now.
test('?update=1: a model loaded on TurboQuant during the download blocks the swap and keeps the old build', { skip }, async (t) => {
  const h = harness(t, NEW_SERVER)
  let running = false
  Object.assign(h.d.manager, {
    status: () => ({ state: running ? 'running' : 'stopped' }),
    currentOpts: () => (running ? { engine: h.registry.get('tq') } : null),
  })
  Object.assign(h.d.provision, { progress: () => { running = true } }) // the user loads a model mid-download
  const settled = await h.update()
  assert.equal(settled.length, 1)
  assert.match(settled[0]!, /^fail:Could not update TurboQuant — your existing build is unchanged: Stop "TurboQuant" before replacing its files/)
  assert.equal(readFileSync(h.bin, 'utf8'), OLD_SERVER)
  assert.equal(h.registry.get('tq')?.version, '100 (old1234)')
})

// A release that moves the binary within the archive lands at another path: the route looked the entry up by the new
// path, found none, and added a second "TurboQuant", which the taken name refused (after the old build was deleted).
test('?update=1 whose binary moved within the archive moves the TurboQuant engine to it', { skip }, async (t) => {
  const h = harness(t, NEW_SERVER, 'bin/llama-server')
  assert.deepEqual(await h.update(), ['done'])
  const moved = join(h.root, 'turboquant', 'bin', 'llama-server')
  assert.deepEqual(h.registry.list().engines.map((e) => e.id), ['tq'])
  assert.equal(h.registry.get('tq')?.binPath, moved)
  assert.equal(h.registry.get('tq')?.version, '200 (abcdef1)')
  assert.equal(readFileSync(moved, 'utf8'), NEW_SERVER)
})
