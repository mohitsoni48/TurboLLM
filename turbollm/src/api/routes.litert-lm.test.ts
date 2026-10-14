// POST /api/v1/engines/litert-lm?update=1 must be honest about "already latest": when the
// registered LiteRT-LM engine is at the real PyPI latest, the route refuses WITHOUT
// provisioning — the old unconditional `uv pip install -U` lit the global "Downloading…"
// banner for a no-op every time "Check for update" was clicked. Mirrors the llama.cpp
// backends' alreadyLatest contract (routes.ts, ADR-085). The upstream here is the daemon's
// UpdateChecker with an injected fetcher, so no test touches the network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { UpdateChecker } from '../engines/update'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function appWithChecker(
  fetcher: (src: { source: string; ref: string }) => Promise<string>,
  installedVersion = '0.17.1',
  opts: { noUpdates?: boolean; activeEngineId?: string | null; runningKind?: string | null; storeDir?: string } = {},
) {
  const cfg: Record<string, unknown> = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996, machineId: 'm', machineName: 'test' },
    apiKeys: [],
    links: [],
    telemetry: { level: 'off', machineId: 'm' },
    modelProfiles: {},
    benchResults: {},
    modelDirs: [],
  }
  // Two engines: the LiteRT-LM one the route re-provisions, plus a non-LiteRT-LM one so
  // "active, but not this one" can be expressed.
  const engines = [
    {
      id: 'litert-1',
      name: 'LiteRT-LM (litert-lm 0.17.1)',
      kind: 'litert-lm',
      binPath: '/engines/litert-lm/venv/bin/python',
      version: `litert-lm ${installedVersion}`,
      capabilities: { kvTypes: [], flags: [] },
    },
    {
      id: 'other-1',
      name: 'llama.cpp (b1234)',
      kind: 'llama-server',
      binPath: '/engines/llama/llama-server',
      version: 'b1234',
      capabilities: { kvTypes: [], flags: [] },
    },
  ]
  const provisionCalls: string[] = []
  const managerCalls: string[] = []
  const activateCalls: string[] = []
  // The route's stop-guard keys on the engine that is RUNNING (manager currentOpts), not the
  // registry's active engine — an install activates without stopping what is loaded, so the
  // two can differ (v1.14.5). Both knobs stay mockable so every combination can be expressed;
  // by default a LiteRT-LM model is running and LiteRT-LM is also the active engine.
  const runningKind = opts.runningKind === undefined ? 'litert-lm' : opts.runningKind
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: never) => void) => fn(cfg as never), dir: () => opts.storeDir ?? '/tmp/turbollm-litert-route' },
    scanner: { list: () => ({ models: [], scanning: false, lastScanAt: '' }) },
    manager: {
      status: () => ({ state: 'stopped', err: null, port: 0, pid: 0, model: null }),
      // stopAndWait records on BOTH arrays: main's v1.14.5 tests assert on provisionCalls
      // ('stop'), PR #275's on managerCalls ('stopAndWait') — one mock serves both suites.
      stopAndWait: async () => { managerCalls.push('stopAndWait'); provisionCalls.push('stop') },
      currentOpts: () => (runningKind ? { engine: { kind: runningKind } } : undefined),
    },
    modelRouter: { loadedModelKeys: () => new Set<string>() },
    db: { lastGenTpsByModel: () => new Map<string, number>() },
    registry: {
      engines,
      list: () => ({ engines, activeEngineId: opts.activeEngineId ?? 'litert-1' }),
      active: () =>
        opts.activeEngineId === null ? undefined : engines.find((e) => e.id === (opts.activeEngineId ?? 'litert-1')),
      addLitertLm: (name: string) => ({ id: 'litert-2', name, activate: () => {} }),
      activate: (id: string) => activateCalls.push(id),
    },
    downloads: { provenance: () => [] },
    provision: {
      start: (backend: string) => provisionCalls.push(`start:${backend}`),
      progress: () => {},
      done: () => provisionCalls.push('done'),
      fail: (e: string) => provisionCalls.push(`fail:${e}`),
      get: () => ({ active: false, phase: 'idle', backend: '', pct: 0, part: 1, parts: 1, error: null }),
    },
    build: { isActive: () => false },
    // `noUpdates`: a Deps with no daemon UpdateChecker (the wiring in main.ts always builds
    // one; the route's computeUpdateStatus fallback exists for exactly that gap).
    ...(opts.noUpdates ? {} : { updates: new UpdateChecker(fetcher as never) }),
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return { app, provisionCalls, managerCalls, activateCalls }
}

test('?update=1 with the installed version already latest refuses without provisioning', async () => {
  const { app, provisionCalls } = appWithChecker(async () => '0.17.1')
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { accepted: false, alreadyLatest: true, version: '0.17.1', engine: 'litert-lm' })
  // The refusal must happen BEFORE provision.start — no banner, no re-provision.
  assert.deepEqual(provisionCalls, [])
})

test('?update=1 with a genuinely newer release proceeds to provision (accepted)', async () => {
  const { app, provisionCalls } = appWithChecker(async () => '0.18.0')
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as { accepted: boolean }).accepted, true)
  // 202 returns before the async provision body runs its first await — but start() is
  // synchronous within it, so the banner is already lit by the time the client sees 202.
  assert.ok(provisionCalls.includes('start:litert-lm'))
})

test('?update=1 with an unreachable upstream still provisions (no honest answer → old behavior)', async () => {
  const { app } = appWithChecker(async () => { throw new Error('offline') })
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as { accepted: boolean }).accepted, true)
})

test('?update=1 with an INCOMPARABLE installed version still provisions (not a false "already latest")', async () => {
  // PR #271 review: an installed version that can't be ordered against PyPI's latest (a
  // custom/unparsable build string) yields hasUpdate:false, comparable:false. The old check
  // treated that as "already latest" and refused the upgrade while telling the user they
  // were current — only a COMPARABLE no-update answer may short-circuit.
  const { app, provisionCalls } = appWithChecker(async () => '0.18.0', 'custom-build')
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as { accepted: boolean }).accepted, true)
  assert.ok(provisionCalls.includes('start:litert-lm'))
})

test('a plain install (no ?update=1) never consults the upstream and always provisions', async () => {
  const { app, provisionCalls } = appWithChecker(async () => '0.17.1')
  const res = await app.request('/api/v1/engines/litert-lm', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(((await res.json()) as { accepted: boolean }).accepted, true)
  assert.ok(provisionCalls.includes('start:litert-lm'))
})

test('an update stops a loaded LiteRT-LM model before touching its venv', async () => {
  // v1.14.5 review: on Windows the loaded native library is file-locked, so upgrading the venv under a
  // running model fails with os error 32 and can leave it half-upgraded. applyPipUpdate already
  // stopped first; this route did not.
  const { app, provisionCalls } = appWithChecker(async () => '0.18.0')
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.deepEqual(provisionCalls.slice(0, 2), ['start:litert-lm', 'stop'])
})

test('an update leaves a running model of ANOTHER engine alone, even when LiteRT-LM is the active engine', async () => {
  // Installing an engine activates it without stopping what is loaded, so "active" and "running" can
  // differ (v1.14.5 fix-delta review): a llama.cpp model the user still has loaded must not be unloaded
  // by a LiteRT-LM update, because it never held LiteRT-LM's library.
  const { app, provisionCalls } = appWithChecker(async () => '0.18.0', '0.17.1', { runningKind: 'llama-server' })
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.equal(provisionCalls.includes('stop'), false)
})

test('?update=1 without a daemon UpdateChecker falls back to computeUpdateStatus and is just as honest', async () => {
  // PR #271 re-review coverage gap: the d.updates path above is exercised everywhere, the
  // computeUpdateStatus fallback (Deps with no UpdateChecker — fetchLatest over global fetch)
  // never was. Stub globalThis.fetch (fetchLatest's pip branch calls it directly) and prove
  // the fallback answers PyPI itself and still refuses a same-version update.
  const { app, provisionCalls } = appWithChecker(
    async () => { throw new Error('the UpdateChecker must not be consulted on this path') },
    '0.17.1',
    { noUpdates: true },
  )
  const origFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (u: string | URL | Request) => {
    urls.push(String(u))
    return new Response(JSON.stringify({ info: { version: '0.17.1' } }), { status: 200 })
  }) as typeof fetch
  try {
    const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { accepted: false, alreadyLatest: true, version: '0.17.1', engine: 'litert-lm' })
    assert.deepEqual(provisionCalls, [], 'the refusal must happen before provision.start')
    assert.ok(
      urls.some((u) => u.includes('pypi.org/pypi/litert-lm/json')),
      `the fallback must query PyPI itself (fetched: ${urls.join(', ')})`,
    )
  } finally {
    globalThis.fetch = origFetch
  }
})

// ── the install/upgrade provision must stop a RUNNING LiteRT-LM first (PR #271 follow-up):
// --reinstall (the plain install) and -U (a real version bump) both rewrite litert_lm's
// files, and Windows cannot overwrite a DLL that a running process has loaded — the
// provision would die mid-rewrite. applyPipUpdate (the auto-update path) stops first; this
// route is the same operation and must not be the one hole. The card never offers Install
// over a registered engine, but Update is one click away while it runs, and the API is
// callable directly either way. (The guard keyed on the registry's active engine when PR #275
// opened; main's v1.14.5 refined it to key on what is RUNNING — the stricter rule — and these
// tests were carried over to it.) ──

test('an upgrade (?update=1, newer release) stops the RUNNING LiteRT-LM engine before re-provisioning', async () => {
  const { app, managerCalls } = appWithChecker(async () => '0.18.0')
  const res = await app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(res.status, 202)
  // The provision body runs synchronously up to its first await (stopAndWait) before the
  // 202 goes out — see the "genuinely newer release" test above — so the stop is already
  // recorded by response time, structurally BEFORE ensureLitertLmEnv's first statement.
  assert.deepEqual(managerCalls, ['stopAndWait'], 'the running engine must be stopped before the venv is rewritten')
})

test('a plain install also stops the RUNNING LiteRT-LM engine (--reinstall rewrites the same files)', async () => {
  const { app, managerCalls } = appWithChecker(async () => '0.17.1')
  const res = await app.request('/api/v1/engines/litert-lm', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.deepEqual(managerCalls, ['stopAndWait'])
})

test('nothing is stopped when nothing is running, or when a DIFFERENT engine is the one running', async () => {
  const none = appWithChecker(async () => '0.17.1', '0.17.1', { activeEngineId: null, runningKind: null })
  const r1 = await none.app.request('/api/v1/engines/litert-lm', { method: 'POST' })
  assert.equal(r1.status, 202)
  assert.deepEqual(none.managerCalls, [], 'a first install has nothing running to stop')

  // ?update=1 with a genuinely newer release, so the route actually reaches the provision
  // body (a same-version answer would honestly refuse with 200 before any stop could matter).
  const other = appWithChecker(async () => '0.18.0', '0.17.1', { activeEngineId: 'other-1', runningKind: 'llama-server' })
  const r2 = await other.app.request('/api/v1/engines/litert-lm?update=1', { method: 'POST' })
  assert.equal(r2.status, 202)
  assert.deepEqual(other.managerCalls, [], 'a running non-LiteRT-LM engine must not be stopped')
})

// ── An update keeps the active engine, as the scheduler's applyPipUpdate does: the route behind the card's Update
// button made LiteRT-LM the active engine whatever was active before, and an active LiteRT-LM is sent every GGUF —
// so updating it on a llama.cpp desktop broke every GGUF load. An install still activates it. The provision runs
// for real here, offline, against a fake uv and venv python (shell scripts). ──
test('?update=1 leaves another active engine active; an update of the active LiteRT-LM and an install activate it', async (t) => {
  if (process.platform === 'win32') return t.skip('fakes uv and the venv python with shell scripts')
  const storeDir = tmpDir('tllm-litert-activate-')
  const engines = join(storeDir, 'engines')
  mkdirSync(join(engines, 'uv'), { recursive: true })
  writeFileSync(join(engines, 'uv', 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  mkdirSync(join(engines, 'litert-lm', 'venv', 'bin'), { recursive: true })
  writeFileSync(join(engines, 'litert-lm', 'venv', 'bin', 'python'), '#!/bin/sh\necho 0.18.0\n', { mode: 0o755 })
  const provision = async (query: string, activeEngineId: string) => {
    const h = appWithChecker(async () => '0.18.0', '0.17.1', { activeEngineId, runningKind: null, storeDir })
    const res = await h.app.request(`/api/v1/engines/litert-lm${query}`, { method: 'POST' })
    assert.equal(res.status, 202)
    for (let i = 0; i < 1000 && !h.provisionCalls.some((c) => c === 'done' || c.startsWith('fail:')); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.deepEqual(h.provisionCalls, ['start:litert-lm', 'done'])
    return h.activateCalls
  }
  assert.deepEqual(await provision('?update=1', 'other-1'), [], 'an update must not make LiteRT-LM the active engine')
  assert.deepEqual(await provision('?update=1', 'litert-1'), ['litert-2'])
  assert.deepEqual(await provision('', 'other-1'), ['litert-2'], 'an install activates it')
})
