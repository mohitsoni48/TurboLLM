// POST /v1/systemone for a Laya model (the Laya engine speaks the same wire protocol, so the request is forwarded
// rather than computed from NLI scores). The engine is a fetch double and nothing here binds a port.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { lastLocalActivityMs, resetLocalActivity } from '../link/host-idle'
import type { ModelEntry } from '../models/scanner'
import type { RouteResult } from './model-router'
import { handleSystemOne, MAX_PAIR_CHARS } from './systemone-endpoint'

const LAYA = { key: 'laya|laya|1455', name: 'laya', laya: { checkpoints: ['english', 'multilingual'] } } as unknown as ModelEntry
const TARGET = 'http://laya.local'

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which department should handle this request?',
    criteria: { billing: 'invoices, payments, refunds', technical: 'bugs, outages', other: 'everything else' },
  },
  churn_risk: { type: 'noul', instructions: 'Does the user threaten to cancel or leave?' },
}
const STATE = { subject: 'Duplicate charge', body: 'We were billed twice for March. Refund it or we cancel.' }

/** What laya-serve answered live for a request like this one (answers trimmed to two questions). */
const LAYA_REPLY = {
  model: 'laya-rl-agent',
  answers: {
    department: {
      type: 'choice', choice: 'billing', probabilities: { billing: 0.9657, technical: 0.0137, other: 0.0206 },
      confidence: 0.8654, answer_confidence: 0.9657, action: { act_probability: 1.0 },
    },
    churn_risk: { type: 'noul', noul: 0.8229, confidence: 0.8229, answer_confidence: 0.8229, action: { act_probability: 1.0 } },
  },
  usage: { input_tokens: 264, output_tokens: 0 },
  routing: {
    model: 'english', repo: 'C:/Users/someone/.turbollm/models/laya', reason: 'English Latin text',
    detection: { script: 'latin', language: 'en' }, workflow: null,
  },
}

interface EngineCall {
  url: string
  body: unknown
}

function harness(setup: { reply?: () => Response; route?: RouteResult; fetchError?: Error } = {}) {
  const calls: EngineCall[] = []
  const routed: ModelEntry[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    if (setup.fetchError) throw setup.fetchError
    return setup.reply ? setup.reply() : json(LAYA_REPLY)
  }) as typeof fetch
  const d = {
    modelRouter: {
      route: () => { throw new Error('never route()') },
      resolveRemoteTarget: () => undefined,
      resolveLocal: (id: string) => (id === LAYA.key || id === LAYA.name ? LAYA : undefined),
      routeTo: async (entry: ModelEntry) => {
        routed.push(entry)
        return setup.route ?? { target: TARGET }
      },
      aliveSlots: () => [],
    },
    scanner: { list: () => ({ models: [LAYA], scanning: false, lastScanAt: '' }) },
  } as unknown as Deps
  const app = new Hono()
  app.post('/v1/systemone', (c) => handleSystemOne(c, d, fetchImpl))
  return { app, calls, routed }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function post(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(app.request('/v1/systemone', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

const REQUEST = { model: 'laya', state: STATE, questions: QUESTIONS }

test('a Laya model: the state and questions go to the engine\'s own /v1/systemone, unchanged and without the model', async () => {
  const h = harness()
  const res = await post(h.app, REQUEST)
  assert.equal(res.status, 200)
  assert.deepEqual(h.calls, [{ url: `${TARGET}/v1/systemone`, body: { state: STATE, questions: QUESTIONS } }])
  assert.deepEqual(h.routed, [LAYA])
})

test('a Laya model: the answers and usage come back as the engine gave them, under the library model\'s key', async () => {
  const res = await post(harness().app, REQUEST)
  const body = await res.json() as Record<string, unknown>
  assert.equal(body.model, LAYA.key)
  assert.deepEqual(body.answers, LAYA_REPLY.answers)
  assert.deepEqual(body.usage, { input_tokens: 264, output_tokens: 0 })
})

test('a Laya model: routing says which checkpoint answered and why, and never the folder it lives in', async () => {
  const res = await post(harness().app, REQUEST)
  const body = await res.json() as Record<string, unknown>
  assert.deepEqual(body.routing, { model: 'english', reason: 'English Latin text' })
  assert.doesNotMatch(JSON.stringify(body), /Users|\.turbollm/)
})

test('a Laya model counts as the owner using the machine', async () => {
  resetLocalActivity()
  await post(harness().app, REQUEST)
  assert.notEqual(lastLocalActivityMs(), null)
})

test('a Laya model is not held to the Jev context guard: the engine enforces its own limits', async () => {
  const h = harness()
  const res = await post(h.app, { ...REQUEST, state: 'x'.repeat(MAX_PAIR_CHARS + 1) })
  assert.equal(res.status, 200)
  assert.equal(h.calls.length, 1)
})

test('a question the engine refuses is a 422 carrying the engine\'s own reason', async () => {
  const h = harness({ reply: () => json({ detail: "question 'a': options exceed head_max_len=192" }, 422) })
  const res = await post(h.app, REQUEST)
  assert.equal(res.status, 422)
  assert.deepEqual(await res.json(), {
    error: { message: "question 'a': options exceed head_max_len=192", type: 'invalid_request_error', code: 'invalid_request' },
  })
})

test('a request over the engine\'s own size limits (413) is a 422 too', async () => {
  const h = harness({ reply: () => json({ detail: 'too many questions (65 > 64)' }, 413) })
  const res = await post(h.app, REQUEST)
  assert.equal(res.status, 422)
  assert.equal(((await res.json()) as { error: { message: string } }).error.message, 'too many questions (65 > 64)')
})

test('an engine failure is a 502', async () => {
  const h = harness({ reply: () => json({ detail: 'inference failed' }, 500) })
  const res = await post(h.app, REQUEST)
  assert.equal(res.status, 502)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'engine_error')
})

test('an engine answer without answers or usage is a 502 bad response', async () => {
  for (const reply of [{ usage: { input_tokens: 1, output_tokens: 0 } }, { answers: {} }, []]) {
    const res = await post(harness({ reply: () => json(reply) }).app, REQUEST)
    assert.equal(res.status, 502)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'engine_bad_response')
  }
})

test('a Laya model that is not loaded and cannot be (auto-swap off) is a 503', async () => {
  const h = harness({ route: { status: 503, message: "'laya' is not loaded." } })
  const res = await post(h.app, REQUEST)
  assert.equal(res.status, 503)
  assert.equal(h.calls.length, 0)
})

test('an unreachable Laya engine is a 500 engine_unreachable', async () => {
  const res = await post(harness({ fetchError: new Error('ECONNREFUSED') }).app, REQUEST)
  assert.equal(res.status, 500)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'engine_unreachable')
})

test('a malformed request is refused before any engine is touched, for a Laya model as for Jev', async () => {
  const h = harness()
  const res = await post(h.app, { model: 'laya', state: STATE, questions: { a: { type: 'bogus', instructions: '?' } } })
  assert.equal(res.status, 422)
  assert.deepEqual(h.routed, [])
  assert.equal(h.calls.length, 0)
})

// ADR-443: only 400, 413 and 422 are requests the caller must change. Any other status is the engine misbehaving (a
// 401 from an API key the caller never sent, a 404 from a route that is gone), which a 422 would blame on the caller.
test('only the engine\'s 400, 413 and 422 are the caller\'s to fix; every other non-2xx is a 502', async () => {
  for (const status of [400, 413, 422]) {
    const res = await post(harness({ reply: () => json({ detail: 'nope' }, status) }).app, REQUEST)
    assert.equal(res.status, 422, `engine ${status}`)
  }
  for (const status of [401, 403, 404, 405, 429, 500, 503]) {
    const res = await post(harness({ reply: () => json({ detail: 'nope' }, status) }).app, REQUEST)
    assert.equal(res.status, 502, `engine ${status}`)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'engine_error')
  }
})
