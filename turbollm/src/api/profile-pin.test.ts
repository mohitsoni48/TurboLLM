// Route-level tests for the preset PIN lifecycle on `PUT /api/v1/models/:key/profile` and
// `POST .../profile/reset` (ADR-353). These cover three behaviours that a pure-function test
// cannot reach, because the decision depends on the real handler reading `?engine=` off a
// request Context — and all three were bugs found in review:
//
//   1. A save whose profile is IDENTICAL to the pinned preset must KEEP the pin. The Load
//      button's "Remember these settings" is ON by default and fires exactly this save on the
//      draft the preset just filled in; unpinning there made the shipped promise ("your pick is
//      remembered and auto-applied on the next load") false on the default path.
//   2. A save that genuinely CHANGES the profile must still clear the pin, or the save appears
//      to do nothing (getModelProfile serves the pin first).
//   3. The pin is per-MODEL while save/reset are per-ENGINE. Neither may clear a pin belonging
//      to a DIFFERENT engine — that would drop engine A's tune for an edit to engine B, against
//      the per-engine contract of issue #35.
//
// Mirrors keys-network.test.ts's "real app, minimal Deps double" discipline.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { defaultConfig, type Config, type ModelPreset } from '../config/config'
import type { Deps } from '../deps'

const KEY = 'm|q4|1'
const ENGINE_A = 'engine-a'
const ENGINE_B = 'engine-b'
const PROFILE = { ctx: 4096, ngl: 99 }

function fakeApp(cfg: Config): Hono {
  const app = new Hono()
  const d = {
    version: 'test',
    store: { snapshot: () => cfg, update: (fn: (c: Config) => void) => fn(cfg) },
    scanner: { get: (k: string) => (k === KEY ? { key: KEY } : undefined) },
    registry: { active: () => ({ id: ENGINE_A }) },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  registerApi(app, d)
  return app
}

function withPinnedPreset(engineId: string, profile: unknown = PROFILE): Config {
  const cfg = defaultConfig()
  const preset: ModelPreset = {
    id: 'pinned',
    name: 'Pinned',
    engineId,
    profile,
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: 'manual',
  }
  cfg.modelPresets = { [KEY]: [preset] }
  cfg.lastPresetId = { [KEY]: 'pinned' }
  return cfg
}

function saveProfile(app: Hono, profile: unknown, engine?: string) {
  const q = engine ? `?engine=${encodeURIComponent(engine)}` : ''
  return app.request(`/api/v1/models/${encodeURIComponent(KEY)}/profile${q}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
}

test('PUT /profile: a save identical to the pinned preset KEEPS the pin', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  const res = await saveProfile(fakeApp(cfg), { ...PROFILE }, ENGINE_A)
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], 'pinned')
})

test('PUT /profile: key order does not matter when comparing against the pinned preset', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  // Same values, different property order — a naive JSON.stringify compare would unpin here.
  const res = await saveProfile(fakeApp(cfg), { ngl: 99, ctx: 4096 }, ENGINE_A)
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], 'pinned')
})

test('PUT /profile: a save that CHANGES the profile clears the pin', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  const res = await saveProfile(fakeApp(cfg), { ctx: 8192, ngl: 99 }, ENGINE_A)
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], undefined)
})

test('PUT /profile: saving engine B does NOT clear a pin belonging to engine A', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  const res = await saveProfile(fakeApp(cfg), { ctx: 8192 }, ENGINE_B)
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], 'pinned')
})

test('PUT /profile: an engine-agnostic pin ("") is cleared by a changing save on any engine', async () => {
  const cfg = withPinnedPreset('')
  const res = await saveProfile(fakeApp(cfg), { ctx: 8192 }, ENGINE_B)
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], undefined)
})

test('PUT /profile: bad profile fields are rejected before anything is written', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  const res = await saveProfile(fakeApp(cfg), { ctx: 4096, nCpuMoe: null }, ENGINE_A)
  assert.equal(res.status, 400)
  assert.equal(cfg.lastPresetId[KEY], 'pinned')
})

test('POST /profile/reset: resetting engine B does NOT clear a pin belonging to engine A', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  const res = await fakeApp(cfg).request(
    `/api/v1/models/${encodeURIComponent(KEY)}/profile/reset?engine=${ENGINE_B}`,
    { method: 'POST' },
  )
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], 'pinned')
})

test('POST /profile/reset: resetting the pinned engine DOES clear the pin', async () => {
  const cfg = withPinnedPreset(ENGINE_A)
  const res = await fakeApp(cfg).request(
    `/api/v1/models/${encodeURIComponent(KEY)}/profile/reset?engine=${ENGINE_A}`,
    { method: 'POST' },
  )
  assert.equal(res.status, 200)
  assert.equal(cfg.lastPresetId[KEY], undefined)
})
