import test from 'node:test'
import assert from 'node:assert/strict'
import { probeUrl, HEALTH_INTERVAL_MS, CONSECUTIVE_FAILURES_BEFORE_RESTART, nextHealthCheck } from './health'

test('health: probes /healthz on the public origin with no credential', async () => {
  let seen = ''
  let sentAuth: string | null = 'unset'
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = String(input)
    sentAuth = new Headers(init?.headers).get('X-TurboLLM-Auth')
    return new Response('{"ok":true}', { status: 200 })
  }) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), true)
  assert.equal(seen, 'https://foo.trycloudflare.com/healthz')
  // /healthz is auth-exempt (auth.ts isExempt), so the probe must not need a token —
  // if it did, the probe would break the moment a user rotated their key.
  assert.equal(sentAuth, null)
})

test('health: a trailing slash on the URL does not produce a double slash', async () => {
  let seen = ''
  const fake = (async (input: string | URL | Request) => {
    seen = String(input)
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch
  await probeUrl('https://foo.trycloudflare.com/', fake)
  assert.equal(seen, 'https://foo.trycloudflare.com/healthz')
})

test('health: a non-2xx is a failed probe', async () => {
  const fake = (async () => new Response('', { status: 502 })) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), false)
})

test('health: a thrown network error is a failed probe, not an exception', async () => {
  const fake = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), false)
})

test('health: probes once a minute', () => {
  assert.equal(HEALTH_INTERVAL_MS, 60_000)
})

// --- ADR-422 Phase 2 final review, Critical finding C1 -----------------------------------
// A quick tunnel returns 429 by DESIGN once 200 requests are in flight (spec 30 §1.2) — the
// edge is up and talking to us, which is the opposite of a dead-tunnel signal. probeUrl must
// not treat that as a failure, and the manager must not restart on a single (or even double)
// transient failure of any kind.

test('health: HTTP 429 counts as a healthy probe, not a failure', async () => {
  const fake = (async () => new Response('', { status: 429 })) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake), true)
})

test('health: 503 and 530 are still real failures — only 429 gets the lenient reading', async () => {
  // Unlike 429, neither has a documented "busy but alive" meaning on this path. 530 in
  // particular is Cloudflare's own signal that the edge could NOT reach the tunnel at all.
  // Treating them leniently would silently reintroduce the failure C1 is about; the
  // consecutive-failure gate (nextHealthCheck, tested below) is what protects against a
  // single transient one of these, not probeUrl itself.
  const fake503 = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
  const fake530 = (async () => new Response('', { status: 530 })) as unknown as typeof fetch
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake503), false)
  assert.equal(await probeUrl('https://foo.trycloudflare.com', fake530), false)
})

test('health: nextHealthCheck resets the streak to zero on any success', () => {
  assert.deepEqual(nextHealthCheck(true, 0), { consecutiveFailures: 0, shouldRestart: false })
  assert.deepEqual(nextHealthCheck(true, 2), { consecutiveFailures: 0, shouldRestart: false })
})

test('health: nextHealthCheck does not signal a restart on a single failure', () => {
  const r = nextHealthCheck(false, 0)
  assert.equal(r.shouldRestart, false)
  assert.equal(r.consecutiveFailures, 1)
})

test('health: nextHealthCheck requires CONSECUTIVE_FAILURES_BEFORE_RESTART in a row, then resets', () => {
  assert.ok(CONSECUTIVE_FAILURES_BEFORE_RESTART >= 2, 'a single blip must never be enough on its own')

  let streak = 0
  let last: ReturnType<typeof nextHealthCheck> | undefined
  for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_RESTART - 1; i++) {
    last = nextHealthCheck(false, streak)
    assert.equal(last.shouldRestart, false, `attempt ${i + 1} must not restart yet`)
    streak = last.consecutiveFailures
  }
  last = nextHealthCheck(false, streak)
  assert.equal(last.shouldRestart, true)
  assert.equal(last.consecutiveFailures, 0, 'the streak resets once acted on')
})

test('health: a success in the middle of a run of failures clears the streak', () => {
  const afterOneFailure = nextHealthCheck(false, 0)
  const afterSuccess = nextHealthCheck(true, afterOneFailure.consecutiveFailures)
  assert.equal(afterSuccess.consecutiveFailures, 0)
  // The next failure starts a fresh streak rather than continuing the old one.
  const afterNextFailure = nextHealthCheck(false, afterSuccess.consecutiveFailures)
  assert.equal(afterNextFailure.consecutiveFailures, 1)
  assert.equal(afterNextFailure.shouldRestart, false)
})
