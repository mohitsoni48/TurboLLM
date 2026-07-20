// Built-in tool definitions and execution (v0.7.0).
// Tools: web_search (Tavily), fetch_url, run_code (Node vm sandbox).
import { runInNewContext } from 'node:vm'
import { checkSsrf } from './security.js'
import { type SearchConfig } from './search-providers.js'
import { research, type ResearchResult } from './research-service.js'

// ── Tool JSON-schema definitions (OpenAI tool format) ─────────────────────

export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Search the web for real-time information. Call this BEFORE answering any question that depends on current events, recent data, prices, specific facts, or anything your training data may not cover accurately. ' +
      'Formulate a precise, keyword-focused query — include names, dates, or version numbers when relevant. ' +
      'Run multiple focused searches rather than one broad one for complex questions. ' +
      'Returns up to 8 pre-ranked results. Each entry carries a substantial excerpt from the page — not a one-line snippet — plus a relevanceScore (0–1), a source URL, and the publication date when the source reports one. ' +
      'Judge sources by authority, not only by how closely their wording echoes the question: prefer primary and official sources — the organisation\'s own site, official documentation, the original announcement, report, filing, or paper — over roundups, listicles and "best of" articles, which are often re-titled stale content dressed up as current. ' +
      'When an excerpt reads as authoritative but is too thin to answer from, call fetch_url on that result to read the full page rather than filling the gap from memory.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A precise, specific search query. Use key terms and identifiers. ' +
            'Good: "Python 3.13 release date new features". Bad: "Python new stuff". ' +
            'Good: "NVIDIA RTX 5090 benchmark 2025". Bad: "new GPU benchmarks".',
        },
        intent: {
          type: 'string',
          enum: ['factual', 'recent_news', 'comparison', 'how_to'],
          description: 'Optional: the type of answer needed. Helps the retrieval service weight results appropriately.',
        },
        freshness: {
          type: 'string',
          enum: ['current', 'any'],
          description:
            'Optional: "current" asks the search provider for recent results and penalises sources published more than 90 days ago. ' +
            'Pass "current" whenever the answer can go stale: questions using latest/newest/current/right now/this year, ' +
            'software releases and version numbers, prices, benchmarks, rankings, ongoing events, and news. ' +
            'Omit it (or pass "any") for timeless background facts such as definitions, history, or how something works.',
        },
      },
      required: ['query'],
    },
  },
}

export const FETCH_URL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'fetch_url',
    description: 'Fetch the text content of a URL. Returns the main text of the page, stripped of HTML.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
      },
      required: ['url'],
    },
  },
}

export const RUN_CODE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'run_code',
    description: 'Execute a JavaScript snippet and return the result. Useful for calculations, data transformation, and logic. No network, file, or process access.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. The last expression is the return value.' },
      },
      required: ['code'],
    },
  },
}

// ── Web search — F-021 retrieval service ──────────────────────────────────────

export { type ResearchResult }

/** PURE: today's date as 'YYYY-MM-DD' (UTC), stamped on results so the model can tell how old
 *  a source is instead of guessing from its training cutoff. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** PURE: accept only a strict, real 'YYYY-MM-DD' calendar date in a sane range, else undefined.
 *  Every date rendered by this module comes from remote pages or search providers, so this is the
 *  single choke point that keeps untrusted text out of the result block — nothing containing a
 *  '|' or a newline can survive it, so a hostile page cannot forge extra fields or result entries. */
export function normalizeIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const match = /\d{4}-\d{2}-\d{2}/.exec(raw)
  if (!match) return undefined
  const iso = match[0]
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(ms)) return undefined
  // Rejects calendar-invalid dates that would otherwise roll over (e.g. 2026-02-31).
  if (new Date(ms).toISOString().slice(0, 10) !== iso) return undefined
  const year = Number(iso.slice(0, 4))
  // Absurd dates: pre-web, or far enough ahead to be a broken clock rather than a scheduled post.
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return undefined
  return iso
}

/** PURE: flatten remote text to a single line. The result block is newline-delimited and
 *  re-parsed by chat-routes.ts, so any page-controlled field that is allowed to contain a
 *  newline can forge an entire extra `[N]` source entry (F-019).
 *
 *  Two classes of character need handling beyond a plain `\s` collapse. Both were found by
 *  replaying a hostile fixture through the real chat-routes parser, and both matter more now
 *  that a passage is a multi-sentence excerpt rather than one sentence — more attacker-chosen
 *  text per result is more room to hide them:
 *   - U+0085 (NEL) is a Unicode line terminator that JavaScript's `\s` does NOT cover, so it
 *     survived the old collapse. It cannot forge a block on its own (the parser keys off a
 *     literal `\n`), but it still reaches the model and the sources panel as a live break.
 *   - Bidi and invisible formatting controls cannot forge a block either, but they let a
 *     hostile title or excerpt RENDER in the panel as text it does not contain — visually
 *     reordered, or with segments hidden. They are dropped rather than collapsed because they
 *     are zero-width: turning them into spaces would corrupt legitimate text. U+200C/U+200D
 *     (ZWNJ/ZWJ) are deliberately NOT dropped — they are load-bearing in Indic, Persian and
 *     Arabic script and in emoji sequences, and this app is general-purpose. */
function oneLine(s: string): string {
  return s
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\s\u0085]+/g, ' ')
    .trim()
}

/** PURE: render a result's publication date for the model, e.g. "2026-07-14 (6 days ago)".
 *  Says "unknown" rather than staying silent — an absent date must not read as a fresh one. */
function publishedLabel(r: ResearchResult): string {
  const iso = normalizeIsoDate(r.publishedDate)
  if (!iso) return 'unknown'
  const age = r.ageDays
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) return iso
  if (age === 0) return `${iso} (today)`
  return `${iso} (${age === 1 ? '1 day' : `${age} days`} ago)`
}

/** PURE: the schema declares a single required `query: string`, but a model sometimes emits
 *  `queries: string[]` instead (seen from a small local model whose tool-calling drifted from
 *  the declared schema) — fall back to the first entry rather than silently treating the call
 *  as query-less. */
export function resolveSearchQuery(args: Record<string, unknown>): string {
  if (typeof args.query === 'string') return args.query
  if (Array.isArray(args.queries) && typeof args.queries[0] === 'string') return args.queries[0]
  return ''
}

export async function execWebSearch(args: Record<string, unknown>, searchCfg: SearchConfig): Promise<string> {
  const query = resolveSearchQuery(args)
  if (!query.trim()) return 'Error: query is required.'

  const intent = typeof args.intent === 'string' ? args.intent : undefined
  const freshness = args.freshness === 'current' || args.freshness === 'any' ? args.freshness : undefined

  let results: ResearchResult[]
  try {
    results = await research({ query, intent, freshness }, searchCfg)
  } catch (e) {
    return `Error: could not reach the ${searchCfg.provider} search provider — ${(e as Error).message}`
  }

  if (results.length === 0) return 'No results found.'

  const retrieved = todayIso()
  // The query is echoed on one line: strip newlines so it cannot fake a `[N]` result block.
  const lines: string[] = [
    `RESEARCH RESULTS (${results.length} ranked results for "${query.replace(/\s+/g, ' ')}"):`,
    `Retrieved: ${retrieved} — this search ran today, so treat ${retrieved} as the current date. ` +
      'Weigh each result against its Published date; "Published: unknown" means the source reported no date, not that it is current.',
  ]
  for (const [i, r] of results.entries()) {
    // Title and passage are attacker-controlled page text and both terminate a line of this
    // block format, so both are collapsed to a single line. Without this a page whose winning
    // text contains newlines can emit its own `[N]/Source:/Domain:/Key passage:` block —
    // verified to forge a fully-attacker-controlled entry that chat-routes.ts then persists as
    // a real citation. The passage is now a multi-sentence excerpt rather than one sentence, so
    // it carries far more attacker-chosen text through here; oneLine() is what makes that safe.
    lines.push(`\n[${i + 1}] ${oneLine(r.title)}`)
    lines.push(`Source: ${r.url}`)
    // Published/Retrieved are appended AFTER Freshness on purpose: chat-routes.ts re-parses this
    // exact line into the UI's sources panel, and this ordering keeps its prefix match intact.
    lines.push(`Domain: ${r.domain} | Relevance: ${r.relevanceScore.toFixed(2)} | Freshness: ${r.freshnessSignal} | Published: ${publishedLabel(r)} | Retrieved: ${retrieved}`)
    // MUST stay the LAST line of the block: chat-routes.ts captures this field forward to the
    // next `[N]` or end-of-string, so any labelled line added after it would be swallowed into
    // the citation text. The excerpt's size is not tuned here — see MAX_PASSAGE_CHARS in
    // research-service.ts, which bounds the per-result payload this line renders.
    lines.push(`Key passage: ${oneLine(r.passage)}`)
  }
  return lines.join('\n').trim()
}

// ── Fetch URL ─────────────────────────────────────────────────────────────

/** Meta name/property keys that carry a publication date, lowercased. */
const DATE_META_KEYS = new Set([
  'article:published_time',
  'og:article:published_time',
  'og:published_time',
  'datepublished',
  'date',
  'dc.date',
  'dc.date.issued',
  'pubdate',
  'publish-date',
])

/**
 * PURE: best-effort publication date from raw HTML, in priority order:
 * JSON-LD `datePublished` → publication-date `<meta>` → `<time datetime>`.
 * Returns 'YYYY-MM-DD' or undefined.
 *
 * Must run on the RAW html: the strip chain in execFetchUrl removes <script> (killing JSON-LD)
 * and every tag attribute (killing <meta content> and <time datetime>), so by the time the model
 * sees the page, all three date signals are already gone.
 */
export function extractPublishedDate(html: string): string | undefined {
  // Matched by regex rather than JSON.parse — the page is untrusted and we only ever want a
  // date-shaped substring out of it, never a parsed object graph.
  for (const block of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const iso = normalizeIsoDate(/"datePublished"\s*:\s*"([^"]{1,64})"/i.exec(block[1])?.[1])
    if (iso) return iso
  }

  // Attribute order varies across sites, so match the whole tag and pick the pieces out of it.
  for (const tag of html.matchAll(/<meta\s[^>]*>/gi)) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']{1,64})["']/i.exec(tag[0])?.[1]
    if (!key || !DATE_META_KEYS.has(key.trim().toLowerCase())) continue
    const iso = normalizeIsoDate(/\bcontent\s*=\s*["']([^"']{1,64})["']/i.exec(tag[0])?.[1])
    if (iso) return iso
  }

  for (const tag of html.matchAll(/<time\s[^>]*>/gi)) {
    const iso = normalizeIsoDate(/\bdatetime\s*=\s*["']([^"']{1,64})["']/i.exec(tag[0])?.[1])
    if (iso) return iso
  }

  return undefined
}

/** Meta keys carrying a LAST-MODIFIED date, lowercased. */
const MODIFIED_META_KEYS = new Set(['article:modified_time', 'og:updated_time', 'datemodified', 'last-modified', 'dc.date.modified'])

/**
 * PURE: best-effort LAST-MODIFIED date from raw HTML ('YYYY-MM-DD' or undefined).
 *
 * Why this exists: on a living document `datePublished` is the CREATION date and is
 * actively misleading about how current the content is. Measured on
 * en.wikipedia.org/wiki/Qwen — datePublished 2024-11-29, dateModified 2026-07-19, with
 * body text current to May 2026. Reporting only "Published: 2024-11-29" tells the model
 * to discount the freshest source it has, which is the exact failure this whole change
 * set exists to fix, just inverted. Both dates are reported so the model can judge.
 */
export function extractModifiedDate(html: string): string | undefined {
  for (const block of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const iso = normalizeIsoDate(/"dateModified"\s*:\s*"([^"]{1,64})"/i.exec(block[1])?.[1])
    if (iso) return iso
  }
  for (const tag of html.matchAll(/<meta\s[^>]*>/gi)) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']{1,64})["']/i.exec(tag[0])?.[1]
    if (!key || !MODIFIED_META_KEYS.has(key.trim().toLowerCase())) continue
    const iso = normalizeIsoDate(/\bcontent\s*=\s*["']([^"']{1,64})["']/i.exec(tag[0])?.[1])
    if (iso) return iso
  }
  return undefined
}

export async function execFetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim()
  if (!url) return 'Error: url is required.'
  if (!/^https?:\/\//i.test(url)) return 'Error: URL must start with http:// or https://'

  const ssrfErr = await checkSsrf(url)
  if (ssrfErr) return ssrfErr

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'TurboLLM/0.7 (tool-fetch)' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return `Error: could not fetch URL — ${(e as Error).message}`
  }

  const contentType = resp.headers.get('content-type') ?? ''
  const text = await resp.text().catch(() => '')
  let content: string
  let published: string | undefined
  let modified: string | undefined

  if (contentType.includes('text/html')) {
    published = extractPublishedDate(text)
    modified = extractModifiedDate(text)
    // Strip HTML tags and collapse whitespace
    content = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim()
  } else {
    content = text.trim()
  }

  // Built only from validated ISO dates and today's date — no page text reaches this line, so a
  // hostile document cannot spoof or overrun it. `Updated` is emitted only when the page reports a
  // modified date NEWER than its published date: on a living document (wiki, changelog, docs page)
  // the published date alone would make a source updated yesterday look years stale.
  const header = modified && modified > (published ?? '')
    ? `Published: ${published ?? 'unknown'} | Updated: ${modified} | Retrieved: ${todayIso()}`
    : `Published: ${published ?? 'unknown'} | Retrieved: ${todayIso()}`

  // Truncate to ~4000 chars (header included) to fit comfortably in the context window
  const budget = 4000 - header.length - 1
  if (content.length > budget) content = content.slice(0, budget) + '\n[truncated]'
  return `${header}\n${content || '(empty response)'}`
}

// ── Run code ─────────────────────────────────────────────────────────────

export function execRunCode(args: Record<string, unknown>): string {
  const code = String(args.code ?? '').trim()
  if (!code) return 'Error: code is required.'

  const output: string[] = []
  const sandbox = {
    console: {
      log: (...a: unknown[]) => output.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => output.push('ERROR: ' + a.map(String).join(' ')),
      warn: (...a: unknown[]) => output.push('WARN: ' + a.map(String).join(' ')),
    },
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
  }

  let result: unknown
  try {
    result = runInNewContext(`(function(){${code}})()`, sandbox, { timeout: 5000 })
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }

  const parts: string[] = []
  if (output.length > 0) parts.push(output.join('\n'))
  if (result !== undefined) {
    try {
      parts.push(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    } catch {
      parts.push(String(result))
    }
  }
  return parts.join('\n') || '(no output)'
}
