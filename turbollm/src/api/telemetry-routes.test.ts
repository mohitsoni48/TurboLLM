// Route-level tests for the telemetry controls (ADR-299), following
// keys-network.test.ts's "real Hono app, minimal Deps double" discipline: the
// behaviour under test depends on a real request/response cycle plus the config
// store, which a pure-function test cannot reach.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { enqueue, readQueue } from '../telemetry/queue'
import { Emitter } from '../telemetry/emit'

type FakeConfig = {
  daemon: { lanBind: boolean; requireApiKey: boolean; port: number }
  apiKeys: never[]
  telemetry: { level: string; machineId: string }
}

function fakeApp(dataDir: string, telemetry: { level: string; machineId: string }, opts?: { withEmitter?: boolean }) {
  const cfg: FakeConfig = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996 },
    apiKeys: [],
    telemetry,
  }
  const app = new Hono()
  const store = {
    snapshot: () => cfg,
    update: (fn: (c: FakeConfig) => void) => fn(cfg),
    dir: () => dataDir,
  }
  const d = {
    version: 'test',
    store,
    manager: { status: () => ({ state: 'stopped', model: null }) },
    // Real Emitter (not a stub) when a test needs actual consent/queue behaviour —
    // ui_action's route is a thin forwarder, so proving it works means proving the
    // real gate it forwards into, not a mock that would just echo back "called".
    ...(opts?.withEmitter ? { telemetry: new Emitter({ dataDir, store: store as never, version: 'test', os: 'win32/x64' }) } : {}),
  } as unknown as Deps
  registerApi(app, d)
  return { app, cfg }
}

function validEvent(): Record<string, unknown> {
  return {
    schema: 1,
    event: 'app_first_run',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '11111111-1111-1111-1111-111111111111',
    app: { version: '1.9.0', os: 'win32/x64' },
  }
}

test('GET /api/v1/telemetry/preview?level=off: discloses the one-time consent ping', async () => {
  // This endpoint exists so a user can check our claims against reality, so it
  // must not claim "nothing is sent" while the Off ping ships (ADR-299).
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'off', machineId: '' })
    const res = await app.request('/api/v1/telemetry/preview?level=off')
    const bodyJson = (await res.json()) as { sends: boolean; note: string; payload: unknown[] }

    assert.equal(bodyJson.sends, true)
    assert.deepEqual(bodyJson.payload, [{ schema: 1, event: 'consent_choice', level: 'off' }])
    assert.doesNotMatch(bodyJson.note, /Nothing is collected or sent/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/telemetry/regenerate-id: replaces the machine id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const old = '11111111-1111-1111-1111-111111111111'
    const { app, cfg } = fakeApp(dir, { level: 'anon', machineId: old })

    const res = await app.request('/api/v1/telemetry/regenerate-id', { method: 'POST' })
    assert.equal(res.status, 200)
    const bodyJson = (await res.json()) as { machineId: string }

    assert.notEqual(bodyJson.machineId, old)
    assert.match(bodyJson.machineId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    assert.equal(cfg.telemetry.machineId, bodyJson.machineId, 'persisted, not just returned')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /api/v1/telemetry/preview?level=full: renders the categories spec 23 §6a found undisclosed (interaction tracking, connected-tool identity, resolved load config)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'full', machineId: '11111111-1111-1111-1111-111111111111' })
    const res = await app.request('/api/v1/telemetry/preview?level=full')
    const bodyJson = (await res.json()) as { note: string; payload: Array<{ event: string }> }

    const names = bodyJson.payload.map((e) => e.event)
    assert.ok(names.includes('error'), 'the old "crash_report" name never existed as a real event')
    assert.ok(names.includes('model_load'), 'the resolved config behind a benchmark must be shown')
    assert.ok(names.includes('harness_first_seen'), 'connected coding-tool identity must be shown')
    assert.ok(names.includes('ui_action'), 'interaction-level click tracking must be shown')
    assert.doesNotMatch(bodyJson.note, /crash\/error fingerprints\. Still no prompts, paths, or content\.$/, 'the note text must mention the new categories too, not just the old two')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── POST /api/v1/telemetry/ui (spec 23 §3.8, Phase 6) ───────────────────────

test('POST /api/v1/telemetry/ui: a valid screen/action reaches the queue as ui_action, and always 202s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'full', machineId: '11111111-1111-1111-1111-111111111111' }, { withEmitter: true })
    const res = await app.request('/api/v1/telemetry/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'engines', action: 'install_engine' }),
    })
    assert.equal(res.status, 202)

    const queued = readQueue(dir).map((q) => q.event as { event: string; payload: unknown })
    assert.deepEqual(queued.find((q) => q.event === 'ui_action')?.payload, { screen: 'engines', action: 'install_engine' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/telemetry/ui: an unrecognized screen/action is silently dropped, not thrown, and still 202s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'full', machineId: '11111111-1111-1111-1111-111111111111' }, { withEmitter: true })
    const res = await app.request('/api/v1/telemetry/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'engines', action: 'not-a-real-action' }),
    })
    assert.equal(res.status, 202, 'ADR-299 anti-probing: never reveal validation outcome via status')
    assert.deepEqual(readQueue(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/telemetry/ui: anon consent must not send a click — ui_action/ui_daily are full-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'anon', machineId: '11111111-1111-1111-1111-111111111111' }, { withEmitter: true })
    await app.request('/api/v1/telemetry/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'engines', action: 'install_engine' }),
    })
    assert.deepEqual(readQueue(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/telemetry/ui: a missing screen or action is a no-op, not a 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'full', machineId: '11111111-1111-1111-1111-111111111111' }, { withEmitter: true })
    const res = await app.request('/api/v1/telemetry/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'engines' }),
    })
    assert.equal(res.status, 202)
    assert.deepEqual(readQueue(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/telemetry/ui: no telemetry on Deps (real daemon shape before wiring) never 500s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'full', machineId: '11111111-1111-1111-1111-111111111111' })
    const res = await app.request('/api/v1/telemetry/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'engines', action: 'install_engine' }),
    })
    assert.equal(res.status, 202)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/v1/telemetry/regenerate-id: discards events queued under the old id', async () => {
  // Uploading them after a regenerate would link the old and new ids together,
  // which is exactly what regenerating is meant to prevent.
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-routes-'))
  try {
    const { app } = fakeApp(dir, { level: 'anon', machineId: '11111111-1111-1111-1111-111111111111' })
    enqueue(dir, validEvent())
    assert.equal(readQueue(dir).length, 1, 'precondition: something is queued')

    await app.request('/api/v1/telemetry/regenerate-id', { method: 'POST' })

    assert.equal(readQueue(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
