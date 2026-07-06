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
      'Results are pre-ranked by relevance — each entry includes a relevanceScore (0–1), a key passage, and a source URL.',
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
          description: 'Optional: "current" penalises results older than 90 days. Use for breaking news or time-sensitive queries.',
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

  const lines: string[] = [`RESEARCH RESULTS (${results.length} ranked results for "${query}"):`]
  for (const [i, r] of results.entries()) {
    lines.push(`\n[${i + 1}] ${r.title}`)
    lines.push(`Source: ${r.url}`)
    lines.push(`Domain: ${r.domain} | Relevance: ${r.relevanceScore.toFixed(2)} | Freshness: ${r.freshnessSignal}`)
    lines.push(`Key passage: ${r.passage}`)
  }
  return lines.join('\n').trim()
}

// ── Fetch URL ─────────────────────────────────────────────────────────────

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

  if (contentType.includes('text/html')) {
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

  // Truncate to ~4000 chars to fit comfortably in the context window
  if (content.length > 4000) content = content.slice(0, 4000) + '\n[truncated]'
  return content || '(empty response)'
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
