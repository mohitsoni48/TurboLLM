// Security hardening tests: SSRF block on fetch_url. run_code confirmation is now
// handled upstream by the tool-call approval gate (execute-with-approval.ts) —
// execRunCode itself always executes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkSsrf, ssrfSafeFetch, SSRF_MAX_REDIRECTS } from './security'
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

// ── Redirects are re-checked ──────────────────────────────────────────────────
// fetch_url checked only the first URL, and fetch then followed redirects on its own, so a public
// page could 302 the tool to loopback (the daemon trusts loopback callers), the LAN or a metadata
// address. Public IP literals below need no DNS, and fetch is stubbed, so nothing leaves the box.

/** Stub fetch with a URL → Response table; record each requested URL and its redirect mode. */
function stubFetch(routes: Record<string, () => Response>): { calls: Array<{ url: string; redirect?: string }>; restore: () => void } {
  const real = globalThis.fetch
  const calls: Array<{ url: string; redirect?: string }> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect })
    const route = routes[String(url)]
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return route()
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { location } })

test('checkSsrf blocks 0.0.0.0, which reaches loopback on Linux and macOS', async () => {
  const err = await checkSsrf('http://0.0.0.0:6996/api/v1/conversations')
  assert.match(err!, /blocked/)
})

test('execFetchUrl blocks a public page that redirects to loopback, without requesting it', async () => {
  const f = stubFetch({ 'http://1.1.1.1/article': redirectTo('http://127.0.0.1:6996/api/v1/conversations') })
  try {
    const result = await execFetchUrl({ url: 'http://1.1.1.1/article' })
    assert.match(result, /blocked/)
    assert.deepEqual(f.calls.map((c) => c.url), ['http://1.1.1.1/article'])
    assert.equal(f.calls[0].redirect, 'manual')
  } finally {
    f.restore()
  }
})

test('execFetchUrl blocks a relative redirect into a private range', async () => {
  const f = stubFetch({
    'http://1.1.1.1/a': redirectTo('/b'),
    'http://1.1.1.1/b': redirectTo('http://169.254.169.254/latest/meta-data/'),
  })
  try {
    const result = await execFetchUrl({ url: 'http://1.1.1.1/a' })
    assert.match(result, /blocked/)
    assert.equal(f.calls.length, 2)
  } finally {
    f.restore()
  }
})

test('execFetchUrl still follows a redirect to another public page', async () => {
  const f = stubFetch({
    'http://1.1.1.1/old': redirectTo('http://8.8.8.8/new'),
    'http://8.8.8.8/new': () => new Response('hello from the new page', { headers: { 'content-type': 'text/plain' } }),
  })
  try {
    const result = await execFetchUrl({ url: 'http://1.1.1.1/old' })
    assert.match(result, /hello from the new page/)
  } finally {
    f.restore()
  }
})

test('ssrfSafeFetch gives up after too many redirects', async () => {
  const f = stubFetch({ 'http://1.1.1.1/loop': redirectTo('http://1.1.1.1/loop') })
  try {
    const result = await ssrfSafeFetch('http://1.1.1.1/loop')
    assert.equal(typeof result, 'string')
    assert.match(result as string, /redirects/)
    assert.equal(f.calls.length, SSRF_MAX_REDIRECTS + 1)
  } finally {
    f.restore()
  }
})

test('ssrfSafeFetch refuses a redirect to a non-http(s) scheme', async () => {
  const f = stubFetch({ 'http://1.1.1.1/x': redirectTo('file:///etc/passwd') })
  try {
    const result = await ssrfSafeFetch('http://1.1.1.1/x')
    assert.match(result as string, /blocked/)
  } finally {
    f.restore()
  }
})

// ── run_code always executes (gating happens upstream) ───────────────────────────

test('execRunCode executes normally', async () => {
  const result = await execRunCode({ code: 'return 1 + 1' })
  assert.strictEqual(result, '2')
})
