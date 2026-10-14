// Security hardening tests: SSRF block on fetch_url. run_code confirmation is now
// handled upstream by the tool-call approval gate (execute-with-approval.ts) —
// execRunCode itself always executes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkSsrf, isPrivateIp } from './security'
import { execFetchUrl, execRunCode, backfillPublishedDates, FETCH_URL_MAX_CHARS } from './builtin'
import type { ResearchResult } from './research-service'

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

// ── Ranges the block list missed, and redirects that skipped the check ─────────────

test('isPrivateIp: 0.0.0.0/8, CGNAT, IPv6 unique-local/link-local and IPv4-mapped IPv6 are private', () => {
  for (const ip of ['0.0.0.0', '0.1.2.3', '::', '100.64.0.1', '100.127.255.254', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::FFFF:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '100.63.255.255', '100.128.0.1', '2606:4700::1', 'fec0::1', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('checkSsrf blocks 0.0.0.0', async () => {
  assert.match((await checkSsrf('http://0.0.0.0:6996/api/v1/settings'))!, /blocked/)
})

/** A fetch stand-in that implements redirect handling the way the real one does: `follow` (the
 *  default) chases the Location itself, `manual` hands the 3xx back. */
function stubRedirectingFetch(routes: Record<string, () => Response>): { restore: () => void; requested: string[] } {
  const original = globalThis.fetch
  const requested: string[] = []
  const serve = (url: string, init?: RequestInit): Response => {
    requested.push(url)
    const resp = routes[url]?.() ?? new Response('not found', { status: 404 })
    const location = resp.headers.get('location')
    if (location && (init?.redirect ?? 'follow') === 'follow') return serve(new URL(location, url).toString(), init)
    return resp
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => serve(String(input), init)) as typeof fetch
  return { restore: () => { globalThis.fetch = original }, requested }
}

test('execFetchUrl re-checks every redirect hop: a public URL redirecting to loopback is blocked', async () => {
  const stub = stubRedirectingFetch({
    'http://redirector.invalid/x': () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:6996/api/v1/settings' } }),
    'http://127.0.0.1:6996/api/v1/settings': () => new Response('INTERNAL-SECRET', { headers: { 'content-type': 'text/plain' } }),
  })
  try {
    const result = await execFetchUrl({ url: 'http://redirector.invalid/x' })
    assert.match(result, /blocked/)
    assert.doesNotMatch(result, /INTERNAL-SECRET/)
    assert.deepEqual(stub.requested, ['http://redirector.invalid/x'])
  } finally { stub.restore() }
})

test('execFetchUrl still follows a redirect to another public URL', async () => {
  const stub = stubRedirectingFetch({
    'http://old.invalid/a': () => new Response('', { status: 301, headers: { location: '/b' } }),
    'http://old.invalid/b': () => new Response('moved content', { headers: { 'content-type': 'text/plain' } }),
  })
  try {
    assert.match(await execFetchUrl({ url: 'http://old.invalid/a' }), /moved content/)
  } finally { stub.restore() }
})

test('backfillPublishedDates never follows a search result redirecting to an internal host', async () => {
  const stub = stubRedirectingFetch({
    'http://result.invalid/post': () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    'http://169.254.169.254/latest/meta-data/': () => new Response('<meta property="article:published_time" content="2026-01-02">', { headers: { 'content-type': 'text/html' } }),
  })
  try {
    const results = [{ title: 't', url: 'http://result.invalid/post', snippet: '' }] as unknown as ResearchResult[]
    await backfillPublishedDates(results)
    assert.deepEqual(stub.requested, ['http://result.invalid/post'])
    assert.equal(results[0].publishedDate, undefined)
  } finally { stub.restore() }
})

// fetch_url used to buffer the whole body (resp.text()) before cutting it to FETCH_URL_MAX_CHARS.
test('execFetchUrl stops reading a huge body at its byte cap and reports the page as truncated', async () => {
  const original = globalThis.fetch
  const chunk = new TextEncoder().encode('a'.repeat(64 * 1024))
  let pulled = 0
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 64 * 1024 * 1024) { controller.close(); return }
      pulled += chunk.byteLength
      controller.enqueue(chunk)
    },
  }), { headers: { 'content-type': 'text/plain' } })) as typeof fetch
  try {
    const result = await execFetchUrl({ url: 'http://big.invalid/file' })
    assert.ok(pulled < 8 * 1024 * 1024, `read ${pulled} bytes of a 64 MB body`)
    assert.ok(result.length <= FETCH_URL_MAX_CHARS)
    assert.match(result, /\[truncated:/)
  } finally { globalThis.fetch = original }
})

// ── run_code always executes (gating happens upstream) ───────────────────────────

test('execRunCode executes normally', async () => {
  const result = await execRunCode({ code: 'return 1 + 1' })
  assert.strictEqual(result, '2')
})
