// Security hardening tests: SSRF block on fetch_url. run_code confirmation is now
// handled upstream by the tool-call approval gate (execute-with-approval.ts) —
// execRunCode itself always executes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkSsrf } from './security'
import { execFetchUrl, execRunCode } from './builtin'

// ── SSRF block ────────────────────────────────────────────────────────────────

test('checkSsrf blocks 192.168.x.x', async () => {
  const err = await checkSsrf('http://192.168.1.1/secret')
  assert.ok(err, 'expected an error for RFC-1918 address')
  assert.match(err!, /blocked/)
})

test('checkSsrf blocks 10.x.x.x', async () => {
  const err = await checkSsrf('http://10.0.0.1/admin')
  assert.ok(err)
  assert.match(err!, /blocked/)
})

test('checkSsrf blocks 172.16-31.x.x', async () => {
  const err = await checkSsrf('http://172.20.0.1/')
  assert.ok(err)
  assert.match(err!, /blocked/)
})

test('checkSsrf blocks 127.x.x.x loopback', async () => {
  const err = await checkSsrf('http://127.0.0.1/admin')
  assert.ok(err)
  assert.match(err!, /blocked/)
})

test('checkSsrf blocks bare hostname without dot (localhost)', async () => {
  const err = await checkSsrf('http://localhost/admin')
  assert.ok(err)
  assert.match(err!, /blocked/)
})

test('checkSsrf blocks bare hostname without dot (internal)', async () => {
  const err = await checkSsrf('http://internal/secret')
  assert.ok(err)
  assert.match(err!, /blocked/)
})

test('checkSsrf allows public URL', async () => {
  const err = await checkSsrf('https://example.com/page')
  assert.strictEqual(err, null)
})

// ── execFetchUrl SSRF integration ─────────────────────────────────────────────

test('execFetchUrl blocks private address end-to-end', async () => {
  const result = await execFetchUrl({ url: 'http://192.168.1.1/secret' })
  assert.match(result, /blocked/)
})

test('execFetchUrl blocks localhost end-to-end', async () => {
  const result = await execFetchUrl({ url: 'http://localhost/admin' })
  assert.match(result, /blocked/)
})

// ── run_code always executes (gating happens upstream) ───────────────────────────

test('execRunCode executes normally', async () => {
  const result = await execRunCode({ code: 'return 1 + 1' })
  assert.strictEqual(result, '2')
})
