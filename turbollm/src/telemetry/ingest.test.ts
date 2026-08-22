// The ingest handler is tested HERE, in the daemon's own suite, rather than in
// the worker directory: it imports the same schema.ts the client uses, so these
// tests are what actually prove client and edge cannot drift (ADR-299
// Decision 1). Running them under a separate worker-only test setup would let
// that guarantee rot unnoticed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flattenForAnalytics, handleIngest, type IngestDeps, type QuarantinedEvent } from './ingest'

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  const rows: unknown[][] = []
  return {
    now: () => 1_800_000_000_000,
    rateLimit: async () => true,
    store: async (events) => {
      rows.push(events)
    },
    forward: async () => {},
    quarantine: async () => {},
    ...over,
  }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://t.turbollm.dev/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    event: 'app_first_run',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.9.0', os: 'win32/x64' },
    ...over,
  }
}

test('handleIngest: accepts a valid batch', async () => {
  const stored: unknown[][] = []
  const res = await handleIngest(post([validEvent()]), deps({ store: async (e) => void stored.push(e) }))
  assert.equal(res.status, 202)
  assert.equal(stored[0].length, 1)
})

test('handleIngest: rejects a non-POST', async () => {
  const res = await handleIngest(new Request('https://t.turbollm.dev/v1/events'), deps())
  assert.equal(res.status, 405)
})

test('handleIngest: rejects malformed JSON without throwing', async () => {
  const res = await handleIngest(post('{ not json'), deps())
  assert.equal(res.status, 400)
})

test('handleIngest: rejects a body that is not an array', async () => {
  const res = await handleIngest(post(validEvent()), deps())
  assert.equal(res.status, 400)
})

test('handleIngest: an unrecognized-but-plausible event is quarantined, and does not block the rest of the batch from storing', async () => {
  const stored: unknown[][] = []
  const res = await handleIngest(
    post([validEvent(), validEvent({ prompt: 'secret' }), validEvent({ event: 'daily_active' })]),
    deps({ store: async (e) => void stored.push(e) }),
  )
  assert.equal(res.status, 202)
  assert.equal(stored[0].length, 2, 'the quarantined event is routed elsewhere, the batch is not blocked')
})

test('handleIngest: a batch of entirely quarantine-eligible events stores nothing, but is not destroyed either', async () => {
  let storeCalled = false
  const quarantined: QuarantinedEvent[] = []
  const res = await handleIngest(
    post([validEvent({ prompt: 'secret' })]),
    deps({ store: async () => void (storeCalled = true), quarantine: async (rows) => void quarantined.push(...rows) }),
  )
  assert.equal(res.status, 202, 'still 202 — we do not tell a prober what passed')
  assert.equal(storeCalled, false)
  assert.equal(quarantined.length, 1, 'unrecognized-but-plausible fields (ADR-331: this is exactly what failReason looked like) are recoverable, not gone')
  assert.match(quarantined[0].reason, /prompt/)
})

test('handleIngest: an enum value from a newer schema version is quarantined, not destroyed (the exact ADR-331 shape — first_chat, before this schema knew about it)', async () => {
  const quarantined: QuarantinedEvent[] = []
  const res = await handleIngest(
    // A step name this Worker's deployed schema doesn't recognise yet — exactly
    // what 'first_chat' looked like to the Worker before it was redeployed.
    post([validEvent({ event: 'onboarding_step', payload: { step: 'onboarding_complete', outcome: 'ok' } })]),
    deps({ quarantine: async (rows) => void quarantined.push(...rows) }),
  )
  assert.equal(res.status, 202)
  assert.equal(quarantined.length, 1)
})

test('handleIngest: a genuinely malformed event (fails structural sanity) is hard-rejected, never quarantined', async () => {
  const quarantined: QuarantinedEvent[] = []
  const res = await handleIngest(
    post([{ schema: 1, event: 'consent_choice', level: 'off', machineId: '00000000-0000-0000-0000-000000000000' }]),
    deps({ quarantine: async (rows) => void quarantined.push(...rows) }),
  )
  assert.equal(res.status, 202)
  assert.equal(quarantined.length, 0, 'the one absolute privacy invariant must never land anywhere, not even quarantine')
})

test('handleIngest: an oversized string smuggled through an unrecognized field is hard-rejected, never quarantined', async () => {
  const quarantined: QuarantinedEvent[] = []
  const res = await handleIngest(
    post([validEvent({ prompt: 'x'.repeat(200) })]),
    deps({ quarantine: async (rows) => void quarantined.push(...rows) }),
  )
  assert.equal(res.status, 202)
  assert.equal(quarantined.length, 0, 'an unrecognized field name is not a license for an unbounded-length value')
})

test('handleIngest: an oversized event is hard-rejected before any classification, regardless of shape', async () => {
  const quarantined: QuarantinedEvent[] = []
  const stored: unknown[][] = []
  const res = await handleIngest(
    post([validEvent({ event: 'daily_active', junk: 'y'.repeat(5000) })]),
    deps({
      store: async (e) => void stored.push(e),
      quarantine: async (rows) => void quarantined.push(...rows),
    }),
  )
  assert.equal(res.status, 202)
  assert.equal(stored.length, 0)
  assert.equal(quarantined.length, 0)
})

test('handleIngest: a quarantine failure still returns 202 and never throws, same as a storage failure', async () => {
  const res = await handleIngest(
    post([validEvent({ prompt: 'secret' })]),
    deps({
      quarantine: async () => {
        throw new Error('D1 down')
      },
    }),
  )
  assert.equal(res.status, 202)
})

test('handleIngest: an oversized batch is rejected outright', async () => {
  const res = await handleIngest(post(Array.from({ length: 5000 }, () => validEvent())), deps())
  assert.equal(res.status, 413)
})

test('handleIngest: a rate-limited caller is turned away', async () => {
  let stored = false
  const res = await handleIngest(
    post([validEvent()]),
    deps({ rateLimit: async () => false, store: async () => void (stored = true) }),
  )
  assert.equal(res.status, 429)
  assert.equal(stored, false)
})

test('handleIngest: the consent ping is accepted despite carrying no machineId', async () => {
  const stored: unknown[][] = []
  const res = await handleIngest(
    post([{ schema: 1, event: 'consent_choice', level: 'off' }]),
    deps({ store: async (e) => void stored.push(e) }),
  )
  assert.equal(res.status, 202)
  assert.equal(stored[0].length, 1)
})

test('handleIngest: an implausible t/s is filtered out', async () => {
  const bench = {
    schema: 1,
    event: 'bench_result',
    ts: '2026-07-29T12:00:00.000Z',
    machineId: '00000000-0000-0000-0000-000000000000',
    app: { version: '1.9.0', os: 'win32/x64' },
    hw: { cpu: 'CPU', ramMb: 65536, gpus: [{ name: 'RTX 5070 Ti', vramMb: 16384 }] },
    payload: {
      model: { name: 'Qwen3.6-35B', quant: 'Q4_K_M', sizeBytes: 21_000_000_000, arch: 'qwen3moe', moe: true },
      engine: { version: 'b1234' },
      params: { ctx: 8192, ngl: 99, nCpuMoe: 0, parallel: 1, kvTypeK: 'q8_0', flashAttn: 'auto' },
      result: { tps: 999_999, ttftMs: 310, vramMb: 15800, outcome: 'ok' },
    },
  }
  let called = false
  await handleIngest(post([bench]), deps({ store: async () => void (called = true) }))
  assert.equal(called, false)
})

test('handleIngest: a storage failure still returns 202 and never throws', async () => {
  const res = await handleIngest(
    post([validEvent()]),
    deps({
      store: async () => {
        throw new Error('D1 down')
      },
    }),
  )
  assert.equal(res.status, 202)
})

// ── flattenForAnalytics (2026-08-21 data-integrity audit) ────────────────────
// PostHog does not register object-valued properties in its taxonomy, so while
// the envelope was forwarded nested, the property picker offered only machineId
// / event / ts / schema for every app event — no version, no screen, no action,
// no outcome. Charts built by clicking could show WHERE a number moved and never
// why. These pin the projection that fixes it.

test('flattenForAnalytics: projects app.* and payload.* onto selectable top-level names', () => {
  const flat = flattenForAnalytics({
    event: 'ui_action',
    app: { version: '1.11.2', os: 'win32/x64' },
    payload: { screen: 'chat', action: 'send_message' },
  })
  assert.equal(flat.app_version, '1.11.2')
  assert.equal(flat.app_os, 'win32/x64')
  assert.equal(flat.payload_screen, 'chat')
  assert.equal(flat.payload_action, 'send_message')
})

test('flattenForAnalytics: keeps numeric and false-y values rather than dropping them', () => {
  // A zero counter is a real measurement, and `false` is a real answer — a
  // truthiness filter here would silently delete both.
  const flat = flattenForAnalytics({ event: 'code_daily', payload: { sessions: 0, turns: 12, daysAgo: 1 } })
  assert.equal(flat.payload_sessions, 0)
  assert.equal(flat.payload_turns, 12)
  assert.equal(flat.payload_daysAgo, 1)
})

test('flattenForAnalytics: flags non-release versions as synthetic, and real releases as not', () => {
  // The launch-day seed batch and the deploy canary were 1,844 of 2,379
  // app_first_run events. Their only tell was a version string buried in a
  // nested object, so no insight could exclude them without hand-written SQL.
  for (const version of ['canary', 'posthog-verify', 'e2e-check', 'not-a-version']) {
    assert.equal(flattenForAnalytics({ app: { version } }).is_synthetic, true, version)
  }
  for (const version of ['1.11.2', '1.9.3', '2.0.0-rc.1']) {
    assert.equal(flattenForAnalytics({ app: { version } }).is_synthetic, false, version)
  }
})

test('flattenForAnalytics: an event with no app block is not marked synthetic', () => {
  // consent_choice carries no `app` by design (schema.ts). Marking it synthetic
  // would quietly drop the only signal opted-out machines ever send.
  assert.equal(flattenForAnalytics({ event: 'consent_choice', level: 'off' }).is_synthetic, false)
})

test('flattenForAnalytics: never emits a non-scalar, so it cannot widen what a property may hold', () => {
  const flat = flattenForAnalytics({
    event: 'bench_result',
    payload: { model: { name: 'nested' }, tags: ['a'], tps: 42 },
  })
  assert.equal(flat.payload_tps, 42)
  assert.equal('payload_model' in flat, false, 'a nested block must not be re-emitted as an object')
  assert.equal('payload_tags' in flat, false, 'an array must not be re-emitted')
})
