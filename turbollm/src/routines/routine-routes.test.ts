import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../chat/db'
import { registerRoutineRoutes } from './routine-routes'
import type { Deps } from '../deps'

function testApp(): { app: Hono; db: ConversationStore } {
  const db = new ConversationStore(mkdtempSync(join(tmpdir(), 'routine-routes-test-')))
  const app = new Hono()
  // routine-routes.ts only reads d.db — safe to stub the rest of Deps for this route-level test.
  registerRoutineRoutes(app, { db } as unknown as Deps)
  return { app, db }
}

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
