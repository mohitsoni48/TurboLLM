// POST /api/v1/engines/turboquant?update=1 swaps the new release in at the same path, so it keeps the engine's
// registry entry: that entry must be re-probed, or it keeps the old build's version and capabilities (flags and KV
// types the new build added stay gated off). GitHub is a stubbed fetch; the binaries are shell scripts (POSIX only).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { ConfigStore } from '../config/config'
import { Registry } from '../engines/registry'
import { tmpDir } from '../test-support/tmp'

const NEW_SERVER = '#!/bin/sh\necho "version: 200 (abcdef1)"\necho "  --cache-type-k TYPE"\n'

function writeExe(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

test('?update=1 re-probes the TurboQuant engine it keeps: the new build\'s version replaces the old one', {
  skip: process.platform === 'win32' && 'TurboQuant has no Windows prebuilt; shell-script binaries',
}, async (t) => {
  const store = ConfigStore.load(join(tmpDir('tllm-tq-route-'), 'config.json'))
  const bin = join(store.dir(), 'engines', 'turboquant', 'llama-server')
  writeExe(bin, '#!/bin/sh\necho "version: 100 (old1234)"\n')
  store.update((c) => {
    c.engines.push({ id: 'tq', name: 'TurboQuant', kind: 'llama-server', binPath: bin, version: '100 (old1234)', capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-01-01T00:00:00Z' })
  })
  const src = tmpDir('tllm-tq-src-')
  writeExe(join(src, 'llama-server'), NEW_SERVER)
  const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', src, 'llama-server'])
  const osTag = process.platform === 'darwin' ? 'macos' : 'linux'
  const asset = `llama-b200-bin-${osTag}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).includes('api.github.com')
      ? new Response(JSON.stringify([{ tag_name: `b200-${osTag}`, assets: [{ name: asset, browser_download_url: `https://cdn.test/${asset}` }] }]))
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
  const res = await app.request('/api/v1/engines/turboquant?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  for (let i = 0; i < 200 && settled.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
  assert.deepEqual(settled, ['done'])
  assert.equal(readFileSync(bin, 'utf8'), NEW_SERVER)
  assert.equal(registry.get('tq')?.version, '200 (abcdef1)')
  assert.deepEqual(registry.list().engines.map((e) => e.id), ['tq'])
})
