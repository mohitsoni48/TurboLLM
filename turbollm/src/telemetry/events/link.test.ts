import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateEvent } from '../schema'
import { Emitter } from '../emit'
import { readQueue } from '../queue'
import { emit } from '../runtime/typed-emit'
import { linkMinted, linkAdded, linkStatusChanged, inferenceServed, LINK_ADDED_OUTCOMES, LINK_STATUSES, INFERENCE_ORIGINS } from './link'

function envelope(event: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 1,
    event,
    ts: '2026-08-21T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.11.2', os: 'win32/x64' },
    payload,
  }
}

// ── Registration: since-generation + no-payload-leak by construction ───────

test('every link event, inference_served included, is registered with a since generation', () => {
  for (const def of [linkMinted, linkAdded, linkStatusChanged, inferenceServed]) {
    assert.equal(typeof def.since, 'number')
    assert.ok(def.since >= 1)
  }
})

// ── Schema validation ───────────────────────────────────────────────────────

test('validateEvent: link_minted accepts a bare capabilityCount, preset optional', () => {
  const r = validateEvent(envelope('link_minted', { capabilityCount: 1 }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: link_minted accepts a known preset name', () => {
  const r = validateEvent(envelope('link_minted', { capabilityCount: 4, preset: 'server' }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
})

test('validateEvent: link_minted rejects a made-up preset value', () => {
  const r = validateEvent(envelope('link_minted', { capabilityCount: 1, preset: 'my-custom-thing' }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /preset/)
})

test('validateEvent: link_minted rejects a negative capabilityCount', () => {
  const r = validateEvent(envelope('link_minted', { capabilityCount: -1 }))
  assert.equal(r.ok, false)
})

test('validateEvent: link_added requires a known outcome', () => {
  for (const outcome of LINK_ADDED_OUTCOMES) {
    const r = validateEvent(envelope('link_added', { outcome }))
    assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  }
  const bad = validateEvent(envelope('link_added', { outcome: 'unknown' }))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /outcome/)
})

test('validateEvent: link_status_changed requires known from/to values', () => {
  const r = validateEvent(envelope('link_status_changed', { from: 'unknown', to: 'online' }))
  assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  const bad = validateEvent(envelope('link_status_changed', { from: 'unknown', to: 'gone' }))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /to/)
})

// ── Privacy: no secret or identifying value can ever enter these payloads ──
//
// Constructs a real payload for each event via the typed emit() path (the same one
// call sites use), asserts on the SERIALIZED text (not a parsed object), so a nested
// or renamed field can't slip past a narrowly-typed assertion — same convention as
// link-admin-routes.test.ts's raw-token regression tests.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'turbollm-link-telemetry-'))
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

test('link_minted payload never carries a token, url, or hostname substring', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    // Adversarial: even if a caller tried to smuggle a secret-shaped preset name in,
    // the enum rejects anything not in LINK_PRESETS, so it can never reach the queue.
    emit(emitter, linkMinted, { capabilityCount: 4, preset: 'server' })
    const queued = readQueue(dir)
    const text = JSON.stringify(queued)
    assert.ok(!text.includes('tllm-'), 'must not carry a raw token')
    assert.ok(!text.includes(SECRET_TOKEN))
    assert.ok(!text.includes(SECRET_URL))
    assert.ok(!text.includes(SECRET_HOST))
    assert.ok(!/https?:\/\//.test(text), 'must not carry any URL')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('link_added payload never carries a token, url, or hostname substring', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, linkAdded, { outcome: 'online' })
    const queued = readQueue(dir)
    const text = JSON.stringify(queued)
    assert.ok(!text.includes('tllm-'))
    assert.ok(!text.includes(SECRET_TOKEN))
    assert.ok(!text.includes(SECRET_URL))
    assert.ok(!text.includes(SECRET_HOST))
    assert.ok(!/https?:\/\//.test(text))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('link_status_changed payload never carries a token, url, or hostname substring', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, linkStatusChanged, { from: 'unknown', to: 'unreachable' })
    const queued = readQueue(dir)
    const text = JSON.stringify(queued)
    assert.ok(!text.includes('tllm-'))
    assert.ok(!text.includes(SECRET_TOKEN))
    assert.ok(!text.includes(SECRET_URL))
    assert.ok(!text.includes(SECRET_HOST))
    assert.ok(!/https?:\/\//.test(text))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the schema itself structurally cannot express a token or url — enum/int fields only', () => {
  // Belt-and-suspenders on top of the serialized-payload checks above: walk the field
  // specs directly and confirm none of them is an 'ident' (the one kind capable of
  // carrying free-form-ish text) or anything else that could carry a URL/token.
  for (const def of [linkMinted, linkAdded, linkStatusChanged, inferenceServed]) {
    for (const [key, field] of Object.entries(def.payload ?? {})) {
      assert.ok(
        field.kind === 'enum' || field.kind === 'number' || field.kind === 'boolean',
        `${def.name}.${key} is kind '${field.kind}' — only enum/number/boolean are allowed on link lifecycle events`,
      )
    }
  }
})

test('LINK_STATUSES/LINK_ADDED_OUTCOMES are non-empty closed sets', () => {
  assert.ok(LINK_STATUSES.length >= 4)
  assert.ok(LINK_ADDED_OUTCOMES.length >= 3)
  assert.ok(!LINK_ADDED_OUTCOMES.includes('unknown' as never), 'unknown is never a post-probe outcome')
})

// ── inference_served: single-attribution for a federated generation (spec §5.6) ────────

test('inference_served is version-gated to the SAME generation as the other link events', () => {
  // Not a decorative number: a funnel over this event must filter on `app.version` first,
  // and it can only do that if the event says which generation introduced it. A prior
  // TurboLLM funnel understated activation 10× by mixing versions.
  assert.equal(inferenceServed.since, linkMinted.since)
})

test('validateEvent: inference_served accepts every origin the enum declares', () => {
  for (const via of INFERENCE_ORIGINS) {
    const r = validateEvent(envelope('inference_served', { via, outcome: 'ok', streamed: false }))
    assert.equal(r.ok, true, r.ok === false ? r.reason : '')
  }
})

test('validateEvent: inference_served rejects an origin outside the enum', () => {
  const r = validateEvent(envelope('inference_served', { via: 'workstation', outcome: 'ok', streamed: false }))
  assert.equal(r.ok, false)
  assert.match(r.reason, /via/)
})

test('validateEvent: inference_served requires all three fields', () => {
  for (const missing of ['via', 'outcome', 'streamed']) {
    const payload: Record<string, unknown> = { via: 'link', outcome: 'ok', streamed: true }
    delete payload[missing]
    assert.equal(validateEvent(envelope('inference_served', payload)).ok, false, `${missing} must be required`)
  }
})

test('inference_served payload never carries a token, url, machine name, or model key', () => {
  const dir = tempDir()
  try {
    const emitter = makeEmitter(dir)
    emit(emitter, inferenceServed, { via: 'link', outcome: 'ok', streamed: true })
    const text = JSON.stringify(readQueue(dir))
    assert.ok(!text.includes('tllm-'))
    assert.ok(!text.includes(SECRET_TOKEN))
    assert.ok(!text.includes(SECRET_URL))
    assert.ok(!text.includes(SECRET_HOST))
    assert.ok(!/https?:\/\//.test(text))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('INFERENCE_ORIGINS keeps `link` at the end — the order is part of the schema', () => {
  // Same append-only rule as HARNESSES (events/gateway.ts): inserting a value in the middle
  // silently reinterprets every row already collected.
  assert.deepEqual([...INFERENCE_ORIGINS], ['local', 'link'])
})
