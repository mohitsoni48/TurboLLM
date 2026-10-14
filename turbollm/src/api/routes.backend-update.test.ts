// Route-level coverage for the official llama.cpp backend update / enable paths:
//  - POST /engines/backends/:id/update must not make a backend that was NOT the active engine the
//    active one (a CUDA user updating a Vulkan fallback kept loading on Vulkan afterwards), and the
//    new build (a new engine id) keeps the old one's update policy.
//  - A new build that fails its probe is removed again; left on disk with its completion marker,
//    the newest-tag-wins lookup made Update answer "already latest" and Enable fail.
//  - Enable on a build that no longer runs is a clear 400 (as POST /engines), not an opaque 500.
// No network: GitHub's release list is a stubbed fetch, which also stages the new build on disk
// with its completion marker (after the route picked the installed build), so provisionBackend's
// fast path returns it as if just downloaded. The binaries are shell scripts, so POSIX only.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { availableBackends } from '../engines/download'
import { llamafileBinPath } from '../engines/llamafile'
import { Registry } from '../engines/registry'
import type { Deps } from '../deps'
import { registerApi } from './routes'
import { tmpDir } from '../test-support/tmp'

const backend = availableBackends()[0]!
const posixOnly = (process.platform === 'win32' || !backend) && 'uses shell-script engine binaries and a llama.cpp backend for this OS'
const WORKING_SERVER = '#!/bin/sh\necho "version: 200 (abcdef1)"\n'
const BROKEN_SERVER = '#!/bin/sh\nexit 127\n'

function writeServer(dir: string, text: string): string {
  const bin = join(dir, 'llama-server')
  mkdirSync(dir, { recursive: true })
  writeFileSync(bin, text)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, '.turbollm-provisioned'), '')
  return bin
}

function harness(t: { after: (fn: () => void) => void }, newServer: string, opts: { stageNow?: boolean } = {}) {
  const store = ConfigStore.load(join(tmpDir('tllm-backend-update-'), 'config.json'))
  const root = join(store.dir(), 'engines')
  const oldBin = writeServer(join(root, `llama.cpp-b100-${backend.id}`), WORKING_SERVER)
  const newDir = join(root, `llama.cpp-b200-${backend.id}`)
  if (opts.stageNow) writeServer(newDir, newServer)
  const eng = (id: string, binPath: string, extra: Partial<Engine> = {}): Engine =>
    ({ id, name: id, binPath, kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, ...extra }) as Engine
  store.update((c) => {
    c.engines.push(eng('cuda', '/opt/cuda/llama-server'), eng('old', oldBin, { updatePolicy: 'auto' }))
    c.activeEngineId = 'cuda'
  })
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async () => {
    if (!existsSync(newDir)) writeServer(newDir, newServer)
    return new Response(JSON.stringify([{ tag_name: 'b200' }, { tag_name: 'b100' }]))
  }) as typeof fetch
  let settle: (failure: string | null) => void = () => {}
  const finished = new Promise<string | null>((r) => { settle = r })
  const registry = new Registry(store)
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
    provision: { get: () => ({ active: false }), start() {}, progress() {}, done: () => settle(null), fail: (m: string) => settle(m) },
    build: { isActive: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, registry, newBin: join(newDir, 'llama-server'), newDir, finished }
}

test('POST /backends/:id/update of a backend that is not the active engine keeps the active engine and the update policy', { skip: posixOnly }, async (t) => {
  const h = harness(t, WORKING_SERVER)
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/update`, { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(await h.finished, null)
  const updated = h.registry.list().engines.find((e) => e.binPath === h.newBin)
  assert.ok(updated, 'the new build is registered')
  assert.equal(h.registry.active()?.id, 'cuda')
  assert.equal(updated.updatePolicy, 'auto')
})

test('POST /backends/:id/update whose new build fails its probe removes it, so Enable still finds the working build', { skip: posixOnly }, async (t) => {
  const h = harness(t, BROKEN_SERVER)
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/update`, { method: 'POST' })
  assert.equal(res.status, 202)
  assert.match((await h.finished) ?? '', /existing build is unchanged/)
  assert.equal(existsSync(h.newDir), false)
  assert.ok(h.registry.get('old'), 'the working build is still registered')
})

test('POST /backends/:id/enable on a build that no longer runs is a 400 with the probe error, not a 500', { skip: posixOnly }, async (t) => {
  const h = harness(t, BROKEN_SERVER, { stageNow: true })
  h.registry.remove('old') // Disabled: Enable re-registers the newest build on disk, the broken b200
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/enable`, { method: 'POST' })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error?: { code: string } }).error?.code, 'probe_failed')
  assert.ok(existsSync(dirname(h.newBin)))
})

// The same rule on the single-binary cards (TurboQuant, KoboldCpp, llamafile share it): Update leaves the active engine
// as it was, and only an engine that was active is active afterwards. An install still activates. llamafile is the one
// exercised here: no probe, and its download is a single stubbed file.
function llamafileHarness(t: { after: (fn: () => void) => void }) {
  const store = ConfigStore.load(join(tmpDir('tllm-llamafile-update-'), 'config.json'))
  const registry = new Registry(store)
  const bin = llamafileBinPath(join(store.dir(), 'engines'))
  store.update((c) => {
    c.engines.push({ id: 'cuda', name: 'cuda', binPath: '/opt/cuda/llama-server', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' })
    c.activeEngineId = 'cuda'
  })
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = url instanceof Request ? url.url : String(url)
    if (u.includes('api.github.com'))
      return new Response(JSON.stringify({ tag_name: '0.10.3', assets: [{ name: 'llamafile-0.10.3', browser_download_url: 'https://dl.test/llamafile' }] }))
    return new Response('llamafile 0.10.3')
  }) as typeof fetch
  let settle: (failure: string | null) => void = () => {}
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
    provision: { get: () => ({ active: false }), start() {}, progress() {}, done: () => settle(null), fail: (m: string) => settle(m) },
    build: { isActive: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  const run = async (query: string): Promise<string | null> => {
    const finished = new Promise<string | null>((r) => { settle = r })
    assert.equal((await app.request(`/api/v1/engines/llamafile${query}`, { method: 'POST' })).status, 202)
    return finished
  }
  return { registry, bin, run }
}

test('POST /engines/llamafile?update=1 keeps the active engine unless the updated one was it; an install activates', {
  skip: !['win32', 'darwin', 'linux'].includes(process.platform) && "outside llamafile's catalog platforms",
}, async (t) => {
  const h = llamafileHarness(t)
  mkdirSync(dirname(h.bin), { recursive: true })
  writeFileSync(h.bin, 'llamafile 0.10.2')
  const lf = h.registry.addLlamafile('llamafile (0.10.2)', h.bin, '0.10.2')
  assert.equal(h.registry.active()?.id, 'cuda')

  assert.equal(await h.run('?update=1'), null)
  assert.equal(h.registry.active()?.id, 'cuda', 'updating an inactive engine must not switch the active one')
  assert.equal(h.registry.get(lf.id)?.version, '0.10.3')

  h.registry.activate(lf.id)
  assert.equal(await h.run('?update=1'), null)
  assert.equal(h.registry.active()?.id, lf.id, 'an engine that was active stays active')

  h.registry.activate('cuda')
  h.registry.remove(lf.id) // Disabled: Install registers it again
  assert.equal(await h.run(''), null)
  assert.equal(h.registry.active()?.binPath, h.bin, 'an install activates the engine')
})
