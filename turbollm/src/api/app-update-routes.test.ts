// Route-level tests for the app self-update endpoints (spec 29 B.1/B.4), on a real Hono
// app with a minimal Deps double — the same "real app, minimal Deps" discipline as
// keys-network.test.ts, because what is under test here is the REFUSAL logic, and a refusal
// only exists at the route.
//
// The happy path is deliberately absent: a successful POST spawns a detached process and
// then exits the daemon. Asserting that would mean either killing the test runner or
// mocking away the entire mechanism, and the machine running this suite may be running the
// founder's own TurboLLM with live Code sessions in it. What IS asserted is everything that
// must happen BEFORE the point of no return — because a wrongly-permitted update is the
// failure that destroys work, and a wrongly-refused one merely annoys.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { AppUpdateProgressState } from '../app-update-apply'

interface Doubles {
  /** Downloads the manager reports as live. */
  downloads?: { status: string }[]
  buildActive?: boolean
  provisionActive?: boolean
  codeActive?: boolean
  managerState?: string
  /** The app-update checker's cached answer; undefined = no checker wired. */
  update?: { installed: string; latest: string | null; hasUpdate: boolean; checkedAt: string; comparable: boolean }
  policy?: string
  dismissedVersion?: string
  /** Omit to assert the "not restartable" 501. */
  restartable?: boolean
}

function fakeApp(o: Doubles = {}) {
  const cfg = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996 },
    apiKeys: [],
    appUpdate: { policy: o.policy ?? 'notify', dismissedVersion: o.dismissedVersion ?? '' },
  }
  const restarts: { exitOnly?: boolean }[] = []
  const app = new Hono()
  const d = {
    version: '1.12.7',
    store: {
      dir: () => '/tmp/turbollm-test',
      snapshot: () => cfg,
      update: (fn: (c: typeof cfg) => void) => fn(cfg),
    },
    manager: { status: () => ({ state: o.managerState ?? 'stopped', model: null }) },
    downloads: { list: () => o.downloads ?? [] },
    build: { isActive: () => o.buildActive ?? false },
    provision: { get: () => ({ active: o.provisionActive ?? false }) },
    codeRuns: { anyActive: () => o.codeActive ?? false },
    appUpdates: o.update ? { get: () => o.update, isStale: () => false, check: async () => o.update } : undefined,
    appUpdateProgress: new AppUpdateProgressState(),
    ...(o.restartable === false ? {} : { requestRestart: (opts?: { exitOnly?: boolean }) => restarts.push(opts ?? {}) }),
  } as unknown as Deps
  registerApi(app, d)
  return { app, cfg, restarts, d }
}

const AVAILABLE = { installed: '1.12.7', latest: '1.12.8', hasUpdate: true, checkedAt: '2026-09-09T00:00:00.000Z', comparable: true }

// ─── GET /api/v1/app/update ───────────────────────────────────────────────────

test('GET /api/v1/app/update: reports the install method and policy alongside the version check', async () => {
  const { app } = fakeApp({ update: AVAILABLE })
  const body = (await (await app.request('/api/v1/app/update')).json()) as Record<string, unknown>
  assert.equal(body.latest, '1.12.8')
  assert.equal(body.policy, 'notify')
  assert.ok(typeof body.method === 'string', 'the UI needs the method to know what to offer')
  assert.ok(typeof body.command === 'string' && (body.command as string).length > 0, 'never a dead end')
})

test("GET /api/v1/app/update: policy 'off' reports no update at all", async () => {
  // Suppressed by reporting hasUpdate:false rather than by omitting a field, so the UI
  // needs no second rule for the off case — the pill, the toast and the Settings block all
  // already key off hasUpdate.
  const { app } = fakeApp({ update: AVAILABLE, policy: 'off' })
  const body = (await (await app.request('/api/v1/app/update')).json()) as Record<string, unknown>
  assert.equal(body.hasUpdate, false)
  assert.equal(body.policy, 'off')
})

test('GET /api/v1/app/update: an unrecognised stored policy reads as notify, never as a broken value', async () => {
  const { app } = fakeApp({ update: AVAILABLE, policy: 'sometimes-maybe' })
  const body = (await (await app.request('/api/v1/app/update')).json()) as Record<string, unknown>
  assert.equal(body.policy, 'notify')
})

// ─── POST /api/v1/app/update (the refusals) ───────────────────────────────────

test('POST /api/v1/app/update: 409 when there is no newer version to install', async () => {
  const { app } = fakeApp({ update: { ...AVAILABLE, hasUpdate: false } })
  const res = await app.request('/api/v1/app/update', { method: 'POST' })
  assert.equal(res.status, 409)
  const body = (await res.json()) as { error?: { code?: string } }
  // The install-method refusal can legitimately win first in whatever environment the
  // suite runs in; either way it must be a 409 with a reason, never a started update.
  assert.ok(['no_update', 'update_not_supported'].includes(body.error?.code ?? ''))
})

test('POST /api/v1/app/update: 501 rather than a silent no-op when the daemon cannot restart', async () => {
  const { app } = fakeApp({ update: AVAILABLE, restartable: false })
  const res = await app.request('/api/v1/app/update', { method: 'POST' })
  assert.equal(res.status, 501)
})

test('POST /api/v1/app/update: an in-flight download blocks, and nothing is restarted', async () => {
  // The standing rule (ADR-240): a hard kill mid-write can CORRUPT a download rather than
  // pause it. This is the route-level half of it.
  const { app, restarts } = fakeApp({ update: AVAILABLE, downloads: [{ status: 'downloading' }] })
  const res = await app.request('/api/v1/app/update', { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal(restarts.length, 0, 'a blocked update must never have touched the daemon')
})

test('POST /api/v1/app/update: a running Code session blocks', async () => {
  const { app, restarts } = fakeApp({ update: AVAILABLE, codeActive: true })
  const res = await app.request('/api/v1/app/update', { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal(restarts.length, 0)
})

test('POST /api/v1/app/update: an engine build blocks', async () => {
  const { app, restarts } = fakeApp({ update: AVAILABLE, buildActive: true })
  assert.equal((await app.request('/api/v1/app/update', { method: 'POST' })).status, 409)
  assert.equal(restarts.length, 0)
})

test('POST /api/v1/app/update: a model mid-load blocks', async () => {
  const { app, restarts } = fakeApp({ update: AVAILABLE, managerState: 'starting' })
  assert.equal((await app.request('/api/v1/app/update', { method: 'POST' })).status, 409)
  assert.equal(restarts.length, 0)
})

test('POST /api/v1/app/update: a second request while one is running is refused', async () => {
  const { app, d } = fakeApp({ update: AVAILABLE })
  d.appUpdateProgress!.set('installing', { target: '1.12.8' })
  const res = await app.request('/api/v1/app/update', { method: 'POST' })
  assert.equal(res.status, 409)
})

// ─── progress / policy / dismiss ──────────────────────────────────────────────

test('GET /api/v1/app/update/progress: idle by default, and reflects a set state', async () => {
  const { app, d } = fakeApp()
  let body = (await (await app.request('/api/v1/app/update/progress')).json()) as { state: string }
  assert.equal(body.state, 'idle')
  d.appUpdateProgress!.set('restarting', { target: '1.12.8' })
  body = (await (await app.request('/api/v1/app/update/progress')).json()) as { state: string }
  assert.equal(body.state, 'restarting')
})

test('PUT /api/v1/app/update-policy: persists a valid policy and rejects anything else', async () => {
  const { app, cfg } = fakeApp()
  assert.equal((await app.request('/api/v1/app/update-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: 'auto' }) })).status, 200)
  assert.equal(cfg.appUpdate.policy, 'auto')

  const bad = await app.request('/api/v1/app/update-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: 'yes please' }) })
  assert.equal(bad.status, 400)
  assert.equal(cfg.appUpdate.policy, 'auto', 'a rejected patch must not have written anything')
})

test('POST /api/v1/app/update/dismiss: remembers the version so the toast never nags twice', async () => {
  const { app, cfg } = fakeApp({ update: AVAILABLE })
  const res = await app.request('/api/v1/app/update/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '1.12.8' }) })
  assert.equal(res.status, 200)
  assert.equal(cfg.appUpdate.dismissedVersion, '1.12.8')
  const body = (await (await app.request('/api/v1/app/update')).json()) as { dismissedVersion?: string }
  assert.equal(body.dismissedVersion, '1.12.8')
})
