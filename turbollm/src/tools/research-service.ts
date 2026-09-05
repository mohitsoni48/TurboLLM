// F-021: deterministic retrieval service.
// Wraps the pluggable search provider (F-020) and scores/ranks/filters results
// without any LLM calls — pure string/math, fully testable.
import {
  searchProviderClient,
  searchConfigured,
  type SearchConfig,
  type FetchImpl,
  type SearchResult,
} from './search-providers.js'

export interface ResearchQuery {
  query: string
  /** Signal to the model what kind of answer is needed. */
  intent?: string
  /** 'current' penalises results older than 90 days; 'any' is neutral. */
  freshness?: 'current' | 'any'
}

export interface ResearchResult {
  url: string
  title: string
  /** Best-matching sentence extracted from the raw search snippet. */
  passage: string
  /** 0.0–1.0 composite score: keyword overlap + domain signal + freshness. */
  relevanceScore: number
  freshnessSignal: 'recent' | 'dated' | 'unknown'
  /** Hostname extracted from url (e.g. "en.wikipedia.org"). */
  domain: string
  /** Provider-supplied publish date, ISO 'YYYY-MM-DD'. Absent when unknown/unparseable. */
  publishedDate?: string
  /** Whole days between publishedDate and now. Absent when there is no publishedDate. */
  ageDays?: number
}

const MIN_RELEVANCE_SCORE = 0.4
const MAX_RESULTS = 8
const MAX_SEARCH_RESULTS = 10

/** F-021's decided threshold: at or under this age a result counts as fresh. */
const FRESH_MAX_AGE_DAYS = 90
/** Matches the pre-existing 'dated' bucket (3+ calendar years old). */
const DATED_MIN_AGE_DAYS = 3 * 365

// ── Trusted / penalised domain map ────────────────────────────────────────────

/** Known high-quality TLDs/domains → score 0.8–1.0. */
const TRUSTED_DOMAINS: Array<[RegExp, number]> = [
  [/\.(edu|ac\.[a-z]{2})$/, 0.9],
  [/\.gov(\.[a-z]{2})?$/, 0.9],
  [/^(en|fr|de|es|ja|zh)\.wikipedia\.org$/, 1.0],
  [/^wikipedia\.org$/, 1.0],
  [/^(www\.)?(nature\.com|science\.org|pubmed\.ncbi\.nlm\.nih\.gov|arxiv\.org)$/, 0.95],
  [/^(www\.)?(nytimes\.com|reuters\.com|bbc\.com|bbc\.co\.uk|apnews\.com|theguardian\.com)$/, 0.85],
  [/^(www\.)?(wired\.com|techcrunch\.com|arstechnica\.com|theverge\.com)$/, 0.8],
  [/^(www\.)?(stackoverflow\.com|github\.com|docs\.python\.org|developer\.mozilla\.org)$/, 0.9],
  [/^(www\.)?(python\.org|nodejs\.org|typescriptlang\.org|rust-lang\.org)$/, 0.9],
]

/** Known low-quality/spam domains → score 0.1. */
const SPAM_DOMAINS: RegExp[] = [
  /^(www\.)?pinterest\.(com|co\.[a-z]{2})$/,
  /^(www\.)?quora\.com$/,
  /^(www\.)?reddit\.com\/r\/\w+\/comments\//, // deep reddit comment URLs
]

/** Extract the hostname from a URL. Returns '' on parse error. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Score a domain 0.1–1.0.
 * Trusted map first, spam list second, otherwise 0.5.
 */
export function domainScore(url: string): number {
  const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
  // Check spam first (avoid false-positive on .edu spam)
  for (const re of SPAM_DOMAINS) {
    if (re.test(host)) return 0.1
  }
  for (const [re, score] of TRUSTED_DOMAINS) {
    if (re.test(host)) return score
  }
  // TLD-based fallbacks
  if (host.endsWith('.edu') || host.endsWith('.gov')) return 0.9
  return 0.5
}

// ── Keyword overlap ────────────────────────────────────────────────────────────

/** Short stop-word list to filter noise. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'it', 'its', 'as', 'do', 'did', 'does', 'have', 'has',
  'had', 'not', 'no', 'so', 'if', 'up', 'out', 'can', 'will', 'just',
  'more', 'also', 'than', 'then', 'when', 'how', 'what', 'which', 'who',
])

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
}

/**
 * BM25-style keyword overlap: fraction of unique query terms found in text,
 * boosted by bigram overlap. Returns 0.0–1.0.
 */
export function keywordOverlap(query: string, text: string): number {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return 0
  const tTokens = new Set(tokenize(text))

  // Unigram fraction
  const unigramHits = qTokens.filter((t) => tTokens.has(t)).length
  const unigramScore = unigramHits / qTokens.length

  // Bigram bonus: how many consecutive query-term pairs also appear together in text
  const textStr = text.toLowerCase()
  let bigramHits = 0
  let bigramTotal = 0
  for (let i = 0; i < qTokens.length - 1; i++) {
    bigramTotal++
    if (textStr.includes(`${qTokens[i]} ${qTokens[i + 1]}`)) bigramHits++
  }
  const bigramScore = bigramTotal > 0 ? bigramHits / bigramTotal : 0

  // Weight unigrams 70%, bigrams 30%
  return Math.min(1, unigramScore * 0.7 + bigramScore * 0.3)
}

// ── Source-quality signals ────────────────────────────────────────────────────
//
// The three signals below exist because keyword overlap alone is gameable: SEO/listicle
// pages are *engineered* to match the exact phrasing users type, while domainScore ties
// them with primary sources at the 0.5 default. They fix that by reading the STRUCTURE of
// a result (is this the entity's own site? is this page shaped like a roundup?) and never
// its subject, so they behave identically for medicine, sport, law, cooking and software.
// Adding any topic-specific domain here would defeat the entire point.

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Hostname labels and path segments that are SEO furniture or site plumbing rather than an
 *  entity name. Structural vocabulary — it describes the *shape* of a site, not its topic. */
const GENERIC_URL_LABELS = new Set([
  'best', 'top', 'guide', 'guides', 'review', 'reviews', 'news', 'blog', 'blogs',
  'shop', 'store', 'buy', 'price', 'prices', 'deal', 'deals', 'compare', 'ranking',
  'rankings', 'list', 'lists', 'info', 'online', 'free', 'home', 'site', 'daily',
  'today', 'live', 'tips', 'world', 'expert', 'experts', 'hub', 'zone', 'central',
  'article', 'articles', 'post', 'posts', 'page', 'pages', 'category', 'tag', 'tags',
  'search', 'wiki', 'forum', 'forums', 'topic', 'topics',
])

/** Registry/suffix labels that carry no entity information ("bbc" is the name in bbc.co.uk). */
const SUFFIX_LABELS = new Set(['www', 'co', 'com', 'org', 'net', 'ac', 'gov', 'edu'])

/** Trailing version digits are noise on an entity name: "qwen3" and "qwen" are one entity,
 *  and users type the version while the official site rarely carries it. */
function entityStem(s: string): string {
  return s.replace(/\d+$/, '')
}

/** Distinctive (non-stopword, long-enough) query terms that could name an entity.
 *  Length ≥4 keeps 3-char fragments from firing, with one deliberate exception: an
 *  ALL-CAPS token in a mixed-case query is an acronym the user chose to capitalise
 *  (NHS, FDA, NASA, BBC), which is exactly an entity name. A fully-uppercased query
 *  carries no such signal, so it gets no acronym treatment. */
function entityTerms(query: string): Set<string> {
  // GENERIC_URL_LABELS are filtered out here, not just on the domain side: "best", "guide" and
  // friends are never part of an entity's name, and counting them let a farm qualify as one —
  // "comparethebestmortgagerates" matched on best+mortgage+rates before this filter.
  const terms = new Set(
    tokenize(query).filter((t) => t.length >= 4 && !GENERIC_URL_LABELS.has(t)),
  )
  if (query !== query.toUpperCase()) {
    for (const m of query.match(/\b[A-Z]{3,6}\b/g) ?? []) {
      const lower = m.toLowerCase()
      if (!GENERIC_URL_LABELS.has(lower)) terms.add(lower)
    }
  }
  return terms
}

/**
 * Boost when a distinctive query term IS the site's own name or its account/page on a
 * platform — the "horse's mouth". Topic-agnostic and list-free: it works for
 * "Tesla Model 3 range"→tesla.com, "Ozempic side effects"→ozempic.com,
 * "React 19 features"→react.dev, "Qwen3.6 context"→huggingface.co/Qwen,
 * "NHS blood pressure"→nhs.uk.
 *
 * The match must be against a WHOLE hostname label or the WHOLE first path segment, never a
 * substring — that is what stops the content-farm false positive, since "bestteslacars" and
 * "/blog/best-tesla-deals" contain "tesla" but are not equal to it. Returns 0.0–0.25.
 */
export function officialSourceBoost(query: string, url: string): number {
  let host: string
  let segments: string[]
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    host = u.hostname.toLowerCase()
    segments = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
  } catch {
    return 0
  }

  const terms = entityTerms(query)
  if (terms.size === 0) return 0

  const matches = (candidate: string): boolean => {
    if (candidate.length < 3 || GENERIC_URL_LABELS.has(candidate)) return false
    const stem = entityStem(candidate)
    for (const t of terms) {
      if (t === candidate) return true
      // Version-tolerant: "qwen3" (typed) vs "qwen" (the org's actual name), either direction.
      if (stem.length >= 4 && entityStem(t) === stem) return true
    }
    return false
  }

  /**
   * Multi-word names arrive concatenated in a domain ("bankofengland.co.uk",
   * "johnshopkins.org", "kingarthurbaking.com"), so whole-label equality misses exactly the
   * organisations most worth surfacing — measured: bankofengland.co.uk ranked 7th for
   * "Bank of England base rate announcement" while a five-year-old news article led.
   * Requiring TWO distinct query terms is what keeps this from becoming substring matching:
   * "bestteslacars" contains "tesla" but no second term, so it stays unboosted.
   */
  const isConcatenatedName = (candidate: string): boolean => {
    if (candidate.length < 8) return false
    let hits = 0
    let covered = 0
    for (const t of terms) {
      if (t.length >= 4 && candidate.includes(t)) {
        hits++
        covered += t.length
      }
    }
    // ≥2 terms, and they must account for most of the label — otherwise a long content-farm
    // domain that happens to embed two short query words would qualify.
    return hits >= 2 && covered >= candidate.length * 0.6
  }

  // The entity's own domain is the strongest form of this signal.
  const labels = host.split('.')
  for (let i = 0; i < labels.length - 1; i++) {
    // Skip the TLD (last label) and registry noise; "nhs" is the name in "nhs.uk".
    if (SUFFIX_LABELS.has(labels[i])) continue
    if (matches(labels[i])) return 0.25
    if (isConcatenatedName(labels[i])) return 0.22
  }

  // Its official page on a shared platform (huggingface.co/Qwen, instagram.com/michelin).
  // Two guards, because a bare "/<query term>" path is far more often a topical category
  // route on a content farm than an account page, and boosting those would feed exactly the
  // pages this scoring exists to demote:
  //  - exactly one segment — a platform profile is terminal ("/michelin"), whereas a farm
  //    ranks with a deep slug ("/japan/best-time-to-visit", "/blog/best-tesla-deals");
  //  - no SEO-shaped hostname label, which disqualifies the likes of "best.com/japan".
  if (segments.length !== 1) return 0
  if (labels.some((l) => GENERIC_URL_LABELS.has(l))) return 0
  return matches(segments[0]) ? 0.15 : 0
}

/** Documentation/support subdomains are first-party reference material in every industry
 *  (docs.stripe.com, developer.mozilla.org, support.apple.com, help.netflix.com) — no
 *  domain list can express that, but the hostname prefix can. Returns 0.0 or 0.1. */
export function officialDocsBoost(url: string): number {
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase()
    return /^(docs?|developers?|support|help)\./.test(host) ? 0.1 : 0
  } catch {
    return 0
  }
}

/** The universal listicle/roundup vocabulary. Subject-independent by construction: these fire
 *  on "Best Mattresses 2026" and "Top 10 Diets Ranked" exactly as on tech roundups.
 *
 *  Split out from AGGREGATOR_PATTERNS because these are the *deletable* ones — each matches a
 *  self-contained bait phrase, so debaitQuery() can excise it from a user's question and leave a
 *  grammatical query behind. Single source of truth on purpose: the page-shape penalty and the
 *  query reformulator must never disagree about what counts as bait. */
const AGGREGATOR_BAIT: RegExp[] = [
  /\bbest\b/,
  /\btop\s+\d+\b/,
  /\b\d+\s+(best|top|ways|reasons|tips|things|ideas|alternatives)\b/,
  /\bultimate\s+guide\b/,
  /\branked\b/,
  /\breviews?\b|\breviewed\b/,
  /\bround\s?up\b/,
  /\b(vs|versus)\b/,
]

/** The universal listicle/roundup signature: the deletable vocabulary plus span-shaped patterns
 *  that only make sense as detectors. `which … should you` spans arbitrary text between its two
 *  halves, so deleting the whole match would swallow the subject of the question with it. */
const AGGREGATOR_PATTERNS: RegExp[] = [
  ...AGGREGATOR_BAIT,
  /\bwhich\b[\s\S]*\bshould\s+you\b/,
]

/** "Best practices" is standard first-party documentation language, and a systematic /
 *  literature / meta review is a primary source in research fields — neither is a roundup. */
const AGGREGATOR_EXEMPTIONS: RegExp[] = [
  /\bbest\s+practices?\b/,
  /\b(systematic|literature|scoping|narrative|meta)\b/,
  /\bpeer\s+reviewed\b/,
]

/**
 * Mild penalty for pages shaped like an SEO roundup, read off the title and the URL slug.
 * Deliberately mild and never a kill: sometimes a roundup genuinely is the right answer.
 * Skipped entirely for `intent: 'comparison'`, where a ranked list is what was asked for.
 * Returns 0.0–0.2.
 */
export function aggregatorPenalty(title: string, url: string, intent?: string): number {
  // An explicit comparison request makes a roundup legitimate, not spam.
  if (intent === 'comparison') return 0

  let slug = ''
  try {
    slug = new URL(url.startsWith('http') ? url : `https://${url}`).pathname
  } catch {
    slug = ''
  }
  // Slug words are hyphen/slash separated; flattening lets one pattern set cover both surfaces.
  const text = `${title} ${slug.replace(/[^a-zA-Z0-9]+/g, ' ')}`.toLowerCase()

  if (AGGREGATOR_EXEMPTIONS.some((re) => re.test(text))) return 0
  if (!AGGREGATOR_PATTERNS.some((re) => re.test(text))) return 0

  // A year alongside a listicle marker is the annual-refresh signature ("Best X in 2026"),
  // where the year is a republish stamp rather than evidence of new reporting.
  return /\b(19|20)\d{2}\b/.test(text) ? 0.2 : 0.15
}

/** Bait that only exists in a *question*, so it has no page-shape counterpart in
 *  AGGREGATOR_PATTERNS. A bare year is included here and not there for the same reason
 *  aggregatorPenalty treats it as a modifier rather than a trigger: on a page it is an
 *  annual-refresh stamp, and in a query it pins retrieval to roundups republished that year. */
/** Whether this runtime's regex engine accepts Unicode property escapes (`\p{...}` inside a
 *  `/u` pattern) — true on desktop/full-ICU Node, false on Android's embedded nodejs-mobile
 *  runtime, which ships without full ICU data. On that runtime, `\p{L}` inside a `/u` regex is
 *  a PARSE-TIME SyntaxError, not a runtime one — a `/[^\p{L}\p{N}]+/u` regex LITERAL anywhere
 *  in a file fails to parse the WHOLE file, crashing the daemon before any of its own code
 *  runs (confirmed live: exactly this, at daemon boot, on a from-source Android build).
 *  `new RegExp(string, flags)` compiles at runtime instead, so probing it here — and building
 *  every such pattern the same way below — turns that crash into a catchable, one-time
 *  feature check. */
const SUPPORTS_UNICODE_PROPERTY_ESCAPES: boolean = (() => {
  try {
    new RegExp('\\p{L}', 'u')
    return true
  } catch {
    return false
  }
})()

/** Non-word-character class, Unicode-aware wherever the runtime supports it (identical
 *  behavior to the original `[^\p{L}\p{N}]` literal on every platform but Android). The ASCII
 *  fallback only reached there is strictly worse at segmenting non-Latin scripts, but a
 *  degraded split beats the crash it replaces. */
const NON_WORD_CLASS = SUPPORTS_UNICODE_PROPERTY_ESCAPES ? '[^\\p{L}\\p{N}]' : '[^A-Za-z0-9]'
const NON_WORD_REGEX_FLAGS = SUPPORTS_UNICODE_PROPERTY_ESCAPES ? 'u' : ''

/**
 * Substantive-term count for the "is anything left to search for?" guard.
 *
 * Deliberately NOT tokenize(): that one is ASCII-only (`\W` is `[^A-Za-z0-9_]`) and it scores
 * every result in the system, so widening it would shift every relevance score. Here the only
 * question is whether the debaited query still says something, and an ASCII split erases a CJK
 * or Cyrillic query outright — which would silently deny the fan-out to exactly the users who
 * are not searching in English. Minimum length 2, because a CJK word routinely is two characters.
 */
// nodejs-mobile (TurboLLM's embedded Android runtime, Node 18.20.4 without full ICU data —
// see TurboLLM Android's PROVENANCE.md) can't even PARSE \p{...} Unicode-property regex
// syntax as a literal — that's a MODULE-LOAD-time parse failure there, not a catchable
// runtime error, and it crashed the whole daemon before any of its own code ran (confirmed
// live on a real emulator run, 2026-09-03). Built via `new RegExp(string)` instead of a
// literal so an unsupported runtime throws a normal, catchable SyntaxError right here
// instead of failing to parse the entire file. The ASCII fallback deliberately mirrors
// tokenize()'s own (`\W` ~= `[^A-Za-z0-9_]`) rather than silently matching nothing — losing
// Unicode-awareness on that one runtime is an accepted, honest degradation, not a crash.
function tryUnicodeRegex(pattern: string, flags: string, asciiFallback: RegExp): RegExp {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return asciiFallback
  }
}

const WORD_SPLIT_RE = tryUnicodeRegex('[^\\p{L}\\p{N}]+', 'u', /[^a-zA-Z0-9]+/)
const TRIM_PUNCT_RE = tryUnicodeRegex('^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$', 'gu', /^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g)

function substantiveTermCount(text: string): number {
  return text
    .toLowerCase()
    .split(WORD_SPLIT_RE)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t)).length
}

const QUERY_ONLY_BAIT: RegExp[] = [
  /\bwhich\b/gi,
  /\bshould\s+(you|i|we)\b/gi,
  /\b(19|20)\d{2}\b/g,
]

/**
 * Rewrite an aggregator-shaped question into the substantive terms underneath it, or return
 * null when there is no bait to strip.
 *
 * Re-ranking can only reorder what the provider returned, and for a listicle-shaped question the
 * entire top-10 can be roundups — measured. A human researcher reformulates at that point, so we
 * do the same mechanically: "best opensource LLMs I can use with 16gb vram" is phrasing that
 * ranks roundups, while the same question without "best" ranks documentation and specs. Universal
 * by construction, because it strips the same vocabulary the roundup detector already knows:
 * "best mattress for back pain" → "mattress for back pain", "top 10 exercises for lower back
 * pain ranked" → "exercises for lower back pain".
 *
 * Only the bait is removed. Ordinary filler ("that I can use with") is left alone deliberately —
 * search providers already discount it, and shredding a query into keywords risks changing what
 * was asked, which is the one thing a reformulation must not do.
 */
export function debaitQuery(query: string): string | null {
  if (typeof query !== 'string' || !query.trim()) return null

  // Same exemptions the penalty uses: "best practices" is documentation language and a
  // systematic/literature review is a primary source, so neither is bait worth stripping —
  // and stripping it would actively corrupt the query ("systematic review of statins").
  const lower = query.toLowerCase()
  if (AGGREGATOR_EXEMPTIONS.some((re) => re.test(lower))) return null

  // Detection uses the FULL pattern set but deletion only the deletable subset, so a
  // `which … should you` question still qualifies for a reformulation without its subject being
  // swallowed by the span match. A query carrying no roundup vocabulary at all is already the
  // substantive form: its pool is the pool we want, and a second call would just burn a request.
  if (!AGGREGATOR_PATTERNS.some((re) => re.test(lower))) return null

  let out = query
  for (const re of AGGREGATOR_BAIT) {
    // The shared patterns are stored unflagged (aggregatorPenalty only tests them); rebuild each
    // as a fresh global/case-insensitive copy so there is no shared lastIndex to leak between calls.
    out = out.replace(new RegExp(re.source, 'gi'), ' ')
  }
  // Gated behind the bait check on purpose. A year is only noise NEXT TO roundup vocabulary
  // ("Best Mattresses 2026"); on its own it is usually the whole point of the question, and
  // turning "who won the 1974 World Cup" into "who won the World Cup" would be a regression.
  for (const re of QUERY_ONLY_BAIT) out = out.replace(re, ' ')

  // Collapse the holes left behind, then trim leading/trailing punctuation the bait was attached
  // to ("Best: mattresses?" → "mattresses"). Unicode-aware so non-Latin queries survive intact.
  out = out.replace(/\s+/g, ' ').trim().replace(TRIM_PUNCT_RE, '').trim()

  if (!out || out.toLowerCase() === query.trim().toLowerCase()) return null
  // Under two substantive terms there is nothing left to retrieve on — "best of 2026" reduces to
  // noise, and searching noise costs a provider call for results that cannot outrank the primary.
  if (substantiveTermCount(out) < 2) return null
  return out
}

/**
 * Composite source-quality term that replaces the raw domainScore inside the existing
 * 0.3 weight. Kept as one term on purpose: re-weighting the whole formula is a larger,
 * riskier change than this fix warrants.
 */
export function sourceQuality(query: string, title: string, url: string, intent?: string): number {
  let base: number
  try {
    base = domainScore(url)
  } catch {
    // domainScore parses the URL and can throw on malformed input; a bad URL should cost a
    // result its ranking, not abort scoring for the whole result set.
    base = 0.5
  }
  return clamp(
    base + officialSourceBoost(query, url) + officialDocsBoost(url) - aggregatorPenalty(title, url, intent),
    0.1,
    1.0,
  )
}

// ── Passage extraction ────────────────────────────────────────────────────────

/**
 * Tie-break rank for equally-scoring sentences: a markdown heading restates the
 * question, a dated sentence usually carries the answer. Higher wins.
 */
function passagePriority(sentence: string): number {
  const s = sentence.trim()
  let rank = 0
  if (/^#{1,6}\s/.test(s)) rank -= 2 // markdown heading
  if (/\b(19|20)\d{2}\b/.test(s)) rank += 1 // carries a year / absolute date
  return rank
}

/**
 * Excerpt budget. ADR-230 makes Research quality-first: one sentence per result left the
 * model with ~150 words to answer from, so it fell back on training data — the exact
 * failure F-021 exists to prevent. At ~1200 chars, 8 results is ~10k chars / ~2.5k tokens
 * per search: generous, but still safe for several searches on a 32k-context model.
 */
export const MAX_PASSAGE_CHARS = 1200

/** A sentence opening with a pronoun or a connective refers back to the one before it, so on
 *  its own it is unreadable — those are the cases where a preceding sentence earns its budget. */
const REFERENTIAL_OPENER =
  /^(in addition|as a result|for example|for instance|it|this|that|these|those|they|he|she|its|their|his|her|there|such|however|but|and|so|then|also|additionally|moreover|furthermore|instead|meanwhile|therefore|thus|yet|still)\b/i

function needsPrecedingContext(sentence: string): boolean {
  const s = sentence.trim()
  // Too short to stand alone, starts mid-thought, or explicitly refers backwards.
  return s.length < 120 || REFERENTIAL_OPENER.test(s) || /^[a-z]/.test(s)
}

/**
 * Return an excerpt of `content` centred on the sentence with the highest keyword overlap
 * against `query`, expanded to neighbouring sentences up to MAX_PASSAGE_CHARS.
 * Falls back to the first MAX_PASSAGE_CHARS if no sentence boundary is found.
 *
 * Newlines are deliberately NOT stripped here: builtin.ts owns result-format sanitisation
 * (F-019) and collapses whitespace at render time, so this stays a pure text-selection step.
 */
export function extractPassage(query: string, content: string): string {
  if (!content) return ''

  // Split on sentence-ending punctuation followed by whitespace or end of string
  const sentences = content.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0)
  if (sentences.length <= 1) {
    // No clear sentence boundaries — take the budget's worth
    return content.slice(0, MAX_PASSAGE_CHARS)
  }

  let bestIdx = 0
  let bestScore = keywordOverlap(query, sentences[0])
  for (let i = 1; i < sentences.length; i++) {
    const s = keywordOverlap(query, sentences[i])
    if (s > bestScore || (s === bestScore && passagePriority(sentences[i]) > passagePriority(sentences[bestIdx]))) {
      bestScore = s
      bestIdx = i
    }
  }

  const best = sentences[bestIdx].trim()
  if (best.length >= MAX_PASSAGE_CHARS) return best.slice(0, MAX_PASSAGE_CHARS)

  // Grow a window around the best sentence: backwards first only when the sentence cannot
  // stand alone, then forwards (where the elaboration usually is), then backwards with
  // whatever budget is left over.
  let start = bestIdx
  let end = bestIdx
  let total = best.length

  const fits = (s: string): boolean => total + s.length + 1 <= MAX_PASSAGE_CHARS

  if (bestIdx > 0 && needsPrecedingContext(best)) {
    const prev = sentences[bestIdx - 1].trim()
    if (fits(prev)) {
      start = bestIdx - 1
      total += prev.length + 1
    }
  }
  while (end + 1 < sentences.length) {
    const next = sentences[end + 1].trim()
    if (!fits(next)) break
    end++
    total += next.length + 1
  }
  while (start > 0) {
    const prev = sentences[start - 1].trim()
    if (!fits(prev)) break
    start--
    total += prev.length + 1
  }

  return sentences.slice(start, end + 1).map((s) => s.trim()).join(' ')
}

// ── Freshness signal ───────────────────────────────────────────────────────────

/**
 * Normalise a provider-supplied date to 'YYYY-MM-DD', or undefined.
 * F-019: this value comes from remote content, so accept only a bare ISO calendar
 * date that also survives Date parsing — anything else is dropped, never passed on.
 */
export function normalizePublishedDate(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return undefined
  const [, y, mo, d] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d))
  const dt = new Date(ms)
  // Reject impossible calendar dates (e.g. 2026-02-31 rolling over into March).
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    return undefined
  }
  return `${y}-${mo}-${d}`
}

/** Whole days between an ISO date and `now`. Future dates clamp to 0. */
export function ageInDays(isoDate: string, now: number = Date.now()): number | undefined {
  const normalized = normalizePublishedDate(isoDate)
  if (!normalized) return undefined
  const published = Date.parse(`${normalized}T00:00:00Z`)
  if (Number.isNaN(published)) return undefined
  return Math.max(0, Math.floor((now - published) / 86_400_000))
}

/**
 * Weak prose hint used only when the provider gave us no publish date: the newest
 * year mentioned in the snippet. Never authoritative — a page can quote any year.
 */
function yearMentionHint(content: string): 'recent' | 'dated' | 'unknown' {
  const yearMatches = content.match(/\b(20\d{2})\b/g)
  if (!yearMatches) return 'unknown'
  const currentYear = new Date().getFullYear()
  const maxYear = Math.max(...yearMatches.map(Number))
  if (maxYear >= currentYear - 1) return 'recent'
  if (maxYear <= currentYear - 3) return 'dated'
  return 'unknown'
}

/**
 * Recency label from the real publish date when we have one, at any `freshness`
 * setting — the model has no other way to tell how old a result is.
 * With no date we report 'unknown' rather than guessing from prose: the year a
 * snippet happens to mention says nothing reliable about when it was published.
 */
/**
 * Multiplier applied to a result's score when the caller asked for `freshness: 'current'`.
 * Never zero: an old page can still be the best available answer, and hard-filtering by age
 * would silently hide the only source on a niche question. Topic-agnostic — "the user wants
 * current information" means the same thing for interest rates, medical guidance and sport.
 */
export function currentnessMultiplier(ageDays: number): number {
  if (ageDays <= FRESH_MAX_AGE_DAYS) return 1
  if (ageDays <= 365) return 0.85
  if (ageDays <= DATED_MIN_AGE_DAYS) return 0.65
  return 0.45
}

export function freshnessSignal(ageDays?: number): 'recent' | 'dated' | 'unknown' {
  if (ageDays === undefined) return 'unknown'
  if (ageDays <= FRESH_MAX_AGE_DAYS) return 'recent'
  if (ageDays >= DATED_MIN_AGE_DAYS) return 'dated'
  return 'unknown'
}

/**
 * Freshness component of the composite score.
 * Default/'any' stays flat-neutral so ranking is byte-identical to pre-date behaviour
 * (the conservative default). Only `freshness: 'current'` actually penalises age,
 * which is what F-021 decided and what the tool description promises the model.
 */
function freshnessScore(ageDays: number | undefined, content: string, freshness?: 'current' | 'any'): number {
  if (freshness !== 'current') return 0.5 // neutral

  if (ageDays !== undefined) {
    if (ageDays <= FRESH_MAX_AGE_DAYS) return 1
    if (ageDays <= 180) return 0.6
    if (ageDays <= 365) return 0.4
    if (ageDays < DATED_MIN_AGE_DAYS) return 0.2
    return 0.1
  }

  // No date: nudge only. Kept inside 0.45–0.6 so a dateless result never sinks
  // below a genuinely fresh one or outranks it on prose alone.
  const hint = yearMentionHint(content)
  if (hint === 'recent') return 0.6
  if (hint === 'dated') return 0.45
  return 0.5
}

// ── Deduplication ─────────────────────────────────────────────────────────────
//
// Providers routinely return the same page more than once — measured live: one bank's site held
// ranks 3 AND 6 with an identical date, another took ranks 1 AND 2. On an 8-result budget that is
// up to a quarter of the model's context spent re-reading a page it has already read, and the
// distinct source that would have filled the slot is never seen. Deduping the raw pool *before*
// scoring is what makes the 8 surfaced results 8 distinct pages.

/** Query params that identify a campaign or a referrer rather than a page. Only these are
 *  dropped: for a great many sites (search results, article ids, product variants, pagination)
 *  the query string IS the page identity, so blanket-stripping it would merge distinct pages. */
const TRACKING_PARAMS =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|referrer|source)$/i

/**
 * Canonical identity key for a URL. Deliberately not a valid URL — it exists only to answer
 * "are these two results the same page?".
 *
 * Scheme is dropped entirely (http and https serve one page and providers mix them), as is a
 * leading "www.", the fragment (same document, different anchor) and any trailing slash.
 * Remaining params are kept but sorted, since their order is not part of a page's identity.
 */
export function normalizeUrlIdentity(url: string): string {
  const raw = String(url ?? '').trim()
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key)
    }
    u.searchParams.sort()
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    const qs = u.searchParams.toString()
    return `${host}${path}${qs ? `?${qs}` : ''}`
  } catch {
    // Unparseable input still deserves exact-match dedupe rather than being dropped.
    return raw.toLowerCase()
  }
}

/** Whitespace/case-insensitive headline identity. */
function normalizeTitleIdentity(title: string): string {
  return String(title ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Which copy of a duplicated page to keep. NOT "the first one seen": a publish date is the
 * scarcer signal (freshness ranking and the `current` constraint both depend on it, and the
 * backfill pass downstream costs a page fetch to recover one), and after that more content
 * simply means more for extractPassage to work with.
 */
function isBetterDuplicate(candidate: SearchResult, incumbent: SearchResult): boolean {
  const candidateDated = !!candidate.publishedDate
  const incumbentDated = !!incumbent.publishedDate
  if (candidateDated !== incumbentDated) return candidateDated
  return (candidate.content?.length ?? 0) > (incumbent.content?.length ?? 0)
}

/** Collapse groups sharing a key, keeping the best member of each in the position the group
 *  first appeared. A null key means "never a duplicate" and passes straight through. */
function collapseBy(
  results: SearchResult[],
  keyOf: (r: SearchResult) => string | null,
): SearchResult[] {
  const seenAt = new Map<string, number>()
  const out: SearchResult[] = []
  for (const r of results) {
    const key = keyOf(r)
    if (key === null) {
      out.push(r)
      continue
    }
    const at = seenAt.get(key)
    if (at === undefined) {
      seenAt.set(key, out.length)
      out.push(r)
    } else if (isBetterDuplicate(r, out[at])) {
      out[at] = r
    }
  }
  return out
}

/**
 * Remove duplicate pages from a raw provider pool, preserving provider order otherwise.
 * Two passes, because the same page hides behind two different disguises.
 */
export function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  // 1. Same URL once normalised — the tracking-param / scheme / www / trailing-slash variants.
  const byUrl = collapseBy(results, (r) => (r?.url ? normalizeUrlIdentity(r.url) : null))

  // 2. Same site AND same headline at different paths. This is the ordinary CMS shape (an article
  //    reachable via its section route, its dated permalink and an AMP/print copy), which the URL
  //    pass cannot catch. Scoped to one host on purpose: two different outlets legitimately publish
  //    under the same headline, and those are genuinely two sources.
  return collapseBy(byUrl, (r) => {
    const title = normalizeTitleIdentity(r?.title ?? '')
    if (!title) return null
    return `${extractDomain(r.url ?? '')}\u0000${title}`
  })
}

// ── Main research function ────────────────────────────────────────────────────

/**
 * Run a web search via the configured provider — plus, when the question is aggregator-shaped,
 * one concurrent debaited reformulation — then dedupe the merged pool and deterministically
 * score, rank, filter (≥0.4) and cap (top MAX_RESULTS) the results. Returns ResearchResult[].
 * Returns [] if the provider is not configured or the primary search fails.
 */
export async function research(
  q: ResearchQuery,
  cfg: SearchConfig,
  fetchImpl?: FetchImpl,
): Promise<ResearchResult[]> {
  if (!searchConfigured(cfg)) return []

  const client = searchProviderClient(cfg, fetchImpl)
  if (!client) return []

  // Only ask the provider to restrict by recency when the caller explicitly wants
  // current results — otherwise the request is exactly what it was before.
  const opts = q.freshness === 'current' ? { recent: true } : undefined

  // Fan-out: at most ONE extra call, and only when the question is aggregator-shaped and there is
  // something substantive left after debaiting. Concurrent, so latency is one round-trip either
  // way, and best-effort — a failed reformulation must never cost the user their search.
  const debaited = debaitQuery(q.query)
  const primaryCall = client.search(q.query, MAX_SEARCH_RESULTS, opts).then(
    (r) => r,
    () => null, // null distinguishes "the search failed" from "the search found nothing".
  )
  const extraCall: Promise<SearchResult[]> = debaited
    ? client.search(debaited, MAX_SEARCH_RESULTS, opts).catch(() => [])
    : Promise.resolve([])

  const [primaryRaw, extraRaw] = await Promise.all([primaryCall, extraCall])
  if (primaryRaw === null) return []

  // Dedupe before scoring, so the MAX_RESULTS slots are spent on MAX_RESULTS distinct pages.
  // The primary pool goes first: on a tie the reformulation is the fallback, not the answer.
  const raw = dedupeSearchResults([...primaryRaw, ...extraRaw])

  const now = Date.now()
  // Every result is scored against the ORIGINAL question, including the ones the reformulation
  // found: the debaited query is a retrieval device, not a restatement of what was asked.
  const scored: ResearchResult[] = raw.map((r) => {
    const domain = extractDomain(r.url)
    const text = `${r.title} ${r.content}`
    const kwScore = keywordOverlap(q.query, text)
    // Composite source quality replaces the raw domain score: keyword overlap is the signal
    // SEO pages optimise hardest, so the counterweight has to live in the term that can tell
    // a first-party source from a page shaped like one.
    const sq = sourceQuality(q.query, r.title, r.url, q.intent)
    const publishedDate = normalizePublishedDate(r.publishedDate)
    const ageDays = publishedDate ? ageInDays(publishedDate, now) : undefined
    const signal = freshnessSignal(ageDays)
    const fs = freshnessScore(ageDays, r.content, q.freshness)
    // Weighting (ADR-230 follow-up): keyword overlap was 0.5 and source quality 0.3, which let
    // SEO/listicle pages win — they are engineered to match the user's exact phrasing, so the
    // term they game carried more weight than the term that can tell a first-party source from
    // a page merely shaped like one. Measured on a real query, a 0.20 aggregator penalty moved
    // the final score by only 0.06 and a content farm stayed at rank 2. Shifting 0.15 from
    // keyword to source makes that penalty worth 0.09 and the official-source boost 0.11 —
    // enough to actually reorder. Keyword overlap still leads on topical relevance; it just no
    // longer outvotes provenance.
    // NOTE: the `freshness:'current'` age constraint is NOT applied here. Providers seldom
    // return dates on general search, so at this point most ages are unknown; it is applied
    // once in execWebSearch after dates have been read off the pages themselves, against the
    // full set of known ages. Applying it in both places would double-penalise.
    const relevanceScore = 0.35 * kwScore + 0.45 * sq + 0.2 * fs
    const passage = extractPassage(q.query, r.content)

    return {
      url: r.url,
      title: r.title,
      passage,
      relevanceScore: Math.round(relevanceScore * 1000) / 1000,
      freshnessSignal: signal,
      domain,
      publishedDate,
      ageDays,
    }
  })

  return scored
    .filter((r) => r.relevanceScore >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_RESULTS)
}
