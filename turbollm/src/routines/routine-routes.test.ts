import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { registerRoutineRoutes, CODE_GATE_MESSAGE } from './routine-routes'
import { RoutineScheduler } from './scheduler'
import { executeRoutine } from './execute'
import type { Deps } from '../deps'
import type { Manager } from '../engines/manager'
import type { ModelRouter } from '../gateway/model-router'
import type { GenerationGate } from '../agents/gate'

const RAW_KEY = 'tllm-TestKeyTestKeyTestKeyTestKeyTestKey1'
const RAW_KEY_HASH = createHash('sha256').update(RAW_KEY).digest('hex')

/** M1: the invariant that actually matters for the double-fire fix (mirrors scheduler.test.ts's
 *  own copy) — not fire-counts or skip-row-counts alone, but "at most one row is ever 'running'
 *  for a given routine at once." */
function assertAtMostOneRunning(db: ConversationStore, routineId: string, message?: string): void {
  const runningCount = db.listRoutineRuns(routineId).filter((run) => run.status === 'running').length
  assert.ok(runningCount <= 1, message ?? `expected at most one 'running' row for routine ${routineId}, found ${runningCount}`)
}

/** `lanBind` drives isLocalRequest (the code-flavor gate, I4): false = loopback-only bind,
 *  which is always "local to the host", so the gate is a no-op — the default every
 *  pre-existing test here relies on. Set it true to simulate a LAN-exposed daemon, where a
 *  code-flavor routine must present a key. `hasKey` seeds RAW_KEY as a valid stored key. */
function testApp(opts: { lanBind?: boolean; hasKey?: boolean; routinesEnabled?: boolean } = {}): { app: Hono; db: ConversationStore } {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const apiKeys = opts.hasKey
    ? [{ id: 'k1', name: 'test', hash: RAW_KEY_HASH, prefix: RAW_KEY.slice(0, 12), createdAt: '', lastUsedAt: null }]
    : []
  // routine-routes.ts reads d.db plus (for the code-flavor gate) d.store/d.tunnel via
  // auth.ts — safe to stub the rest of Deps for this route-level test. `scanner` backs POST's
  // modelKey-exists check — every 'm'/'qwen3-coder-32b' fixture in this file needs to be a real
  // "model" here, or every create/update test would 400 on a check unrelated to what it's testing.
  // `experimental.routines` defaults to true here (unlike production's off-by-default) so every
  // pre-existing test in this file, which is exercising CRUD/scheduling behavior rather than the
  // experimental gate itself, keeps working unchanged — the gate's own off-by-default behavior is
  // covered by a dedicated test that passes `routinesEnabled: false` explicitly.
  const d = {
    db,
    store: {
      snapshot: () => ({
        daemon: { lanBind: opts.lanBind ?? false, requireApiKey: false, experimental: { routines: opts.routinesEnabled ?? true } },
        apiKeys,
      }),
      update: (fn: (cfg: { apiKeys: typeof apiKeys }) => void) => fn({ apiKeys }),
    },
    scanner: { list: () => ({ models: [{ key: 'm', name: 'm' }, { key: 'qwen3-coder-32b', name: 'qwen3-coder-32b' }] }) },
  } as unknown as Deps
  registerRoutineRoutes(app, d)
  return { app, db }
}

const CODE_ROUTINE = {
  flavor: 'code', prompt: 'x', scheduleDisplay: 'd',
  scheduleRule: { kind: 'interval', everyMs: 60_000 },
  modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
} as const

test('POST /api/v1/routines creates a pending_confirmation routine', async () => {
  const { app } = testApp()
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flavor: 'chat', prompt: 'Summarize my inbox', scheduleDisplay: 'Runs daily at 9:00 AM',
      scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'qwen3-coder-32b', agentId: 'agent-1',
    }),
  })
  assert.equal(res.status, 201)
  const created = (await res.json()) as { status: string }
  assert.equal(created.status, 'pending_confirmation')
})

// Routines is experimental, off by default (daemon.experimental.routines, config.ts) — this is
// the REST-layer half of "hidden UI + can't be created from chat or code". Checked FIRST, before
// even the code-flavor gate, so a disabled feature refuses a chat-flavor routine too, not just
// code-flavor ones.
test('POST /api/v1/routines refuses to create anything while experimental.routines is off', async () => {
  const { app, db } = testApp({ routinesEnabled: false })
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flavor: 'chat', prompt: 'Summarize my inbox', scheduleDisplay: 'Runs daily at 9:00 AM',
      scheduleRule: { kind: 'daily', hour: 9, minute: 0 }, modelKey: 'qwen3-coder-32b', agentId: 'agent-1',
    }),
  })
  assert.equal(res.status, 403)
  const problem = (await res.json()) as { error: { code: string } }
  assert.equal(problem.error.code, 'routines_disabled')
  assert.equal(db.listRoutines().length, 0, 'nothing should have been created')
})

test('POST /api/v1/routines rejects a code-flavor routine missing workspacePath', async () => {
  const { app } = testApp()
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', codingAgent: 'pi' }),
  })
  assert.equal(res.status, 400)
  const problem = (await res.json()) as { error: { code: string } }
  assert.equal(problem.error.code, 'invalid_routine')
})

// A claude_cli session with no way to discover a real modelKey once created a routine with
// modelKey: "gpt-4" — a real cloud model name, not anything in the library — which could never
// fire successfully. This is the server-side backstop: reject it at create time instead.
test('POST /api/v1/routines rejects a modelKey that is not in the real model library', async () => {
  const { app } = testApp()
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
      modelKey: 'gpt-4', agentId: 'agent-1',
    }),
  })
  assert.equal(res.status, 400)
  const problem = (await res.json()) as { error: { code: string; message: string } }
  assert.equal(problem.error.code, 'invalid_routine')
  assert.match(problem.error.message, /not a model in TurboLLM's library/)
  assert.match(problem.error.message, /list_models/)
})

test('POST /api/v1/routines accepts a modelKey that IS in the real model library', async () => {
  const { app } = testApp()
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 },
      modelKey: 'm', agentId: 'agent-1',
    }),
  })
  assert.equal(res.status, 201)
})

test('PUT /api/v1/routines/:id/confirm activates a pending routine and sets next_fire_at', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}/confirm`, { method: 'PUT' })
  assert.equal(res.status, 200)
  const confirmed = (await res.json()) as { status: string; nextFireAt: string | null }
  assert.equal(confirmed.status, 'active')
  assert.ok(confirmed.nextFireAt)
})

test('PUT /api/v1/routines/:id/confirm on an already-active routine returns 409', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(created.id, new Date().toISOString())
  const res = await app.request(`/api/v1/routines/${created.id}/confirm`, { method: 'PUT' })
  assert.equal(res.status, 409)
})

test('DELETE /api/v1/routines/:id removes the routine', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal(db.getRoutine(created.id), null)
})

test('GET /api/v1/routines/:id/runs returns run history newest first', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  db.createRoutineRun({ routineId: created.id, configSnapshot: '{}' })
  const res = await app.request(`/api/v1/routines/${created.id}/runs`)
  assert.equal(res.status, 200)
  const runs = (await res.json()) as unknown[]
  assert.equal(runs.length, 1)
})

// ── Code-flavor auth gate (I4) ────────────────────────────────────────────────
// A flavor:'code' routine schedules the same host-filesystem code execution that
// /api/v1/code/* gates behind codeAuth, just unattended and on a timer, so the
// create/update endpoints apply codeAuth's own decision inline for that flavor.
// Chat routines stay on the baseline lanAuth gate only.

test('POST of a code routine from a non-host device with no key is rejected', async () => {
  const { app, db } = testApp({ lanBind: true })
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CODE_ROUTINE),
  })
  assert.equal(res.status, 401)
  assert.equal(await errorCode(res), 'unauthorized')
  assert.equal(db.listRoutines().length, 0)
})

test('POST of a chat routine from the same non-host device is NOT gated', async () => {
  const { app } = testApp({ lanBind: true })
  const res = await post(app, {})
  assert.equal(res.status, 201)
})

test('POST of a code routine from a non-host device WITH a valid key succeeds', async () => {
  const { app } = testApp({ lanBind: true, hasKey: true })
  const res = await app.request('/api/v1/routines', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-TurboLLM-Auth': RAW_KEY },
    body: JSON.stringify(CODE_ROUTINE),
  })
  assert.equal(res.status, 201)
})

test('POST of a code routine from the host (loopback-only bind) needs no key', async () => {
  const { app } = testApp()
  const res = await app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CODE_ROUTINE),
  })
  assert.equal(res.status, 201)
})

test('PUT on an existing code routine from a non-host device with no key is rejected', async () => {
  const { app, db } = testApp({ lanBind: true })
  const created = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
  })
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'exfiltrate everything' }),
  })
  assert.equal(res.status, 401)
  assert.equal(db.getRoutine(created.id)?.prompt, 'x')
})

test('PUT on a chat routine from the same non-host device is NOT gated', async () => {
  const { app, db } = testApp({ lanBind: true })
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'new' }),
  })
  assert.equal(res.status, 200)
  assert.equal(db.getRoutine(created.id)?.prompt, 'new')
})

// ── Request validation (I1) ───────────────────────────────────────────────────
// scheduleRule used to be truthiness-checked only, so client JSON reached
// computeNextFireTime unvalidated: a bad `kind` threw RangeError out of /confirm
// (a 500, breaking the error-envelope convention) and everyMs <= 0 produced a
// routine that is permanently due and fires on every tick forever.

async function post(app: Hono, patch: Record<string, unknown>): Promise<Response> {
  return app.request('/api/v1/routines', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flavor: 'chat', prompt: 'x', scheduleDisplay: 'd',
      scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a',
      ...patch,
    }),
  })
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code
}

test('POST rejects an unrecognised scheduleRule.kind with 400, not a later 500', async () => {
  const { app } = testApp()
  const res = await post(app, { scheduleRule: { kind: 'not-a-kind' } })
  assert.equal(res.status, 400)
  assert.equal(await errorCode(res), 'invalid_routine')
})

test('POST rejects everyMs of 0 or negative (would make the routine permanently due)', async () => {
  const { app } = testApp()
  for (const everyMs of [0, -600_000]) {
    const res = await post(app, { scheduleRule: { kind: 'interval', everyMs } })
    assert.equal(res.status, 400, `everyMs: ${everyMs}`)
    assert.equal(await errorCode(res), 'invalid_routine')
  }
})

test('POST rejects a non-numeric everyMs', async () => {
  const { app } = testApp()
  const res = await post(app, { scheduleRule: { kind: 'interval', everyMs: 'soon' } })
  assert.equal(res.status, 400)
})

test('POST rejects out-of-range daily hour/minute', async () => {
  const { app } = testApp()
  assert.equal((await post(app, { scheduleRule: { kind: 'daily', hour: 99, minute: 0 } })).status, 400)
  assert.equal((await post(app, { scheduleRule: { kind: 'daily', hour: 9, minute: 60 } })).status, 400)
  assert.equal((await post(app, { scheduleRule: { kind: 'daily', hour: -1, minute: 0 } })).status, 400)
})

test('POST rejects an empty or out-of-range weekly daysOfWeek', async () => {
  const { app } = testApp()
  assert.equal((await post(app, { scheduleRule: { kind: 'weekly', daysOfWeek: [], hour: 9, minute: 0 } })).status, 400)
  assert.equal((await post(app, { scheduleRule: { kind: 'weekly', daysOfWeek: [9], hour: 9, minute: 0 } })).status, 400)
})

test('POST accepts a well-formed weekly rule', async () => {
  const { app } = testApp()
  const res = await post(app, { scheduleRule: { kind: 'weekly', daysOfWeek: [1, 3, 5], hour: 9, minute: 30 } })
  assert.equal(res.status, 201)
})

test('POST rejects an unrecognised permissionMode', async () => {
  const { app } = testApp()
  const res = await post(app, { permissionMode: 'yolo' })
  assert.equal(res.status, 400)
  assert.equal(await errorCode(res), 'invalid_routine')
})

test('POST rejects an unrecognised codingAgent on a chat routine too', async () => {
  const { app } = testApp()
  const res = await post(app, { codingAgent: 'rm -rf /' })
  assert.equal(res.status, 400)
})

test('PUT rejects a malformed scheduleRule instead of persisting it', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheduleRule: { kind: 'interval', everyMs: 0 } }),
  })
  assert.equal(res.status, 400)
  assert.equal(await errorCode(res), 'invalid_routine')
  assert.deepEqual(db.getRoutine(created.id)?.scheduleRule, { kind: 'interval', everyMs: 60_000 })
})

test('PUT rejects junk permissionMode/codingAgent instead of persisting them verbatim', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi', permissionMode: 'ask',
  })
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath: '', codingAgent: 'rm -rf /', permissionMode: 'yolo' }),
  })
  assert.equal(res.status, 400)
  const after = db.getRoutine(created.id)
  assert.equal(after?.permissionMode, 'ask')
  assert.equal(after?.codingAgent, 'pi')
  assert.equal(after?.workspacePath, 'D:/repo')
})

test('PUT rejects blanking workspacePath on a code-flavor routine', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
  })
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspacePath: '   ' }),
  })
  assert.equal(res.status, 400)
  assert.equal(db.getRoutine(created.id)?.workspacePath, 'D:/repo')
})

// ── PUT /:id conditional nextFireAt recompute (I5) ────────────────────────────

test('PUT /:id recomputes nextFireAt when the routine is active', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(created.id, '2020-01-01T00:00:00.000Z')
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheduleRule: { kind: 'interval', everyMs: 3_600_000 } }),
  })
  assert.equal(res.status, 200)
  const updated = (await res.json()) as { nextFireAt: string | null }
  assert.ok(updated.nextFireAt)
  assert.notEqual(updated.nextFireAt, '2020-01-01T00:00:00.000Z')
  assert.ok(new Date(updated.nextFireAt!).getTime() > Date.now())
})

test('PUT /:id leaves nextFireAt null when the routine is still pending_confirmation', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheduleRule: { kind: 'interval', everyMs: 3_600_000 } }),
  })
  assert.equal(res.status, 200)
  const updated = (await res.json()) as { status: string; nextFireAt: string | null }
  assert.equal(updated.status, 'pending_confirmation')
  assert.equal(updated.nextFireAt, null)
})

// ── The confirm gate (C1) ─────────────────────────────────────────────────────
// pause/resume are the two endpoints that can move a routine INTO 'active'
// without going through /confirm, so both directions get a regression test.

test('PUT /api/v1/routines/:id/pause on a pending_confirmation routine returns 409', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}/pause`, { method: 'PUT' })
  assert.equal(res.status, 409)
  const problem = (await res.json()) as { error: { code: string } }
  assert.equal(problem.error.code, 'not_active')
  assert.equal(db.getRoutine(created.id)?.status, 'pending_confirmation')
})

test('pause then resume cannot activate a routine that was never confirmed', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  await app.request(`/api/v1/routines/${created.id}/pause`, { method: 'PUT' })
  const resumed = await app.request(`/api/v1/routines/${created.id}/resume`, { method: 'PUT' })
  assert.equal(resumed.status, 409)
  const after = db.getRoutine(created.id)
  assert.notEqual(after?.status, 'active')
  assert.equal(after?.status, 'pending_confirmation')
  assert.equal(after?.nextFireAt, null)
})

test('PUT /api/v1/routines/:id/pause on an active routine still succeeds and clears nextFireAt', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(created.id, new Date().toISOString())
  const res = await app.request(`/api/v1/routines/${created.id}/pause`, { method: 'PUT' })
  assert.equal(res.status, 200)
  const paused = (await res.json()) as { status: string; nextFireAt: string | null }
  assert.equal(paused.status, 'paused')
  assert.equal(paused.nextFireAt, null)
})

// ── run-now / approve / deny (Task 9) ─────────────────────────────────────────

test('POST /api/v1/routines/:id/run-now fires immediately via the shared scheduler', async () => {
  const { db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(created.id, '2099-01-01T00:00:00.000Z')
  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async (r) => { fired.push(r.id); return 'ok' } })
  const app2 = new Hono()
  registerRoutineRoutes(app2, { db, routineScheduler: scheduler, store: { snapshot: () => ({ daemon: { experimental: { routines: true } } }) } } as unknown as Deps)

  const res = await app2.request(`/api/v1/routines/${created.id}/run-now`, { method: 'POST' })
  assert.equal(res.status, 202)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fired, [created.id])
})

test('POST /api/v1/routines/:id/run-now on a pending_confirmation routine returns 409', async () => {
  const { db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async () => 'ok' })
  const app2 = new Hono()
  registerRoutineRoutes(app2, { db, routineScheduler: scheduler, store: { snapshot: () => ({ daemon: { experimental: { routines: true } } }) } } as unknown as Deps)
  const res = await app2.request(`/api/v1/routines/${created.id}/run-now`, { method: 'POST' })
  assert.equal(res.status, 409)
})

// Kill switch: matches POST /api/v1/routines' own experimental-flag check, but for a routine
// that was already armed BEFORE the flag was turned off — the scenario the create-time gate
// alone does nothing for.
test('POST /api/v1/routines/:id/run-now refuses to trigger an already-armed routine while experimental.routines is off', async () => {
  const { db } = testApp({ routinesEnabled: false })
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(created.id, '2099-01-01T00:00:00.000Z')
  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async (r) => { fired.push(r.id); return 'ok' } })
  const app2 = new Hono()
  registerRoutineRoutes(app2, { db, routineScheduler: scheduler, store: { snapshot: () => ({ daemon: { experimental: { routines: false } } }) } } as unknown as Deps)
  const res = await app2.request(`/api/v1/routines/${created.id}/run-now`, { method: 'POST' })
  assert.equal(res.status, 403)
  const problem = (await res.json()) as { error: { code: string } }
  assert.equal(problem.error.code, 'routines_disabled')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fired, [], 'nothing should have run')
})

test('POST /api/v1/routines/:id/run-now returns 503 when no scheduler is wired', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(created.id, new Date().toISOString())
  const res = await app.request(`/api/v1/routines/${created.id}/run-now`, { method: 'POST' })
  assert.equal(res.status, 503)
})

test('POST /api/v1/routines/:id/run-now on an unknown routine returns 404', async () => {
  const { db } = testApp()
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async () => 'ok' })
  const app2 = new Hono()
  registerRoutineRoutes(app2, { db, routineScheduler: scheduler, store: { snapshot: () => ({ daemon: { experimental: { routines: true } } }) } } as unknown as Deps)
  const res = await app2.request('/api/v1/routines/missing/run-now', { method: 'POST' })
  assert.equal(res.status, 404)
})

test('POST .../runs/:runId/approve on a run that is not needs_approval returns 409', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const run = db.createRoutineRun({ routineId: created.id, configSnapshot: JSON.stringify(created) })
  db.updateRoutineRun(run.id, { status: 'ok' })
  const res = await app.request(`/api/v1/routines/${created.id}/runs/${run.id}/approve`, { method: 'POST' })
  assert.equal(res.status, 409)
})

test('POST .../runs/:runId/deny on an unknown run returns 404', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${created.id}/runs/missing-run/deny`, { method: 'POST' })
  assert.equal(res.status, 404)
})

test('POST .../runs/:runId/approve on a run for a DIFFERENT routine returns 404 (id/runId must match)', async () => {
  const { app, db } = testApp()
  const created = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const otherRoutine = db.createRoutine({ flavor: 'chat', prompt: 'y', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  const run = db.createRoutineRun({ routineId: otherRoutine.id, configSnapshot: JSON.stringify(otherRoutine) })
  const res = await app.request(`/api/v1/routines/${created.id}/runs/${run.id}/approve`, { method: 'POST' })
  assert.equal(res.status, 404)
})

// ── approve/deny release the scheduler's parked-routine guard (Task 9's double-fire fix) ──
// scheduler.ts keeps a routine parked (in its `inFlight` set) once a fire resolves to
// 'needs_approval', so a tick can't fire it again while parked. Only these two routes ever
// resolve that stall (resumeRoutineRun is never called from the scheduler's own tick path), so
// they are the only place that can release the guard — proven end-to-end here via the real
// scheduler, not just by unit-testing releaseParked() in isolation.
//
// The stub `runRoutine` below parks the run WITHOUT a real pendingToolCall (unlike the actual
// chat/code runners), so `resumeRoutineRun` itself fails with 'corrupt_pending_call' — a
// PERMANENT failure (no future approve/deny could ever parse that pendingToolCall either), which
// is exactly the case routine-routes.ts's `releaseParkedIfResolved` must still release, per the
// task brief's "even a denied/failed resume must release the parked slot, or the routine would
// be stuck unable to ever fire again."

test('approve releases the scheduler-parked routine once resumeRoutineRun settles, even on failure', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(routine.id, '2020-01-01T00:00:00.000Z')
  const fired: string[] = []
  const scheduler = new RoutineScheduler({
    store: db, now: () => new Date(),
    runRoutine: async (r) => { fired.push(r.id); return 'needs_approval' },
  })
  registerRoutineRoutes(app, { db, routineScheduler: scheduler } as unknown as Deps)

  await scheduler.tick() // fires and parks — inFlight now holds the routine
  await new Promise((resolve) => setImmediate(resolve))
  const [run] = db.listRoutineRuns(routine.id)
  assert.equal(run.status, 'needs_approval')
  assert.deepEqual(fired, [routine.id])

  // A second tick must not be able to fire it again while parked.
  await scheduler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fired, [routine.id], 'still parked — no second fire')
  assert.equal(db.listRoutineRuns(routine.id).filter((x) => x.skipReason === 'overlap').length, 1)

  // /approve: resumeRoutineRun itself fails (this stub run has no parseable pendingToolCall),
  // but the parked slot must still be released — this run can never be un-stalled either way.
  const res = await app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/approve`, { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'corrupt_pending_call')
  // M2(c): the run itself must land in a REAL terminal state, not stay stuck at 'needs_approval'
  // forever — otherwise every retry would re-trigger the exact same corrupt_pending_call path
  // indefinitely, and the run would misrepresent itself as still-actionable in run history/UI.
  const resolvedRun = db.getRoutineRun(run.id)!
  assert.equal(resolvedRun.status, 'errored')
  assert.ok(resolvedRun.endedAt)

  // Prove the release actually happened: winding next_fire_at back into the past and ticking
  // again (on the SAME scheduler instance the route released) must fire it, with no new overlap.
  db.updateRoutine(routine.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
  await scheduler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fired, [routine.id, routine.id], 'the routine fires again after being released by /approve')
  assert.equal(db.listRoutineRuns(routine.id).filter((x) => x.skipReason === 'overlap').length, 1, 'no NEW overlap row from this fire')
  assertAtMostOneRunning(db, routine.id)
})

test('approve does NOT release the parked guard on a retryable resume failure (gate_timeout)', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  db.confirmRoutine(routine.id, '2020-01-01T00:00:00.000Z')

  // Real execution Deps (mirrors execute.test.ts's fakeDeps) so the routine genuinely stalls
  // through the real chat-runner with a parseable pendingToolCall, not a stub shortcut.
  const manager = {
    status: () => ({ state: 'running', model: { key: 'm' } }),
    sessionStats: () => ({ activeRequests: 0 }),
    target: () => 'http://engine.invalid.local:1',
    currentOpts: () => null,
  } as unknown as Manager
  const modelRouter = { loadExplicit: async () => ({ target: 'http://x' }) } as unknown as ModelRouter
  const AGENT = { id: 'agent-1', name: 'A', description: '', systemPrompt: '', skillIds: [], tools: [] as string[] }
  let gateShouldTimeOut = false
  const gate = {
    acquire: async () => {
      if (gateShouldTimeOut) throw new Error('gate acquire timed out')
      return () => {}
    },
  } as unknown as GenerationGate
  const d = {
    db, manager, modelRouter, gate,
    registry: { active: () => ({ kind: 'llama-server' }) },
    store: { snapshot: () => ({ customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }) },
  } as unknown as Deps

  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: (r, run) => executeRoutine(d, r, run) })
  registerRoutineRoutes(app, { ...d, routineScheduler: scheduler } as unknown as Deps)

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'not_allowed_tool', arguments: '{}' } }] } }],
  }), { status: 200 })) as typeof fetch
  try {
    await scheduler.tick() // fires and stalls for real — inFlight now holds the routine
    await new Promise((resolve) => setImmediate(resolve))
  } finally { globalThis.fetch = originalFetch }
  const [run] = db.listRoutineRuns(routine.id)
  assert.equal(run.status, 'needs_approval')

  // Force the gate to time out on this specific resume attempt.
  gateShouldTimeOut = true
  const res = await app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/approve`, { method: 'POST' })
  assert.equal(res.status, 409)
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'gate_timeout')
  assert.equal(db.getRoutineRun(run.id)?.status, 'needs_approval', 'claim reverted — legitimately retryable, not released')

  // Prove the scheduler's guard is STILL in place: a tick must not be able to fire the routine
  // again while this run sits there awaiting a retry of the SAME decision.
  await scheduler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(db.listRoutineRuns(routine.id).filter((x) => x.skipReason === 'overlap').length, 1, 'still guarded — a retryable failure must not release the parked slot')
})

// ── I2: run-now/approve/deny must honor the same code-flavor auth gate as create/update ────
// codeGateBlocks' own doc comment used to flag this as "an open decision for whoever ships
// Phase 2's execution" — run-now triggers real bash/edit/write on demand, and approve executes
// a tool call the approval gate deliberately blocked, so both are strictly worse than the
// already-gated create/update case if left ungated.

test('POST /api/v1/routines/:id/run-now on a code routine from a non-host device with no key is rejected (I2)', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const apiKeys: unknown[] = []
  const d = {
    db,
    store: {
      snapshot: () => ({ daemon: { lanBind: true, requireApiKey: false, experimental: { routines: true } }, apiKeys }),
      update: (fn: (cfg: { apiKeys: typeof apiKeys }) => void) => fn({ apiKeys }),
    },
  } as unknown as Deps
  const routine = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
  })
  db.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async () => 'ok' })
  registerRoutineRoutes(app, { ...d, routineScheduler: scheduler } as unknown as Deps)
  const res = await app.request(`/api/v1/routines/${routine.id}/run-now`, { method: 'POST' })
  assert.equal(res.status, 401)
})

test('POST /api/v1/routines/:id/run-now on a code routine from the host (loopback-only bind) needs no key (I2)', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const d = { db, store: { snapshot: () => ({ daemon: { lanBind: false, requireApiKey: false, experimental: { routines: true } }, apiKeys: [] }) } } as unknown as Deps
  const routine = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
  })
  db.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async (r) => { fired.push(r.id); return 'ok' } })
  registerRoutineRoutes(app, { ...d, routineScheduler: scheduler } as unknown as Deps)
  const res = await app.request(`/api/v1/routines/${routine.id}/run-now`, { method: 'POST' })
  assert.equal(res.status, 202)
})

test('POST .../runs/:runId/approve on a code routine from a non-host device with no key is rejected (I2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
  })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  db.updateRoutineRun(run.id, { status: 'needs_approval' })
  const res = await app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/approve`, { method: 'POST' })
  assert.equal(res.status, 401)
  // Gated before resumeRoutineRun ever ran — the run must be untouched.
  assert.equal(db.getRoutineRun(run.id)?.status, 'needs_approval')
})

test('POST .../runs/:runId/deny on a code routine from a non-host device with no key is rejected (I2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({
    flavor: 'code', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 },
    modelKey: 'm', workspacePath: 'D:/repo', codingAgent: 'pi',
  })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  db.updateRoutineRun(run.id, { status: 'needs_approval' })
  const res = await app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/deny`, { method: 'POST' })
  assert.equal(res.status, 401)
})

test('POST .../runs/:runId/approve on a CHAT routine from a non-host device is NOT gated (I2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  db.updateRoutineRun(run.id, { status: 'needs_approval' })
  const res = await app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/approve`, { method: 'POST' })
  // Not gated (401), but fails for an unrelated reason: this run has no real pendingToolCall.
  assert.notEqual(res.status, 401)
})

// ── X2: confirm/pause/resume must honor the same code-flavor auth gate ──────────────────────
// The three state-machine routes were the last ungated door onto real unattended host execution:
// scheduler.tick() fires every due `active` routine with no authorization check of its own, so
// arming a host-authored code routine (confirm on a pending one, resume on a paused one) IS
// execution, delayed by at most DEFAULT_TICK_INTERVAL_MS. /pause is gated with them because it is
// the other half of the pause/resume pair the "confirm is the only door into active" invariant
// rests on. codeGateBlocks' own doc comment deferred exactly this on the explicit condition that
// Phase 2 had not shipped execution yet — cli.ts wiring the real executeRoutine into the scheduler
// ended that condition, so the deferred decision is resolved here.
//
// `testApp({ lanBind: true })` + a request with no conn info = the threat model's caller exactly:
// LAN-exposed daemon, requireApiKey off (so lanAuth waves them through), address not loopback,
// no key presented.

/** A confirmed-then-paused code routine — the realistic pre-state for the /resume attack. */
function pausedCodeRoutine(db: ConversationStore) {
  const routine = db.createRoutine({ ...CODE_ROUTINE })
  db.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  db.updateRoutine(routine.id, { status: 'paused', nextFireAt: null })
  return routine
}

async function assertCodeGated(res: Response) {
  assert.equal(res.status, 401)
  const bodyJson = (await res.json()) as { error: { message: string } }
  assert.equal(bodyJson.error.message, CODE_GATE_MESSAGE)
}

test('PUT /:id/confirm on a code routine from a non-host device with no key is rejected (X2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({ ...CODE_ROUTINE })
  await assertCodeGated(await app.request(`/api/v1/routines/${routine.id}/confirm`, { method: 'PUT' }))
  // Gated before any state change: it must still be un-armed, so no tick can ever fire it.
  assert.equal(db.getRoutine(routine.id)?.status, 'pending_confirmation')
  assert.equal(db.getRoutine(routine.id)?.nextFireAt, null)
})

test('PUT /:id/resume on a code routine from a non-host device with no key is rejected (X2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = pausedCodeRoutine(db)
  await assertCodeGated(await app.request(`/api/v1/routines/${routine.id}/resume`, { method: 'PUT' }))
  assert.equal(db.getRoutine(routine.id)?.status, 'paused')
  assert.equal(db.getRoutine(routine.id)?.nextFireAt, null)
})

test('PUT /:id/pause on a code routine from a non-host device with no key is rejected (X2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({ ...CODE_ROUTINE })
  db.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  await assertCodeGated(await app.request(`/api/v1/routines/${routine.id}/pause`, { method: 'PUT' }))
  assert.equal(db.getRoutine(routine.id)?.status, 'active')
})

// Polarity controls. The gate must be scoped to code-flavor routines only — a chat routine's
// whole state machine stays on the baseline lanAuth bar, exactly as before X2.

test('PUT /:id/confirm on a CHAT routine from a non-host device is completely unaffected (X2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  const res = await app.request(`/api/v1/routines/${routine.id}/confirm`, { method: 'PUT' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { status: string }).status, 'active')
})

test('PUT /:id/pause on a CHAT routine from a non-host device is completely unaffected (X2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  const res = await app.request(`/api/v1/routines/${routine.id}/pause`, { method: 'PUT' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { status: string }).status, 'paused')
})

test('PUT /:id/resume on a CHAT routine from a non-host device is completely unaffected (X2)', async () => {
  const { app, db } = testApp({ lanBind: true })
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 60_000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(routine.id, '2099-01-01T00:00:00.000Z')
  db.updateRoutine(routine.id, { status: 'paused', nextFireAt: null })
  const res = await app.request(`/api/v1/routines/${routine.id}/resume`, { method: 'PUT' })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { status: string }).status, 'active')
})

// The host itself must not need a key for any of the three — the gate is about WHO is calling,
// not about code routines being unmanageable.
test('PUT /:id/confirm + /pause + /resume on a code routine from the host (loopback-only bind) need no key (X2)', async () => {
  const { app, db } = testApp({ lanBind: false })
  const routine = db.createRoutine({ ...CODE_ROUTINE })
  assert.equal((await app.request(`/api/v1/routines/${routine.id}/confirm`, { method: 'PUT' })).status, 200)
  assert.equal((await app.request(`/api/v1/routines/${routine.id}/pause`, { method: 'PUT' })).status, 200)
  assert.equal((await app.request(`/api/v1/routines/${routine.id}/resume`, { method: 'PUT' })).status, 200)
  assert.equal(db.getRoutine(routine.id)?.status, 'active')
})

// ── I3: an unhandled throw from resumeRoutineRun must not escape as a raw, unshaped 500 ────

test('POST .../runs/:runId/approve returns a shaped 500 (not a raw crash) if resumeRoutineRun throws (I3)', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  db.confirmRoutine(routine.id, '2020-01-01T00:00:00.000Z')
  const AGENT = { id: 'agent-1', name: 'A', description: '', systemPrompt: '', skillIds: [], tools: [] as string[] }
  const workingManager = {
    status: () => ({ state: 'running', model: { key: 'm' } }),
    sessionStats: () => ({ activeRequests: 0 }),
    target: () => 'http://engine.invalid.local:1',
    currentOpts: () => null,
  } as unknown as Manager
  const modelRouter = { loadExplicit: async () => ({ target: 'http://x' }) } as unknown as ModelRouter
  const d = {
    db, manager: workingManager, modelRouter,
    registry: { active: () => ({ kind: 'llama-server' }) },
    store: { snapshot: () => ({ customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }) },
  } as unknown as Deps

  // Genuinely stall via a real tool-call round so pendingToolCall is parseable.
  const run = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'not_allowed_tool', arguments: '{}' } }] } }],
  }), { status: 200 })) as typeof fetch
  try {
    await executeRoutine(d, routine, run)
  } finally { globalThis.fetch = originalFetch }
  const stalled = db.getRoutineRun(run.id)!
  assert.equal(stalled.status, 'needs_approval')

  // Force dispatch to throw instead of resolving.
  ;(d as unknown as { manager: Manager }).manager = { status: () => { throw new Error('engine exploded') } } as unknown as Manager
  registerRoutineRoutes(app, d)

  const res = await app.request(`/api/v1/routines/${routine.id}/runs/${stalled.id}/approve`, { method: 'POST' })
  assert.equal(res.status, 500)
  const responseBody = await res.json() as { error: { code: string; message: string } }
  assert.equal(responseBody.error.code, 'internal_error')
  assert.match(responseBody.error.message, /engine exploded/)
  // The claim was reverted by resumeRoutineRun itself — the run is genuinely still
  // 'needs_approval', not stuck at 'running' forever.
  assert.equal(db.getRoutineRun(stalled.id)?.status, 'needs_approval')
})

// ── M2(a): two concurrent /approve calls on the SAME stalled run (C1 regression) ────────────
// resumeRoutineRun's own idempotency claim makes exactly one of two concurrent calls win, but a
// live-execution review found the LOSING call's fast 'not_stalled' result used to still release
// the scheduler's parked guard while the WINNING call's dispatch was still executing — reopening
// the double-fire hole through a race instead of a stale-run mixup. This proves the guard
// survives for the whole duration of the winner's dispatch, not just "eventually settles right."

test('two concurrent approve calls on the same stalled run: only one executes, and the guard survives the race (C1)', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'agent-1' })
  db.confirmRoutine(routine.id, '2020-01-01T00:00:00.000Z')

  const manager = {
    status: () => ({ state: 'running', model: { key: 'm' } }),
    sessionStats: () => ({ activeRequests: 0 }),
    target: () => 'http://engine.invalid.local:1',
    currentOpts: () => null,
  } as unknown as Manager
  const modelRouter = { loadExplicit: async () => ({ target: 'http://x' }) } as unknown as ModelRouter
  const AGENT = { id: 'agent-1', name: 'A', description: '', systemPrompt: '', skillIds: [], tools: [] as string[] }
  const gate = { acquire: async () => () => {} } as unknown as GenerationGate
  const d = {
    db, manager, modelRouter, gate,
    registry: { active: () => ({ kind: 'llama-server' }) },
    store: { snapshot: () => ({ customAgents: [AGENT], tools: { toolPolicies: {} }, modelDefaults: { maxTokens: 0 } }) },
  } as unknown as Deps

  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: (r, run) => { fired.push(r.id); return executeRoutine(d, r, run) } })
  registerRoutineRoutes(app, { ...d, routineScheduler: scheduler } as unknown as Deps)

  // Stall via a real tool-call round so pendingToolCall is genuinely parseable.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'not_allowed_tool', arguments: '{}' } }] } }],
  }), { status: 200 })) as typeof fetch
  try {
    await scheduler.tick()
    await new Promise((resolve) => setImmediate(resolve))
  } finally { globalThis.fetch = originalFetch }
  const [run] = db.listRoutineRuns(routine.id)
  assert.equal(run.status, 'needs_approval')
  assert.deepEqual(fired, [routine.id])

  // Make the (winning) resumed dispatch deliberately slow, so the loser's fast 'not_stalled'
  // response — and its own releaseParkedIfResolved call — definitely lands while the winner is
  // still executing.
  let resolveSlowFetch!: () => void
  const slowFetch = new Promise<void>((resolve) => { resolveSlowFetch = resolve })
  globalThis.fetch = (async () => {
    await slowFetch
    return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 })
  }) as typeof fetch
  try {
    const call1 = app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/approve`, { method: 'POST' })
    const call2 = app.request(`/api/v1/routines/${routine.id}/runs/${run.id}/approve`, { method: 'POST' })
    // Let the loser's synchronous-fast 'not_stalled' path (and its release attempt) run.
    await new Promise((resolve) => setImmediate(resolve))
    // While the winner's dispatch is STILL blocked on slowFetch, the routine must still read as
    // guarded: a tick must not be able to start a fresh, third concurrent run for it.
    await scheduler.tick()
    assertAtMostOneRunning(db, routine.id, 'the loser\'s not_stalled result must not have released the guard mid-flight')
    assert.deepEqual(fired, [routine.id], 'no NEW fire while the winner is still executing')

    resolveSlowFetch()
    const [res1, res2] = await Promise.all([call1, call2])
    const statuses = [res1.status, res2.status].sort()
    assert.deepEqual(statuses, [200, 409], 'exactly one call succeeds, the other fails cleanly')
  } finally { globalThis.fetch = originalFetch }

  // The routine must now be genuinely released by the winner — a later tick fires it cleanly.
  await new Promise((resolve) => setImmediate(resolve))
  db.updateRoutine(routine.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'again' } }] }), { status: 200 })) as typeof fetch
  try {
    await scheduler.tick()
    await new Promise((resolve) => setImmediate(resolve))
  } finally { globalThis.fetch = originalFetch }
  // Exactly the ONE overlap row from the mid-flight guard check above — this final tick must not
  // add a second one, which is what "released cleanly" actually means here.
  assert.equal(db.listRoutineRuns(routine.id).filter((x) => x.skipReason === 'overlap').length, 1, 'no NEW overlap row after release — just the one that proved the guard held mid-flight')
})

// ── M2(b): a stale/duplicate approve on an OLD run must not release a DIFFERENT live fire ──
// (C2 regression, proven at the route/HTTP layer — the scheduler-level version lives in
// scheduler.test.ts). Simulates a leftover 'needs_approval' row the scheduler never actually
// parked (e.g. any orphaned historical state) coexisting with a genuinely live, currently-parked
// fire of the SAME routine.

test('a stale approve on an OLD needs_approval run does not release a DIFFERENT, currently-live parked fire (C2)', async () => {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  const routine = db.createRoutine({ flavor: 'chat', prompt: 'x', scheduleDisplay: 'd', scheduleRule: { kind: 'interval', everyMs: 1000 }, modelKey: 'm', agentId: 'a' })
  db.confirmRoutine(routine.id, '2020-01-01T00:00:00.000Z')

  // A leftover 'needs_approval' row the scheduler never tracked as parked (no pendingToolCall —
  // permanently unresolvable, same shape a pre-fix corrupt_pending_call row would have had).
  const staleRun = db.createRoutineRun({ routineId: routine.id, configSnapshot: JSON.stringify(routine) })
  db.updateRoutineRun(staleRun.id, { status: 'needs_approval' })

  const fired: string[] = []
  const scheduler = new RoutineScheduler({ store: db, now: () => new Date(), runRoutine: async (r) => { fired.push(r.id); return 'needs_approval' } })
  registerRoutineRoutes(app, { db, routineScheduler: scheduler } as unknown as Deps)

  // A REAL fire happens and genuinely parks — this is the run the scheduler's guard belongs to.
  await scheduler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  const liveRun = db.listRoutineRuns(routine.id).find((r) => r.id !== staleRun.id)!
  assert.equal(liveRun.status, 'needs_approval')

  // A caller approves the STALE run (its pendingToolCall can't be parsed either) — must NOT
  // release the guard the LIVE run is holding.
  const staleRes = await app.request(`/api/v1/routines/${routine.id}/runs/${staleRun.id}/approve`, { method: 'POST' })
  assert.equal(staleRes.status, 409)
  assert.equal((await staleRes.json() as { error: { code: string } }).error.code, 'corrupt_pending_call')

  // The live fire's guard must still be intact: a tick must not start a fresh concurrent run.
  await scheduler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fired, [routine.id], 'still guarded — the stale approve must not have released the live parked run')
  assert.equal(db.listRoutineRuns(routine.id).filter((x) => x.skipReason === 'overlap').length, 1)
  assertAtMostOneRunning(db, routine.id)

  // Approving the CORRECT (live) run does release it — same corrupt_pending_call path, but this
  // time it's the run the scheduler actually has parked.
  const liveRes = await app.request(`/api/v1/routines/${routine.id}/runs/${liveRun.id}/approve`, { method: 'POST' })
  assert.equal(liveRes.status, 409)
  db.updateRoutine(routine.id, { nextFireAt: '2020-01-01T00:00:00.000Z' })
  await scheduler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fired, [routine.id, routine.id], 'released correctly — the routine can fire again')
})
