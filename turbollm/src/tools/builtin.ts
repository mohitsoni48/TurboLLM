// Built-in tool definitions and execution (v0.7.0).
// Tools: web_search (Tavily), fetch_url, run_code (Node vm sandbox).
import { createContext, runInContext, type Context } from 'node:vm'
import { checkSsrf } from './security.js'
import { type SearchConfig } from './search-providers.js'
import {
  ageInDays, aggregatorPenalty, currentnessMultiplier, freshnessSignal, officialDocsBoost,
  officialSourceBoost, research, type ResearchResult,
} from './research-service.js'

// ── Tool JSON-schema definitions (OpenAI tool format) ─────────────────────

/**
 * Build the web_search tool definition, stamped with the CURRENT date.
 *
 * Built per request rather than defined once as a const, for two reasons. A daemon can run for
 * weeks, so a date captured at module load would go stale exactly the way the conversation's
 * frozen system prompt did. And more importantly, the date has to appear HERE: a traced run
 * showed a model with `Today's date is 2026-07-20` in its system prompt still searching
 * "...16GB VRAM 2025" twice, because the schema it reads while composing a query sat thousands
 * of characters away from that line — and the schema's own example said "2025".
 */
export function webSearchTool(today: string = todayIso()) {
  const year = today.slice(0, 4)
  return {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        `Search the web for real-time information. TODAY IS ${today}. ` +
        'Call this BEFORE answering any question that depends on current events, recent data, prices, specific facts, or anything your training data may not cover accurately. ' +
        // The failure this addresses, observed in a real run: asked for the best current option in
        // a category, the model searched for the specific products it remembered — all superseded —
        // and got accurate pages about obsolete things. Retrieval cannot correct a stale question.
        'DISCOVERY BEFORE RECALL: when you need what is best/current/latest in some category, your FIRST search must NOT name a specific product, model, version, brand or person you are recalling from memory — what you remember may have been replaced, and a search only returns what you ask about. ' +
        `Search the category itself plus the current year (e.g. "<category> ${year}", "latest <category> released"), read which names actually exist now, and only THEN search those names. ` +
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
              // Examples carry the live year deliberately: the previous hardcoded "2025" was
              // teaching every model to date its queries to a year that is no longer current.
              `When recency matters use ${year} — never a year you recall from training, which is how a search silently returns correct answers about superseded things. ` +
              `Good: "Python 3.13 release date new features". Bad: "Python new stuff". ` +
              `Good: "NVIDIA RTX 5090 benchmark ${year}". Bad: "new GPU benchmarks".`,
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

/** Ceiling on bytes read per date probe. Publication metadata lives in <head>, so the first
 *  chunk is enough — and a cap is what stops a hostile or merely enormous page from tying up
 *  the search. */
const DATE_PROBE_MAX_BYTES = 96_000
/** Per-probe timeout. Short on purpose: a missing date costs a "Published: unknown" label,
 *  which is honest, whereas a slow probe costs the whole research turn. */
const DATE_PROBE_TIMEOUT_MS = 4_000

/**
 * Fill in publication dates the search provider did not supply, by reading each page's own
 * metadata. Measured motivation: across 8 real searches the provider returned a date for
 * 0 of 80 results (Tavily only emits `published_date` on `topic:'news'`), so `freshnessSignal`
 * was permanently 'unknown' and the 0.2 freshness weight was inert — the model could not tell
 * a 2025 page from a 2026 one, which is precisely the reported "gives me stale data" symptom.
 *
 * Deliberately best-effort and non-fatal: probes run concurrently, each is SSRF-checked,
 * byte-capped and short-timeout'd, and ANY failure simply leaves the result's date unknown.
 * A research turn must never fail, hang, or lose results because a source was slow.
 * Mutates in place; only fields derived from the discovered date are touched.
 */
/**
 * Warn the model, in the results themselves, when this result set cannot support a
 * recommendation on its own.
 *
 * Why this is a data-level note rather than one more line of system prompt: a traced run showed
 * a mid-size local model reliably obeying single concrete rules (it passed freshness:'current'
 * on 7 of 7 calls) while multi-step strategy instructions drifted after the first search. So the
 * warning is delivered at the moment of reading, attached to the evidence it describes.
 *
 * It is also just true. Some questions ("best X for Y") are commercially farmed keywords where
 * essentially every indexed page is a roundup — verified independently of any one provider. A
 * roundup is fine for LEARNING WHICH NAMES EXIST and useless for establishing that one is
 * current, so saying exactly that is more honest than silently ranking one of them first.
 *
 * Topic-agnostic: it fires off the structural signals already computed, never off the subject.
 */
export function sourceAdvisory(query: string, results: ResearchResult[]): string | null {
  if (results.length === 0) return null
  const roundups = results.filter((r) => aggregatorPenalty(r.title, r.url) > 0).length
  const primaries = results.filter(
    (r) => officialSourceBoost(query, r.url) > 0 || officialDocsBoost(r.url) > 0,
  ).length
  // Only when roundups dominate AND nothing first-party made the cut — a mixed set means the
  // model has a real source available and needs no nudge.
  if (primaries > 0 || roundups < Math.ceil(results.length / 2)) return null
  return (
    `CAUTION: ${roundups} of these ${results.length} results are roundup/"best of" pages and none is a primary or official source. ` +
    'Pages like these are frequently re-published with a new date and stale contents, so they establish which names EXIST, not which is current or correct. ' +
    'Treat every name below as a CANDIDATE, not an answer: before recommending one, search that name against its own official source (the maker/organisation/authority behind it) and confirm the specifics there. ' +
    'If you cannot confirm a candidate that way, say so rather than repeating the roundup.'
  )
}

export async function backfillPublishedDates(results: ResearchResult[]): Promise<void> {
  const missing = results.filter((r) => !r.publishedDate)
  if (missing.length === 0) return

  await Promise.allSettled(
    missing.map(async (r) => {
      if (await checkSsrf(r.url)) return // same guard as fetch_url; never probe internal hosts
      let resp: Response
      try {
        resp = await fetch(r.url, {
          headers: { 'User-Agent': 'TurboLLM/0.7 (tool-fetch)' },
          signal: AbortSignal.timeout(DATE_PROBE_TIMEOUT_MS),
        })
      } catch {
        return
      }
      if (!resp.ok || !resp.body) return

      // Stream only as far as the byte cap: <head> comes first, so this reads the metadata
      // without pulling whole articles across the wire.
      let html = ''
      try {
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let read = 0
        while (read < DATE_PROBE_MAX_BYTES) {
          const { done, value } = await reader.read()
          if (done) break
          read += value.byteLength
          html += decoder.decode(value, { stream: true })
        }
        await reader.cancel().catch(() => {})
      } catch {
        return
      }

      // extractPublishedDate funnels through normalizeIsoDate, so nothing but a bare
      // 'YYYY-MM-DD' can reach the rendered block (F-019).
      const iso = extractPublishedDate(html)
      if (!iso) return
      r.publishedDate = iso
      r.ageDays = ageInDays(iso)
      r.freshnessSignal = freshnessSignal(r.ageDays)
    }),
  )
}

/**
 * Why web_search cannot run. Structural, not per-engine and not per-provider:
 *  - 'not_configured'  — no search provider is set up, so the tool exists but cannot execute.
 *  - 'tools_unreachable' — the tool list never reached the model at all. Today that is the
 *    engine-kind gate in chat-routes.ts (ADR-111: vLLM/SGLang reject a `tools` array unless
 *    launched with --enable-auto-tool-choice and a --tool-call-parser), but it equally covers
 *    an empty registry or an Agent allow-list that filtered web_search out. Anything that
 *    leaves the model unable to search reports the same way, so a future engine with the same
 *    limitation degrades honestly without anyone adding its name here.
 */
export type WebSearchUnavailableReason = 'not_configured' | 'tools_unreachable'

/**
 * PURE: the honest explanation shown to the MODEL when a research turn cannot search.
 *
 * Why this exists: the Research persona's prompt asserts it has searched, and the engine-kind
 * gate suppresses tools SILENTLY — so on an engine that cannot receive tools the model
 * performs zero searches, answers purely from training data, and the user gets a confident,
 * uncited, potentially years-stale answer with nothing indicating anything went wrong. That is
 * the same reported "stale data" symptom as a bad ranking, but invisible. Telling the model
 * plainly that it has no search access converts a silent wrong answer into a stated limitation.
 *
 * Deliberately topic-agnostic: it describes the CAPABILITY that is missing and says nothing
 * about the subject being researched, so it reads the same for a medical, legal or sports
 * question.
 */
export function webSearchUnavailableMessage(reason: WebSearchUnavailableReason): string {
  const cause = reason === 'not_configured'
    ? 'No web-search provider is configured (Settings → Tools).'
    : 'Web search is not available in this conversation — the active engine did not receive the tool list.'
  return (
    `${cause} You CANNOT search the web on this turn, and no results will arrive however many times you ask. ` +
    'Answer from your own knowledge only, and say so plainly at the top of your reply: state that you could not search, ' +
    'that what follows is from training data which may be out of date, and flag anything that is likely to have changed since. ' +
    'Do not claim or imply that you searched, do not invent sources, citations, URLs or dates, and do not emit a confidence line.'
  )
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

  // Providers rarely supply dates on general search; read them off the pages instead, so the
  // model can actually weigh a source's age instead of seeing "unknown" on every line.
  await backfillPublishedDates(results)

  // Now that ages are actually known, honour an explicit request for CURRENT information.
  // This runs here rather than inside research()'s scorer because at scoring time almost every
  // age is still unknown — applying it there let a 2007 encyclopedia article outrank a page
  // published the same day, since an undated result escapes the constraint entirely.
  if (freshness === 'current') {
    for (const r of results) {
      if (typeof r.ageDays === 'number') {
        r.relevanceScore = Math.round(r.relevanceScore * currentnessMultiplier(r.ageDays) * 1000) / 1000
      }
    }
    results.sort((a, b) => b.relevanceScore - a.relevanceScore)
  }

  const retrieved = todayIso()
  // The query is echoed on one line: strip newlines so it cannot fake a `[N]` result block.
  const lines: string[] = [
    `RESEARCH RESULTS (${results.length} ranked results for "${query.replace(/\s+/g, ' ')}"):`,
    `Retrieved: ${retrieved} — this search ran today, so treat ${retrieved} as the current date. ` +
      'Weigh each result against its Published date; "Published: unknown" means the source reported no date, not that it is current.',
  ]
  // Sits in the header, above the `[N]` blocks: chat-routes.ts's sources parser anchors on
  // `[N]`, so header lines are invisible to it and cannot disturb the sources panel.
  const advisory = sourceAdvisory(query, results)
  if (advisory) lines.push(advisory)
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

/**
 * Ceiling on the total characters fetch_url returns for one page, header included.
 *
 * Raised from 4,000 (ADR-230, quality over speed). The tradeoff is real in both directions:
 * a bigger ceiling costs prefill time and context on every fetch, but 4,000 chars is roughly
 * the first screen of a page, and the substance of the documents worth fetching — a spec
 * table, a reference page, a guidance document, a filing — reliably sits BELOW the
 * navigation, boilerplate and intro that the strip chain leaves in place. Measured effect of
 * the old cap: the model fetched an authoritative source, got its masthead, and answered
 * from memory anyway, which is the failure fetch_url exists to prevent. 20,000 chars is
 * ~5k tokens: affordable several times over in the long contexts that are routine on target
 * hardware, and still far below any single page's full text, so a hostile or merely enormous
 * document cannot flood the window. Tune here — nothing else depends on the value.
 */
export const FETCH_URL_MAX_CHARS = 20_000

/** Appended when a page is cut, so the model knows it is looking at a PREFIX and can decide
 *  to fetch a more specific URL rather than concluding the page did not contain the answer.
 *  Static text: no page content reaches it, so it cannot be spoofed into a different field. */
const FETCH_URL_TRUNCATION_MARKER =
  '\n[truncated: this page was longer than the fetch limit and is cut off here. ' +
  'If the answer is not above, fetch a more specific URL on this site rather than assuming the page lacks it.]'

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

  // Reserve room for the marker so a truncated page still fits under the ceiling — the old
  // code sliced to the full budget and THEN appended, overshooting by the marker's length.
  const budget = FETCH_URL_MAX_CHARS - header.length - 1 - FETCH_URL_TRUNCATION_MARKER.length
  if (content.length > budget) content = content.slice(0, budget) + FETCH_URL_TRUNCATION_MARKER
  return `${header}\n${content || '(empty response)'}`
}

// ── Run code ─────────────────────────────────────────────────────────────
//
// SECURITY: `run_code` executes model-authored JavaScript in a Node `vm` context. The invariant
// that makes this safe is simple to state and easy to violate by accident: nothing may cross from
// the sandboxed context back into this (host) module except a value that is ALREADY a primitive
// string/number/boolean/undefined the instant it leaves `runInContext`. Handing a sandbox-realm
// value a HOST-realm function as an argument — even something as innocuous-looking as
// `sandboxArray.map(String)` — is enough to escape: if the sandboxed script shadowed `.map` with
// its own function, that call invokes SANDBOX code with the HOST's `String` as an argument, and
// `String.constructor` is the HOST's real `Function` constructor. A function built via the host's
// `Function` constructor closes over the HOST's global scope, so the sandboxed code ends up
// holding the real `process` object — full `process.env` plus, via
// `process.getBuiltinModule('child_process').execSync(...)`, arbitrary OS command execution as the
// daemon's own user. (An earlier draft of this fix closed the injection side — no more host
// globals copied into the sandbox object — but reopened exactly this on the read-back side via
// `capturedArray.map(String)`. Caught in review before it shipped.)
//
// The fix below keeps every join, stringify, and message-coercion step running INSIDE the context
// via `runInContext`, using that context's OWN `Array.prototype`/`JSON`/`String` invoked with
// `.call`/`.apply` so a sandbox-owned array's shadowed `.map`/`.join`/`.toString` can never be
// reached from host code — the only thing that ever crosses the boundary is a finished string.
// `createContext({})` (an empty backing object) means nothing from this module's realm is ever
// attached to the context in the first place; every standard global (Object/Array/Math/JSON/...)
// the context has is its own, created fresh by `vm.createContext` for free.
//
// `vm` is still not a documented security boundary (per Node's own `vm` docs) — a sufficiently
// sophisticated payload or a V8/Node bug could in principle still find a way out. `run_code` is
// reachable only via a model's own tool call, never directly by network input, and its tool
// description promises callers "No network, file, or process access" — this fix makes that true
// against every known realm-escape vector. It does NOT bound CPU/memory: `{ timeout }` only stops
// *synchronous* execution, so a microtask loop (`Promise.resolve().then(loop)`) or an allocation
// bomb can still hang or crash the daemon process, and a thrown value with an infinitely-looping
// `message` getter can hang the host thread outside any vm timeout. None of those reach `process`
// or the filesystem, but out-of-process isolation (a `node:worker_threads` worker, which lets the
// host forcibly `.terminate()` a script that hangs this way, rather than relying on `vm`'s
// synchronous-only timeout) remains a deliberate follow-up for that class of denial-of-service.

const RUN_CODE_TIMEOUT_MS = 5_000
const RUN_CODE_SETUP_TIMEOUT_MS = 1_000 // fixed, non-attacker-controlled scripts — should be instant

// Builds console.log/warn/error INSIDE the sandbox, appending to a plain array of strings on the
// context's own global object. Never references anything from the host realm — every identifier
// here (`globalThis`, `Array`, `String`) resolves against the CONTEXT's own intrinsics once this
// script is executed via runInContext, not this module's. Uses `Array.prototype.map.call` (not
// `arguments.map`) so a later shadow of `Array.prototype` can't affect logging.
const RUN_CODE_CONSOLE_SETUP = `
  globalThis.__out = [];
  globalThis.console = {
    log: function () { globalThis.__out.push(Array.prototype.map.call(arguments, String).join(' ')) },
    error: function () { globalThis.__out.push('ERROR: ' + Array.prototype.map.call(arguments, String).join(' ')) },
    warn: function () { globalThis.__out.push('WARN: ' + Array.prototype.map.call(arguments, String).join(' ')) },
  };
`

// Joins captured console output into one string, evaluated ENTIRELY inside the context: explicit
// `Array.prototype.map/join.call(...)` bypasses whatever the script's own `.map`/`.join` own
// properties on `globalThis.__out` might have been reassigned to, and `String` here resolves to
// the context's own — never the host's. Only ever produces a plain string.
const RUN_CODE_JOIN_OUTPUT = `
  Array.isArray(globalThis.__out)
    ? Array.prototype.join.call(Array.prototype.map.call(globalThis.__out, String), '\\n')
    : ''
`

export function execRunCode(args: Record<string, unknown>): string {
  const code = String(args.code ?? '').trim()
  if (!code) return 'Error: code is required.'

  // An empty backing object — nothing from this module's realm is ever attached to it. Every
  // standard global (Object/Array/Math/JSON/...) the context has is the context's own, created
  // fresh by vm.createContext itself; none of it comes from the object passed in here.
  const context: Context = createContext({})

  let result: unknown
  try {
    runInContext(RUN_CODE_CONSOLE_SETUP, context, { timeout: RUN_CODE_SETUP_TIMEOUT_MS })
    // The user script's return value is stringified INSIDE this same runInContext call — same
    // realm, same timeout — so a hostile toJSON/toString/getter on whatever it returns runs under
    // RUN_CODE_TIMEOUT_MS like the rest of the script, and only a string or undefined ever
    // crosses back to the host (never JSON.stringify'd or String()'d here on the host stack).
    result = runInContext(
      `(function(){
        const __result = (function(){${code}})();
        if (__result === undefined) return undefined;
        if (typeof __result === 'string') return __result;
        try { return JSON.stringify(__result, null, 2); }
        catch (e) { try { return String(__result); } catch (e2) { return '[unstringifiable result]'; } }
      })()`,
      context,
      { timeout: RUN_CODE_TIMEOUT_MS },
    )
  } catch (e) {
    let message = 'unknown error'
    try {
      message = String((e as Error)?.message ?? e)
    } catch {
      /* a hostile getter on the thrown value's own .message — fall back rather than propagate */
    }
    return `Error: ${message}`
  }

  // Best-effort read-back of captured console output, joined entirely inside the context (see
  // RUN_CODE_JOIN_OUTPUT) — a script that deleted, reassigned, or booby-trapped its own
  // globalThis.__out only loses its own captured output, never anything belonging to the host.
  let output = ''
  try {
    const joined = runInContext(RUN_CODE_JOIN_OUTPUT, context, { timeout: RUN_CODE_SETUP_TIMEOUT_MS })
    if (typeof joined === 'string') output = joined
  } catch {
    /* best-effort only */
  }

  const parts: string[] = []
  if (output) parts.push(output)
  if (typeof result === 'string') parts.push(result)
  return parts.join('\n') || '(no output)'
}
