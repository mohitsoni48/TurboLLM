// F-020: pluggable search-provider abstraction (Tavily / Kagi / SearXNG / Keenable).
// The web_search tool calls a SearchClient behind a factory; only this module
// changes per provider. Tests use an injected fetch so no network is hit.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  searchConfigured,
  searchProviderClient,
  type SearchConfig,
  type FetchImpl,
} from './search-providers.js'

// A fetch stub that records the request and returns a canned JSON body.
function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }): {
  calls: Array<{ url: string; init?: RequestInit }>
  fn: FetchImpl
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = (async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit })
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response
  }) as unknown as FetchImpl
  return { calls, fn }
}

// ── searchConfigured ──────────────────────────────────────────────────────

test('searchConfigured: tavily needs a key', () => {
  assert.equal(searchConfigured({ provider: 'tavily' }), false)
  assert.equal(searchConfigured({ provider: 'tavily', tavilyApiKey: 'k' }), true)
})

test('searchConfigured: kagi needs a key', () => {
  assert.equal(searchConfigured({ provider: 'kagi' }), false)
  assert.equal(searchConfigured({ provider: 'kagi', kagiApiKey: 'k' }), true)
})

test('searchConfigured: searxng needs a url', () => {
  assert.equal(searchConfigured({ provider: 'searxng' }), false)
  assert.equal(searchConfigured({ provider: 'searxng', searxngUrl: 'http://localhost:8888' }), true)
})

test('searchConfigured: undefined config is not configured', () => {
  assert.equal(searchConfigured(undefined), false)
})

// ── factory ────────────────────────────────────────────────────────────────

test('searchProviderClient: returns null when the selected provider is unconfigured', () => {
  assert.equal(searchProviderClient({ provider: 'kagi' }), null)
  assert.equal(searchProviderClient(undefined as unknown as SearchConfig), null)
})

test('searchProviderClient: returns a client for a configured provider', () => {
  const c = searchProviderClient({ provider: 'tavily', tavilyApiKey: 'k' })
  assert.ok(c)
  assert.equal(c!.provider, 'tavily')
})

// ── Tavily adapter ───────────────────────────────────────────────────────

test('tavily adapter maps results[] to SearchResult[]', async () => {
  const { calls, fn } = stubFetch({
    results: [
      { title: 'A', url: 'https://a.com', content: 'alpha', score: 0.9 },
      { title: 'B', url: 'https://b.com', content: 'beta', score: 0.7 },
    ],
  })
  const client = searchProviderClient({ provider: 'tavily', tavilyApiKey: 'secret' }, fn)!
  const out = await client.search('q', 5)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { title: 'A', url: 'https://a.com', content: 'alpha', score: 0.9 })
  assert.match(calls[0].url, /api\.tavily\.com/)
})

// ── Kagi adapter ─────────────────────────────────────────────────────────

test('kagi adapter maps data[] (type 0) and sends Bot auth header', async () => {
  const { calls, fn } = stubFetch({
    data: [
      { t: 0, url: 'https://k1.com', title: 'K1', snippet: 'kk1' },
      { t: 1, url: 'https://related.com', title: 'related' }, // t:1 = related searches, must be dropped
      { t: 0, url: 'https://k2.com', title: 'K2', snippet: 'kk2' },
    ],
  })
  const client = searchProviderClient({ provider: 'kagi', kagiApiKey: 'kagikey' }, fn)!
  const out = await client.search('q', 5)
  assert.equal(out.length, 2)
  assert.equal(out[0].url, 'https://k1.com')
  assert.equal(out[0].content, 'kk1')
  const auth = (calls[0].init?.headers as Record<string, string> | undefined)?.['Authorization']
  assert.equal(auth, 'Bot kagikey')
})

// ── SearXNG adapter ──────────────────────────────────────────────────────

test('searxng adapter maps results[] and requests format=json', async () => {
  const { calls, fn } = stubFetch({
    results: [
      { url: 'https://s1.com', title: 'S1', content: 'ss1' },
      { url: 'https://s2.com', title: 'S2', content: 'ss2' },
    ],
  })
  const client = searchProviderClient({ provider: 'searxng', searxngUrl: 'http://lan:8888/' }, fn)!
  const out = await client.search('q', 5)
  assert.equal(out.length, 2)
  assert.equal(out[1].url, 'https://s2.com')
  assert.match(calls[0].url, /format=json/)
  // trailing slash on the configured URL must not double up
  assert.doesNotMatch(calls[0].url, /\/\/search/)
})

test('adapter throws on non-ok response so the tool can surface an error', async () => {
  const { fn } = stubFetch({ error: 'bad' }, { ok: false, status: 401 })
  const client = searchProviderClient({ provider: 'tavily', tavilyApiKey: 'k' }, fn)!
  await assert.rejects(() => client.search('q', 5), /401/)
})

// ── Keenable adapter ─────────────────────────────────────────────────────

test('searchConfigured: keenable is configured without a key', () => {
  assert.equal(searchConfigured({ provider: 'keenable' }), true)
  assert.equal(searchConfigured({ provider: 'keenable', keenableApiKey: 'k' }), true)
})

test('searchProviderClient: returns a keenable client without a key', () => {
  const c = searchProviderClient({ provider: 'keenable' })
  assert.ok(c)
  assert.equal(c!.provider, 'keenable')
})

test('keenable keyless adapter posts to /v1/search/public with X-Keenable-Title and no X-API-Key', async () => {
  const { calls, fn } = stubFetch({
    results: [
      { title: 'A', url: 'https://a.com', snippet: 'alpha', acquired_at: '2026-11-19T00:00:00Z' },
      { title: 'B', url: 'https://b.com', description: 'beta' },
    ],
  })
  const client = searchProviderClient({ provider: 'keenable' }, fn)!
  const out = await client.search('q', 5)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { title: 'A', url: 'https://a.com', content: 'alpha' })
  assert.deepEqual(out[1], { title: 'B', url: 'https://b.com', content: 'beta' })
  assert.equal(out[0].publishedDate, undefined)
  assert.equal(calls[0].url, 'https://api.keenable.ai/v1/search/public')
  const headers = calls[0].init?.headers as Record<string, string>
  assert.equal(headers['X-Keenable-Title'], 'TurboLLM')
  assert.equal(headers['X-API-Key'], undefined)
  const body = JSON.parse(String(calls[0].init?.body))
  assert.deepEqual(body, { query: 'q', max_results: 5 })
})

test('keenable keyed adapter posts to /v1/search with X-API-Key and does not follow redirects', async () => {
  const { calls, fn } = stubFetch({
    results: [{ title: 'C', url: 'https://c.com', snippet: 'gamma' }],
  })
  const client = searchProviderClient({ provider: 'keenable', keenableApiKey: 'secret' }, fn)!
  const out = await client.search('q', 3)
  assert.equal(out[0].content, 'gamma')
  assert.equal(calls[0].url, 'https://api.keenable.ai/v1/search')
  const headers = calls[0].init?.headers as Record<string, string>
  assert.equal(headers['X-API-Key'], 'secret')
  assert.equal(headers['X-Keenable-Title'], 'TurboLLM')
  assert.equal(calls[0].init?.redirect, 'error')
})

test('keenable adapter maps recent to published_after 30d and returns published_at as publishedDate', async () => {
  const { calls, fn } = stubFetch({
    results: [
      { title: 'A', url: 'https://a.com', snippet: 'alpha', published_at: '2026-11-18T09:30:00Z' },
      { title: 'B', url: 'https://b.com', snippet: 'beta', published_at: 'not a date' },
    ],
  })
  const client = searchProviderClient({ provider: 'keenable' }, fn)!
  const out = await client.search('q', 5, { recent: true })
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { query: 'q', max_results: 5, published_after: '30d' })
  assert.equal(out[0].publishedDate, '2026-11-18')
  assert.equal('publishedDate' in out[1], false)
})

test('keenable adapter leaves the body unchanged when recent is false', async () => {
  const { calls, fn } = stubFetch({ results: [] })
  const client = searchProviderClient({ provider: 'keenable' }, fn)!
  await client.search('q', 5, { recent: false })
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { query: 'q', max_results: 5 })
})
