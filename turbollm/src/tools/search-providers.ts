// F-020: pluggable web-search backends. The web_search tool calls a SearchClient
// produced by searchProviderClient(); only this module knows provider specifics.
// Supported providers: Tavily (default, BYO key), Kagi (BYO key), SearXNG (self-hosted URL).
import type { SearchConfig, SearchProvider } from '../config/config'

export type { SearchConfig, SearchProvider }

export interface SearchResult {
  title: string
  url: string
  content: string
  score?: number
  /** ISO 'YYYY-MM-DD' when the provider supplies a publish date; undefined otherwise. */
  publishedDate?: string
}

/** Per-search options. Absent/false fields must leave the request byte-identical. */
export interface SearchOptions {
  /** The caller asked for current results — maps to each provider's native recency param. */
  recent?: boolean
}

export interface SearchClient {
  readonly provider: SearchProvider
  /** Run a search. Throws on transport/HTTP errors so the caller can surface them. */
  search(query: string, maxResults: number, opts?: SearchOptions): Promise<SearchResult[]>
}

export type FetchImpl = typeof fetch

const SEARCH_TIMEOUT_MS = 20_000

/** Providers may report a clock slightly ahead of ours; allow this much future skew. */
const FUTURE_SKEW_MS = 2 * 24 * 60 * 60 * 1000

/**
 * Normalise a provider-supplied publish date to 'YYYY-MM-DD'.
 * Accepts ISO and RFC-2822 strings (Tavily sends "Sat, 18 Jul 2026 17:00:10 GMT",
 * Kagi sends "2023-01-18T03:05:23+00:00"). This is remote, untrusted data: anything
 * unparseable or implausible is dropped rather than passed through, and the only value
 * that can escape is a machine-generated date string.
 */
function normalizePublishedDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const ms = Date.parse(trimmed)
  if (!Number.isFinite(ms)) return undefined
  if (ms > Date.now() + FUTURE_SKEW_MS) return undefined
  const iso = new Date(ms).toISOString()
  if (Number(iso.slice(0, 4)) < 1990) return undefined
  return iso.slice(0, 10)
}

/** Whether the selected provider has the credential/URL it needs to run. */
export function searchConfigured(cfg?: SearchConfig): boolean {
  if (!cfg) return false
  switch (cfg.provider) {
    case 'tavily':
      return !!cfg.tavilyApiKey
    case 'kagi':
      return !!cfg.kagiApiKey
    case 'searxng':
      return !!cfg.searxngUrl
    default:
      return false
  }
}

/** Build the client for the configured provider, or null if it isn't configured. */
export function searchProviderClient(
  cfg: SearchConfig | undefined,
  fetchImpl: FetchImpl = fetch,
): SearchClient | null {
  if (!cfg || !searchConfigured(cfg)) return null
  switch (cfg.provider) {
    case 'tavily':
      return new TavilyClient(cfg.tavilyApiKey!, fetchImpl)
    case 'kagi':
      return new KagiClient(cfg.kagiApiKey!, fetchImpl)
    case 'searxng':
      return new SearxngClient(cfg.searxngUrl!, fetchImpl)
    default:
      return null
  }
}

class TavilyClient implements SearchClient {
  readonly provider = 'tavily' as const
  constructor(private key: string, private fetchImpl: FetchImpl) {}

  // `time_range` is honoured on the default (general) topic and meaningfully shifts the
  // mix toward recent pages. It does NOT make Tavily return `published_date` — only
  // `topic:'news'` does that, and that collapses results to news articles, so we don't
  // send it. Tavily therefore filters by recency but rarely supplies a date here.
  async search(query: string, maxResults: number, opts?: SearchOptions): Promise<SearchResult[]> {
    const resp = await this.fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.key,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
        ...(opts?.recent ? { time_range: 'month' } : {}),
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(await httpError('Tavily', resp))
    const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }> }
    return (data.results ?? []).map((r) => {
      const publishedDate = normalizePublishedDate(r.published_date)
      return {
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        score: r.score,
        ...(publishedDate ? { publishedDate } : {}),
      }
    })
  }
}

class KagiClient implements SearchClient {
  readonly provider = 'kagi' as const
  constructor(private key: string, private fetchImpl: FetchImpl) {}

  // No `opts` arg: the v0 search endpoint this adapter targets documents only `q` and
  // `limit` — it has no recency parameter, so `recent` cannot be honoured here.
  // (Kagi's newer POST /search endpoint does support recency via lens/filters, but it
  // has a different request and response shape and would need a full adapter rewrite.)
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://kagi.com/api/v0/search?q=${encodeURIComponent(query)}&limit=${maxResults}`
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bot ${this.key}` },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(await httpError('Kagi', resp))
    // Kagi returns mixed items: t:0 = search result, t:1 = related searches (dropped).
    const data = (await resp.json()) as { data?: Array<{ t?: number; url?: string; title?: string; snippet?: string; published?: string }> }
    return (data.data ?? [])
      .filter((r) => r.t === 0 && r.url)
      .map((r) => {
        const publishedDate = normalizePublishedDate(r.published)
        return {
          title: r.title ?? '',
          url: r.url ?? '',
          content: r.snippet ?? '',
          ...(publishedDate ? { publishedDate } : {}),
        }
      })
  }
}

class SearxngClient implements SearchClient {
  readonly provider = 'searxng' as const
  constructor(private baseUrl: string, private fetchImpl: FetchImpl) {}

  async search(query: string, maxResults: number, opts?: SearchOptions): Promise<SearchResult[]> {
    const base = this.baseUrl.replace(/\/+$/, '')
    let url = `${base}/search?q=${encodeURIComponent(query)}&format=json&categories=general`
    if (opts?.recent) url += '&time_range=month'
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(await httpError('SearXNG', resp))
    const data = (await resp.json()) as { results?: Array<{ url?: string; title?: string; content?: string; score?: number; publishedDate?: string }> }
    return (data.results ?? []).slice(0, maxResults).map((r) => {
      const publishedDate = normalizePublishedDate(r.publishedDate)
      return {
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        score: r.score,
        ...(publishedDate ? { publishedDate } : {}),
      }
    })
  }
}

async function httpError(name: string, resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '')
  return `${name} returned ${resp.status}${text ? ` — ${text.slice(0, 200)}` : ''}`
}
