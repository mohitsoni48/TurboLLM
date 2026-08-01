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
