// The ingest handler is tested HERE, in the daemon's own suite, rather than in
// the worker directory: it imports the same schema.ts the client uses, so these
// tests are what actually prove client and edge cannot drift (ADR-299
// Decision 1). Running them under a separate worker-only test setup would let
// that guarantee rot unnoticed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleIngest, type IngestDeps } from './ingest'

function deps(over: Partial<IngestDeps> = {}): IngestDeps {
  const rows: unknown[][] = []
  return {
    now: () => 1_800_000_000_000,
    rateLimit: async () => true,
    store: async (events) => {
      rows.push(events)
    },
    forward: async () => {},
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

test('handleIngest: drops invalid events but keeps the valid ones in the same batch', async () => {
  const stored: unknown[][] = []
  const res = await handleIngest(
    post([validEvent(), validEvent({ prompt: 'secret' }), validEvent({ event: 'daily_active' })]),
    deps({ store: async (e) => void stored.push(e) }),
  )
  assert.equal(res.status, 202)
  assert.equal(stored[0].length, 2, 'the poisoned event is dropped, the batch is not')
})

test('handleIngest: a batch of entirely invalid events stores nothing', async () => {
  let called = false
  const res = await handleIngest(
    post([validEvent({ prompt: 'secret' })]),
    deps({ store: async () => void (called = true) }),
  )
  assert.equal(res.status, 202, 'still 202 — we do not tell a prober what passed')
  assert.equal(called, false)
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
