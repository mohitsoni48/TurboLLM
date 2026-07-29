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

type FakeConfig = {
  daemon: { lanBind: boolean; requireApiKey: boolean; port: number }
  apiKeys: never[]
  telemetry: { level: string; machineId: string }
}

function fakeApp(dataDir: string, telemetry: { level: string; machineId: string }) {
  const cfg: FakeConfig = {
    daemon: { lanBind: false, requireApiKey: false, port: 6996 },
    apiKeys: [],
    telemetry,
  }
  const app = new Hono()
  const d = {
    version: 'test',
    store: {
      snapshot: () => cfg,
      update: (fn: (c: FakeConfig) => void) => fn(cfg),
      dir: () => dataDir,
    },
    manager: { status: () => ({ state: 'stopped', model: null }) },
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
    app: { version: '1.9.0', os: 'win32' },
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
