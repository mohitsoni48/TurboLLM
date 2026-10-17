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
import { execFileSync } from 'node:child_process'
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { ConfigStore, type Engine } from '../config/config'
import { availableBackends } from '../engines/download'
import { koboldcppAssetName, koboldcppBinPath } from '../engines/koboldcpp'
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
  const provision = { get: () => ({ active: false }), start() {}, progress() {}, done: () => settle(null), fail: (m: string) => settle(m) }
  const d = {
    version: 'test',
    store,
    registry,
    manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
    provision,
    build: { isActive: () => false },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, d, registry, provision, newBin: join(newDir, 'llama-server'), newDir, finished }
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

// The new build is registered by then: a Windows AV/indexer lock on the replaced build's folder must not report the
// finished update as failed ("your existing build is unchanged"). routes.ts imports rmSync by name:
// syncBuiltinESMExports carries the patch to that binding.
test('POST /backends/:id/update whose old build folder is locked still reports a finished update', { skip: posixOnly }, async (t) => {
  const h = harness(t, WORKING_SERVER)
  const oldDir = dirname(h.registry.get('old')!.binPath)
  const realRmSync = fs.rmSync
  const locked = t.mock.method(fs, 'rmSync', (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p) === oldDir) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return realRmSync(p, o)
  })
  syncBuiltinESMExports()
  try {
    const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/update`, { method: 'POST' })
    assert.equal(res.status, 202)
    assert.equal(await h.finished, null)
  } finally {
    locked.mock.restore()
    syncBuiltinESMExports()
  }
  assert.ok(h.registry.list().engines.some((e) => e.binPath === h.newBin), 'the new build is registered')
  assert.ok(existsSync(oldDir), 'the locked old build is left behind')
  const oldDirDelete = locked.mock.calls.find((c) => String(c.arguments[0]) === oldDir)
  assert.ok((oldDirDelete?.arguments[1] as fs.RmOptions | undefined)?.maxRetries, 'the delete retries, as a Windows lock is brief')
})

// The route read "was the old build active" before stopping what ran on it. Stopping a pool slot leaves the manager
// idle, so the activate route allows a switch meanwhile; that switch must survive the update.
test('POST /backends/:id/update of the active backend keeps a switch the user made while its pool slots stopped', { skip: posixOnly }, async (t) => {
  const h = harness(t, WORKING_SERVER)
  h.registry.activate('old')
  h.d.modelRouter = { stopPoolSlotsOnEngine: async () => { h.registry.activate('cuda') } } as unknown as Deps['modelRouter']
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/update`, { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(await h.finished, null)
  assert.equal(h.registry.active()?.id, 'cuda')
  assert.ok(h.registry.list().engines.some((e) => e.binPath === h.newBin), 'the update still happened')
})

// Same, for the update policy the new build inherits: its config.json save can be refused by a Windows lock too.
test('POST /backends/:id/update whose policy copy cannot be saved still reports a finished update', { skip: posixOnly }, async (t) => {
  const h = harness(t, WORKING_SERVER)
  const oldDir = dirname(h.registry.get('old')!.binPath)
  t.mock.method(h.registry, 'setUpdatePolicy', () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) })
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/update`, { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(await h.finished, null)
  assert.ok(h.registry.list().engines.some((e) => e.binPath === h.newBin), 'the new build is registered')
  assert.equal(h.registry.get('old'), undefined, 'the old build is unregistered')
  assert.equal(existsSync(oldDir), false, 'the old build is deleted')
})

// The route checks the engine-work slot before its GitHub lookup; a scheduler auto-update (or another tab) can take the
// slot during that lookup. Starting anyway would run two jobs into the same tag dir on one progress/Cancel channel.
test('POST /backends/:id/update whose GitHub lookup let another engine job take the slot is a 409 and starts nothing', { skip: posixOnly }, async (t) => {
  const h = harness(t, WORKING_SERVER)
  let active = false
  t.mock.method(h.provision, 'get', () => ({ active }))
  const start = t.mock.method(h.provision, 'start')
  const lookup = globalThis.fetch
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    active = true // the scheduler's auto-update started meanwhile
    return lookup(...args)
  }) as typeof fetch
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/update`, { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'engine_already_running')
  assert.equal(start.mock.callCount(), 0)
  assert.ok(h.registry.get('old'), 'the installed build is untouched')
})

// On Android (Termux) the build is TurboLLM's own, one pinned file on Hugging Face: upstream's newer tags have no
// Android asset there, so the update resolved one from GitHub and then always failed with HTTP 404.
test('POST /backends/:id/update on Android is a 409 no_update_source and looks nothing up', { skip: posixOnly }, async (t) => {
  const h = harness(t, WORKING_SERVER)
  writeServer(join(dirname(h.newDir), 'llama.cpp-b9608-cpu'), WORKING_SERVER)
  let fetches = 0
  const stagedFetch = globalThis.fetch
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => (fetches++, stagedFetch(...args))) as typeof fetch
  const actualPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'android' })
  t.after(() => Object.defineProperty(process, 'platform', { value: actualPlatform }))
  const res = await h.app.request('/api/v1/engines/backends/cpu/update', { method: 'POST' })
  Object.defineProperty(process, 'platform', { value: actualPlatform })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'no_update_source')
  assert.equal(fetches, 0)
})

test('POST /backends/:id/enable on a build that no longer runs is a 400 with the probe error, not a 500', { skip: posixOnly }, async (t) => {
  const h = harness(t, BROKEN_SERVER, { stageNow: true })
  h.registry.remove('old') // Disabled: Enable re-registers the newest build on disk, the broken b200
  const res = await h.app.request(`/api/v1/engines/backends/${backend.id}/enable`, { method: 'POST' })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error?: { code: string } }).error?.code, 'probe_failed')
  assert.ok(existsSync(dirname(h.newBin)))
})

// The same rule on the llamafile card: Update leaves the active engine as it was, and only an engine that was active is
// active afterwards. An install still activates. Each install route has its own copy of the rule, so this covers
// llamafile only; routes.update-activation.test.ts covers TurboQuant, KoboldCpp, vLLM, SGLang and the MLX family.
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

// Each catalog card's Update (POST /engines/<kind>?update=1) read "is it the active engine" before the download or pip
// upgrade (minutes), and re-activated the updated engine from that snapshot afterwards. The activate route allows a
// switch whenever no model is loaded (the update stopped what ran on the engine), so a switch the user made meanwhile
// was silently undone. The switch is made from the route's own progress callback, i.e. mid-download. vLLM and SGLang
// stand for the pip routes (MLX and its siblings need macOS, and LiteRT-LM asks PyPI first): their uv and venv python
// are shell scripts, so `uv pip install -U` and the version probe run instantly.
const ALL_KOBOLD_ASSETS = ['koboldcpp.exe', 'koboldcpp-nocuda.exe', 'koboldcpp-linux-x64', 'koboldcpp-linux-x64-nocuda', 'koboldcpp-mac-arm64']
  .map((name) => ({ name, browser_download_url: `https://dl.test/${name}` }))

type SwitchCase = { route: string; engine: (root: string) => Engine; stage: (root: string) => void }

function switchCases(t: { after: (fn: () => void) => void }): SwitchCase[] {
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const serve = (release: unknown, download: () => Response) => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      (url instanceof Request ? url.url : String(url)).includes('api.github.com') ? new Response(JSON.stringify(release)) : download()) as typeof fetch
  }
  const exe = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    chmodSync(path, 0o755)
  }
  const eng = (id: string, kind: Engine['kind'], binPath: string, version: string): Engine =>
    ({ id, name: id, binPath, kind, version, capabilities: { kvTypes: [], flags: [] }, addedAt: '' }) as Engine
  const cases: SwitchCase[] = [{
    route: 'llamafile',
    engine: (root) => eng('llamafile', 'llamafile', llamafileBinPath(root), '0.10.2'),
    stage: (root) => {
      exe(llamafileBinPath(root), 'llamafile 0.10.2')
      serve({ tag_name: '0.10.3', assets: [{ name: 'llamafile-0.10.3', browser_download_url: 'https://dl.test/llamafile' }] }, () => new Response('llamafile 0.10.3'))
    },
  }]
  if (koboldcppAssetName(false) || koboldcppAssetName(true)) {
    cases.push({
      route: 'koboldcpp',
      engine: (root) => eng('kobold', 'koboldcpp', koboldcppBinPath(root), 'v1.0.0'),
      stage: (root) => {
        exe(koboldcppBinPath(root), 'kobold v1')
        serve({ tag_name: 'v2.0.0', assets: ALL_KOBOLD_ASSETS }, () => new Response('kobold v2'))
      },
    })
  }
  if (process.platform !== 'win32') {
    cases.push({
      route: 'turboquant',
      engine: (root) => eng('tq', 'llama-server', join(root, 'turboquant', 'llama-server'), '100 (old1234)'),
      stage: (root) => {
        exe(join(root, 'turboquant', 'llama-server'), '#!/bin/sh\necho "version: 100 (old1234)"\n')
        const src = tmpDir('tllm-tq-src-')
        exe(join(src, 'llama-server'), WORKING_SERVER)
        const archive = join(tmpDir('tllm-tq-'), 'tq.tar.gz')
        execFileSync('tar', ['-czf', archive, '-C', src, 'llama-server'])
        const osTag = process.platform === 'darwin' ? 'macos' : 'linux'
        const asset = `llama-b200-bin-${osTag}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`
        serve([{ tag_name: `b200-${osTag}`, assets: [{ name: asset, browser_download_url: `https://cdn.test/${asset}` }] }], () => new Response(readFileSync(archive)))
      },
    })
  }
  for (const kind of ['vllm', 'sglang'] as const) {
    cases.push({
      route: kind,
      engine: (root) => eng(kind, kind, join(root, kind, 'venv', 'bin', 'python'), `${kind} 0.9.0`),
      stage: (root) => {
        exe(join(root, 'uv', 'uv'), '#!/bin/sh\nexit 0\n')
        exe(join(root, kind, 'venv', 'bin', 'python'), '#!/bin/sh\necho 0.9.1\n')
      },
    })
  }
  return cases
}

test('POST /engines/<kind>?update=1 keeps an engine switch the user made while it downloaded (llamafile, KoboldCpp, TurboQuant, pip)', {
  skip: process.platform === 'win32' && 'shell-script engine binaries',
}, async (t) => {
  const cases = switchCases(t)
  assert.ok(cases.length >= 4)
  for (const { route, engine, stage } of cases) {
    const store = ConfigStore.load(join(tmpDir('tllm-update-switch-'), 'config.json'))
    const root = join(store.dir(), 'engines')
    const updated = engine(root)
    store.update((c) => {
      c.engines.push({ id: 'cuda', name: 'cuda', binPath: '/opt/cuda/llama-server', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' }, updated)
      c.activeEngineId = updated.id // active when the update starts
    })
    stage(root)
    const registry = new Registry(store)
    let switched = false
    let settle: (failure: string | null) => void = () => {}
    const finished = new Promise<string | null>((r) => { settle = r })
    const d = {
      version: 'test',
      store,
      registry,
      manager: { status: () => ({ state: 'stopped', model: null }), currentOpts: () => null, stopAndWait: async () => {}, logPath: () => '' },
      provision: {
        get: () => ({ active: false }),
        start() {},
        progress: () => { if (!switched) { switched = true; registry.activate('cuda') } }, // the user picks another engine
        done: () => settle(null),
        fail: (m: string) => settle(m),
      },
      build: { isActive: () => false },
    } as unknown as Deps
    const app = new Hono()
    registerApi(app, d)
    assert.equal((await app.request(`/api/v1/engines/${route}?update=1`, { method: 'POST' })).status, 202, route)
    assert.equal(await finished, null, route)
    assert.ok(switched, `${route}: the switch happened during the update`)
    assert.notEqual(registry.get(updated.id)?.version, updated.version, `${route}: it was updated`)
    assert.equal(registry.active()?.id, 'cuda', `${route}: the engine the user switched to stays active`)
  }
})
