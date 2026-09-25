import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { validateEvent } from '../schema'
import { Emitter } from '../emit'
import { readQueue } from '../queue'
import { emit } from '../runtime/typed-emit'
import {
  remoteAccessEnabled,
  remoteAccessDisabled,
  remoteAccessState,
  remoteAccessPreflightFailed,
  REMOTE_STATE_TRANSITIONS,
  REMOTE_PREFLIGHT_FAILURE_KINDS,
} from './remote'
import { REMOTE_PROVIDERS } from '../../config/config'
import { tmpDir } from '../../test-support/tmp'

function envelope(event: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 1,
    event,
    ts: '2026-09-14T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.11.2', os: 'win32/x64' },
    payload,
  }
}

// ── Registration: since-generation ──────────────────────────────────────────

test('every remote-access event is registered with a since generation', () => {
  for (const def of [remoteAccessEnabled, remoteAccessDisabled, remoteAccessState, remoteAccessPreflightFailed]) {
    assert.equal(typeof def.since, 'number')
    assert.ok(def.since >= 1)
  }
})

// ── Schema validation ────────────────────────────────────────────────────────

test('validateEvent: remote_access_enabled accepts every known provider', () => {
  for (const provider of REMOTE_PROVIDERS) {
    const r = validateEvent(envelope('remote_access_enabled', { provider }))
    assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  }
})

test('validateEvent: remote_access_enabled rejects a made-up provider', () => {
  const r = validateEvent(envelope('remote_access_enabled', { provider: 'my-custom-tunnel' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /provider/)
})

test('validateEvent: remote_access_disabled accepts every known provider', () => {
  for (const provider of REMOTE_PROVIDERS) {
    const r = validateEvent(envelope('remote_access_disabled', { provider }))
    assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  }
})

test('validateEvent: remote_access_state requires a known provider and state', () => {
  for (const state of REMOTE_STATE_TRANSITIONS) {
    const r = validateEvent(envelope('remote_access_state', { provider: 'ngrok', state }))
    assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  }
  const badState = validateEvent(envelope('remote_access_state', { provider: 'ngrok', state: 'connected' }))
  assert.equal(badState.ok, false)
  assert.match(badState.reason, /state/)
  const badProvider = validateEvent(envelope('remote_access_state', { provider: 'made-up', state: 'failed' }))
  assert.equal(badProvider.ok, false)
})

test('validateEvent: remote_access_preflight_failed requires a known provider and state', () => {
  for (const state of REMOTE_PREFLIGHT_FAILURE_KINDS) {
    const r = validateEvent(envelope('remote_access_preflight_failed', { provider: 'tailscale-funnel', state }))
    assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  }
  const bad = validateEvent(envelope('remote_access_preflight_failed', { provider: 'tailscale-funnel', state: 'off' }))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /state/)
})

// ── Privacy: no secret or identifying value can ever enter these payloads ──
//
// Same convention as link.test.ts: construct a real payload via the typed emit() path (the
// one call sites use), then assert on the SERIALIZED text, not a parsed object — a nested or
// renamed field can't slip past a narrowly-typed assertion.

function tempDir(): string {
  return tmpDir('turbollm-remote-telemetry-')
}

function fakeStore(level: string) {
  const cfg = { telemetry: { level, machineId: '11111111-1111-1111-1111-111111111111' } }
  return { snapshot: () => cfg, update: (fn: (c: typeof cfg) => void) => fn(cfg) }
}

function makeEmitter(dir: string): Emitter {
  return new Emitter({ dataDir: dir, store: fakeStore('anon') as never, version: '1.11.2', os: 'win32/x64' })
}

const SECRET_TOKEN = 'tllm-super-secret-abc123'
const SECRET_URL = 'https://foo-bar.trycloudflare.com'
const SECRET_HOST = 'workstation.local'
const SECRET_TAILNET = 'my-box.tailnet-name.ts.net'
const SECRET_NGROK = 'https://abcd1234.ngrok.app'

function assertNoLeak(text: string): void {
  assert.ok(!text.includes('tllm-'), 'must not carry a raw token')
  assert.ok(!text.includes(SECRET_TOKEN))
  assert.ok(!text.includes(SECRET_URL))
  assert.ok(!text.includes(SECRET_HOST))
  assert.ok(!text.includes(SECRET_TAILNET))
  assert.ok(!text.includes(SECRET_NGROK))
  assert.ok(!text.includes('ts.net'))
  assert.ok(!text.includes('trycloudflare'))
  assert.ok(!text.includes('ngrok.app'))
  assert.ok(!/https?:\/\//.test(text), 'must not carry any URL')
}

test('remote_access_enabled payload never carries a token, url, hostname or tailnet name', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, remoteAccessEnabled, { provider: 'cloudflare-named' })
    assertNoLeak(JSON.stringify(readQueue(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote_access_disabled payload never carries a token, url, hostname or tailnet name', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, remoteAccessDisabled, { provider: 'tailscale-funnel' })
    assertNoLeak(JSON.stringify(readQueue(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote_access_state payload never carries a token, url, hostname or tailnet name', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, remoteAccessState, { provider: 'ngrok', state: 'reconnecting' })
    emit(emitter, remoteAccessState, { provider: 'custom', state: 'failed' })
    assertNoLeak(JSON.stringify(readQueue(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('remote_access_preflight_failed payload never carries a token, url, hostname or tailnet name', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, remoteAccessPreflightFailed, { provider: 'tailscale-serve', state: 'needs-setup' })
    emit(emitter, remoteAccessPreflightFailed, { provider: 'ngrok', state: 'unavailable' })
    assertNoLeak(JSON.stringify(readQueue(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the schema itself structurally cannot express a token or url — enum fields only', () => {
  // Belt-and-suspenders on top of the serialized-payload checks above: walk the field specs
  // directly and confirm none of them is an 'ident' (the one kind capable of carrying
  // free-form-ish text) or anything else — every field on these events is a closed enum.
  for (const def of [remoteAccessEnabled, remoteAccessDisabled, remoteAccessState, remoteAccessPreflightFailed]) {
    for (const [key, field] of Object.entries(def.payload ?? {})) {
      assert.equal(field.kind, 'enum', `${def.name}.${key} is kind '${field.kind}' — only enum fields are allowed here`)
    }
  }
})

test('REMOTE_STATE_TRANSITIONS/REMOTE_PREFLIGHT_FAILURE_KINDS are non-empty closed sets', () => {
  assert.ok(REMOTE_STATE_TRANSITIONS.length >= 2)
  assert.ok(REMOTE_PREFLIGHT_FAILURE_KINDS.length >= 2)
  assert.ok(!REMOTE_STATE_TRANSITIONS.includes('connected' as never), 'connected is steady state, never emitted')
})

test('telemetry: carries the provider id', () => {
  // Re-checks the payload shape directly (not just schema acceptance), matching the plan's
  // intent — the .build() call it sketches does not exist; PayloadOf<> shapes are plain
  // objects constructed at the call site instead.
  const payload = { provider: 'tailscale-serve' } as const
  assert.equal(payload.provider, 'tailscale-serve')
  assert.equal(validateEvent(envelope('remote_access_enabled', payload)).ok, true)
})

test('telemetry: state transitions record the state name', () => {
  const payload = { provider: 'ngrok', state: 'failed' } as const
  assert.equal(payload.state, 'failed')
  assert.equal(validateEvent(envelope('remote_access_state', payload)).ok, true)
})
