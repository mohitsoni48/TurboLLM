// F-021: deterministic retrieval service.
// Wraps the pluggable search provider (F-020) and scores/ranks/filters results
// without any LLM calls — pure string/math, fully testable.
import { searchProviderClient, searchConfigured, type SearchConfig, type FetchImpl } from './search-providers.js'

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
const MAX_RESULTS = 5
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
 * Return the sentence in `content` with the highest keyword overlap against `query`.
 * Falls back to the first 200 chars if no sentence boundary found.
 */
export function extractPassage(query: string, content: string): string {
  if (!content) return ''

  // Split on sentence-ending punctuation followed by whitespace or end of string
  const sentences = content.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0)
  if (sentences.length <= 1) {
    // No clear sentence boundaries — use first 200 chars
    return content.slice(0, 200)
  }

  let bestSentence = sentences[0]
  let bestScore = keywordOverlap(query, sentences[0])
  for (let i = 1; i < sentences.length; i++) {
    const s = keywordOverlap(query, sentences[i])
    if (s > bestScore || (s === bestScore && passagePriority(sentences[i]) > passagePriority(bestSentence))) {
      bestScore = s
      bestSentence = sentences[i]
    }
  }
  return bestSentence.trim()
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
function freshnessSignal(ageDays?: number): 'recent' | 'dated' | 'unknown' {
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

// ── Main research function ────────────────────────────────────────────────────

/**
 * Run a web search via the configured provider, then deterministically score,
 * rank, filter (≥0.4), and cap (top 5) the results. Returns ResearchResult[].
 * Returns [] if the provider is not configured.
 */
export async function research(
  q: ResearchQuery,
  cfg: SearchConfig,
  fetchImpl?: FetchImpl,
): Promise<ResearchResult[]> {
  if (!searchConfigured(cfg)) return []

  const client = searchProviderClient(cfg, fetchImpl)
  if (!client) return []

  let raw
  try {
    // Only ask the provider to restrict by recency when the caller explicitly wants
    // current results — otherwise the request is exactly what it was before.
    raw = await client.search(q.query, MAX_SEARCH_RESULTS, q.freshness === 'current' ? { recent: true } : undefined)
  } catch {
    return []
  }

  const now = Date.now()
  const scored: ResearchResult[] = raw.map((r) => {
    const domain = extractDomain(r.url)
    const text = `${r.title} ${r.content}`
    const kwScore = keywordOverlap(q.query, text)
    const ds = domainScore(r.url)
    const publishedDate = normalizePublishedDate(r.publishedDate)
    const ageDays = publishedDate ? ageInDays(publishedDate, now) : undefined
    const signal = freshnessSignal(ageDays)
    const fs = freshnessScore(ageDays, r.content, q.freshness)
    const relevanceScore = 0.5 * kwScore + 0.3 * ds + 0.2 * fs
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
