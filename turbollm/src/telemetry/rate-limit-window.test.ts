import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateWindow,
  IP_DAILY_LIMIT,
  IP_LIMIT,
  ipRateLimitSubject,
  MACHINE_DAILY_LIMIT,
  MACHINE_LIMIT,
  rateLimitCharges,
  type RateLimitWindow,
} from './rate-limit-window'
import { MAX_BATCH } from './ingest'

const PERIOD_MS = 60_000

test('evaluateWindow: a fresh key starts a window and succeeds', () => {
  const { next, success } = evaluateWindow(undefined, 1_000, PERIOD_MS, 1, 20)
  assert.equal(success, true)
  assert.deepEqual(next, { count: 1, windowStart: 1_000 })
})

test('evaluateWindow: succeeds up to exactly the limit, then rejects', () => {
  let window: RateLimitWindow | undefined
  for (let i = 1; i <= 20; i++) {
    const { next, success } = evaluateWindow(window, 1_000, PERIOD_MS, 1, 20)
    assert.equal(success, true, `request ${i} should succeed`)
    window = next!
  }
  const { next, success } = evaluateWindow(window, 1_000, PERIOD_MS, 1, 20)
  assert.equal(success, false, 'the 21st request must be rejected')
  assert.equal(next, null, 'already at the limit — reject without paying for another write')
})

test('evaluateWindow: once already over limit, rejects without asking for a write', () => {
  const overLimit: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const { next, success } = evaluateWindow(overLimit, 1_050, PERIOD_MS, 1, 20)
  assert.equal(success, false)
  assert.equal(next, null, 'no write should be requested once the window is already exhausted')
})

test('evaluateWindow: a new window starts once the period has fully elapsed', () => {
  const stale: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const { next, success } = evaluateWindow(stale, 1_000 + PERIOD_MS, PERIOD_MS, 1, 20)
  assert.equal(success, true)
  assert.deepEqual(next, { count: 1, windowStart: 1_000 + PERIOD_MS })
})

test('evaluateWindow: the boundary is strict — exactly periodMs elapsed resets, one ms earlier does not', () => {
  const full: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const stillIn = evaluateWindow(full, 1_000 + PERIOD_MS - 1, PERIOD_MS, 1, 20)
  assert.equal(stillIn.success, false, 'one ms before expiry, still the same exhausted window')
  const justReset = evaluateWindow(full, 1_000 + PERIOD_MS, PERIOD_MS, 1, 20)
  assert.equal(justReset.success, true, 'exactly periodMs later, a fresh window')
})

test('evaluateWindow: amount charges the full event count, not 1 per call', () => {
  // A single request carrying 15 events should consume 15 units of capacity,
  // not 1 — otherwise a large batch bypasses the limit by request-count alone
  // (found in pre-release review).
  const { next, success } = evaluateWindow(undefined, 1_000, PERIOD_MS, 15, 20)
  assert.equal(success, true)
  assert.equal(next!.count, 15)

  const { success: secondSuccess } = evaluateWindow(next!, 1_000, PERIOD_MS, 15, 20)
  assert.equal(secondSuccess, false, '15 + 15 = 30 exceeds a limit of 20')
})

test('evaluateWindow: a zero-event batch always succeeds and never writes', () => {
  const { next, success } = evaluateWindow(undefined, 1_000, PERIOD_MS, 0, 20)
  assert.equal(success, true)
  assert.equal(next, null)
})

test('evaluateWindow: a zero-event batch succeeds even against an already-exhausted window', () => {
  const overLimit: RateLimitWindow = { count: 20, windowStart: 1_000 }
  const { next, success } = evaluateWindow(overLimit, 1_010, PERIOD_MS, 0, 20)
  assert.equal(success, true, 'nothing was actually requested, so there is nothing to reject')
  assert.equal(next, null)
})

test('evaluateWindow: a full legitimate queue-drain fits in one window under the real machine limit', () => {
  const { success } = evaluateWindow(undefined, 1_000, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  assert.equal(success, true, 'a machine catching up after being offline must not be deadlocked by its own first flush')
})

test('evaluateWindow: two full queue-drains in one window exactly fill it, a third overflows', () => {
  const first = evaluateWindow(undefined, 1_000, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  const second = evaluateWindow(first.next!, 1_030, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  assert.equal(second.success, true, 'MACHINE_LIMIT is exactly 2x MAX_BATCH by design')
  const third = evaluateWindow(second.next!, 1_040, PERIOD_MS, MAX_BATCH, MACHINE_LIMIT)
  assert.equal(third.success, false)
})

// Charges one request the way the Worker does: every key rateLimitCharges names, in order, each on its own
// window, stopping at the first that refuses. Returns whether the request got through.
function chargeRequest(
  windows: Map<string, RateLimitWindow>,
  now: number,
  machineIds: string[],
  accepted: number,
  quarantined = 0,
  ip = 'ip-hash',
): boolean {
  for (const c of rateLimitCharges(ip, machineIds, accepted, quarantined)) {
    const { next, success } = evaluateWindow(windows.get(c.key), now, c.periodSeconds * 1000, c.amount, c.limit)
    if (next) windows.set(c.key, next)
    if (!success) return false
  }
  return true
}

const DAY_MS = 86_400_000
const FLUSH_MS = 5 * 60_000 // uploader.ts's interval flush

test('rateLimitCharges: one IP flooding for a day writes at most IP_DAILY_LIMIT rows, quarantined ones included', () => {
  // IP_LIMIT bounds a minute only: a full batch of quarantine-bound events every 6 s passed 7.2M rows
  // a day (~29 GB at the 4 KB event cap), which fills a D1 database within hours.
  const windows = new Map<string, RateLimitWindow>()
  let written = 0
  for (let t = 0; t < DAY_MS; t += 6_000) {
    if (chargeRequest(windows, t, [], 0, MAX_BATCH)) written += MAX_BATCH
  }
  assert.equal(written, IP_DAILY_LIMIT, `${written} rows from one IP in a day`)
  assert.equal(chargeRequest(windows, DAY_MS, [], 0, MAX_BATCH), true, 'the next day starts a fresh budget')

  // Valid events under fresh machineIds (two a request, the most the Worker takes) each start their
  // own install budget at zero; the IP's ceiling still holds them to the same total.
  const minted = new Map<string, RateLimitWindow>()
  let mintedWritten = 0
  for (let t = 0, n = 0; t < DAY_MS; t += 6_000, n += 2) {
    if (chargeRequest(minted, t, [`id-${n}`, `id-${n + 1}`], MAX_BATCH)) mintedWritten += MAX_BATCH
  }
  assert.equal(mintedWritten, IP_DAILY_LIMIT)
})

test('rateLimitCharges: one install at its daily limit leaves the rest of its IP\'s day to the other installs', () => {
  // With 10,000 a day for the whole IP, one install flushing a full queue every 5 minutes used it up
  // in 100 minutes, and every other install behind that IP (an office, a NAT) got 429 for the rest
  // of the day.
  const windows = new Map<string, RateLimitWindow>()
  let busy = 0
  for (let t = 0; t < DAY_MS - FLUSH_MS; t += FLUSH_MS) {
    if (chargeRequest(windows, t, ['busy'], MAX_BATCH)) busy += MAX_BATCH
  }
  assert.equal(busy, MACHINE_DAILY_LIMIT, 'the busy install gets its own day, and no more')
  assert.equal(
    windows.get('ipday:ip-hash')?.count,
    MACHINE_DAILY_LIMIT,
    'its refused retries never touched the allowance the IP shares',
  )
  const late = DAY_MS - FLUSH_MS
  assert.equal(chargeRequest(windows, late, ['quiet'], 20), true, 'another install behind the IP still gets through')
  assert.equal(chargeRequest(windows, late, [], 0, 1), true, 'and so does a consent_choice')
  assert.equal(chargeRequest(windows, late, ['busy'], 1), false, 'the busy one stays refused')
})

test('rateLimitCharges: the IP ceiling holds however many installs share the address', () => {
  // Ten installs at their own cap reach IP_DAILY_LIMIT; past it, any request from that IP is refused,
  // so D1 writes per address and day stay bounded.
  assert.equal(IP_DAILY_LIMIT, 10 * MACHINE_DAILY_LIMIT)
  const windows = new Map<string, RateLimitWindow>()
  let written = 0
  for (let i = 0; i < 10; i++) {
    for (let k = 0; k < MACHINE_DAILY_LIMIT / MAX_BATCH; k++) {
      if (chargeRequest(windows, (i * 20 + k) * FLUSH_MS, [`install-${i}`], MAX_BATCH)) written += MAX_BATCH
    }
  }
  assert.equal(written, IP_DAILY_LIMIT)
  assert.equal(chargeRequest(windows, 200 * FLUSH_MS, ['install-10'], 1), false)
  assert.equal(chargeRequest(windows, 200 * FLUSH_MS, ['install-10'], 1, 0, 'other-ip'), true, 'another IP is not affected')
})

test('rateLimitCharges: every tier clears a full legitimate flush, and the existing keys are kept', () => {
  const charges = rateLimitCharges('h', ['m'], MAX_BATCH, 0)
  for (const c of charges) {
    assert.ok(c.limit >= MAX_BATCH, `${c.key}: a limit below MAX_BATCH deadlocks a client's own flush`)
  }
  // Renaming a key would hand every caller a fresh window at the deploy.
  assert.deepEqual(
    charges.map(({ key, limit, periodSeconds, amount }) => [key, limit, periodSeconds, amount]),
    [
      ['ip:h', IP_LIMIT, 60, MAX_BATCH],
      ['machine:m', MACHINE_LIMIT, 60, MAX_BATCH],
      ['machineday:m', MACHINE_DAILY_LIMIT, 86_400, MAX_BATCH],
      ['ipday:h', IP_DAILY_LIMIT, 86_400, MAX_BATCH],
    ],
  )
  // Quarantined rows and an all-invalid batch charge the IP tiers alone, at least 1.
  assert.deepEqual(
    rateLimitCharges('h', [], 0, 0).map((c) => [c.key, c.amount]),
    [
      ['ip:h', 1],
      ['ipday:h', 1],
    ],
  )
})

test('ipRateLimitSubject: every address in one IPv6 /64 shares one key, however it is spelled', () => {
  const key = ipRateLimitSubject('2001:db8:85a3:12::1')
  assert.equal(key, '2001:db8:85a3:12::/64')
  for (const ip of [
    '2001:db8:85a3:12:ffff:ffff:ffff:ffff',
    '2001:0DB8:85A3:0012:0000:0000:0000:0001',
    '2001:db8:85a3:12:dead:beef::',
  ]) {
    assert.equal(ipRateLimitSubject(ip), key, ip)
  }
  assert.notEqual(ipRateLimitSubject('2001:db8:85a3:13::1'), key, 'the neighbouring /64 is a different subject')
  assert.equal(ipRateLimitSubject('::1'), '0:0:0:0::/64')
})

test('ipRateLimitSubject: IPv4, IPv4-embedded IPv6 and junk keep the whole address', () => {
  // ::ffff:a.b.c.d all share the /64 0:0:0:0 — truncating would rate-limit unrelated clients together.
  for (const ip of ['203.0.113.7', '::ffff:203.0.113.7', 'unknown', '1:2:3:4:5:6:7:8:9', '1::2::3', 'g::1', '']) {
    assert.equal(ipRateLimitSubject(ip), ip, ip)
  }
})
