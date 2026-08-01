// Anthropic SERVER-SIDE tools (`web_search_*` / `web_fetch_*`) for the gateway.
//
// ── Why this exists (founder-reported: "web search fails in the claude cli") ────────────────
// Claude Code's WebSearch tool is NOT a client-side tool it executes itself. It executes by
// issuing a SECOND, nested `/v1/messages` request back at whatever `ANTHROPIC_BASE_URL` points
// at — i.e. at US — declaring a server tool and expecting the PROVIDER to run the search and
// hand back the results as content blocks. Read straight out of the shipped CLI (2.1.220):
//
//     let c = zr({ content: "Perform a web search for the query: " + s }),
//         u = { type:"web_search_20250305", name:"web_search",
//               allowed_domains:e.allowed_domains, blocked_domains:e.blocked_domains, max_uses:8 }
//     let f = fpr({ messages:[c], systemPrompt: dp(["You are an assistant for performing …"]), … })
//
// …and it then reads the reply back looking for exactly one block type:
//
//     if (a.type === "web_search_tool_result") {
//       if (s++, !Array.isArray(a.content)) { `Web search error: ${a.content.error_code}` }
//       let l = a.content.map((c) => ({ title: c.title, url: c.url }))
//       n.push({ tool_use_id: a.tool_use_id, content: l })
//     }
//     if (a.type === "text") o += a.text
//     return { query:t, results:n, durationSeconds:r, searchCount: Math.max(i,s) }
//
// A server tool carries a `type` and NO `input_schema`. `mapToOpenAI` reads every `tools` entry
// as a client function tool (`t.name` + `t.input_schema`), so before this module the server tool
// was forwarded to llama.cpp as a function with `parameters: undefined`, the local model emitted
// a plain `tool_use` with an EMPTY input, and no `web_search_tool_result` block ever came back.
// Measured live against the real CLI: `{"query":"hono npm latest version","results":[],
// "durationSeconds":1.09,"searchCount":0}` — a silent empty success, the worst failure shape
// available, because the model is told nothing went wrong and answers from stale memory instead.
//
// ── Why the local model is deliberately NOT in this loop ────────────────────────────────────
// The faithful reading of the protocol would be to hand the model a real `web_search` function,
// let it emit a call, run it, feed the result back, and loop until it stops. That is strictly
// worse here: the nested request's ENTIRE content is "Perform a web search for the query: X", so
// the query is already known — running a 35B local model one-to-three extra times to re-derive a
// string we were literally handed adds tens of seconds per search and stakes the whole feature on
// a weak model reliably emitting a well-formed tool call. This module answers the nested request
// directly from TurboLLM's own configured search provider (the SAME Tavily/Kagi/SearXNG client and
// the SAME deterministic ranking the in-app agent uses, tools/research-service.ts), which makes a
// search one provider round-trip and removes the model from the failure surface entirely.
import { randomUUID } from 'node:crypto'
import type { SearchConfig } from '../config/config'
import { research, type ResearchResult } from '../tools/research-service'
import { searchConfigured } from '../tools/search-providers'
import type { AnthropicRequest } from './anthropic'

/** The fixed prefix Claude Code wraps the query in for the nested request (see the header). */
export const WEB_SEARCH_PROMPT_PREFIX = 'Perform a web search for the query: '

/** How many ranked results are handed back for one search. Matches `max_uses: 8`, which is what
 *  the CLI itself asks for, and MAX_RESULTS in research-service.ts, which is the cap the ranking
 *  pipeline already applies — so this never truncates anything the ranker meant to keep. */
const MAX_SEARCH_RESULTS = 8

/** A server-tool declaration recognised in a request's `tools` array. */
export interface ServerToolSpec {
  /** Which server tool this is, independent of the dated `type` variant it arrived as. */
  kind: 'web_search' | 'web_fetch'
  /** The tool's own name (`web_search` / `web_fetch`) — echoed back on the `server_tool_use` block. */
  name: string
  /** Hostnames the caller restricted the search to. */
  allowedDomains?: string[]
  /** Hostnames the caller excluded. */
  blockedDomains?: string[]
}

/** Matches every dated variant of the two web server tools — `web_search_20250305`,
 *  `web_search_20260209`, `web_fetch_20250910`, `web_fetch_20260209`, and any later date stamp.
 *  Matching the FAMILY rather than an enumerated list is deliberate: Anthropic ships a new dated
 *  variant whenever the tool's options change, and a client that upgrades to one we haven't
 *  enumerated would silently fall back to the exact broken empty-results path this module exists
 *  to remove. All variants share the request shape this module depends on (a `type`, a `name`,
 *  optional domain filters), so treating an unknown future date as "the same tool" degrades far
 *  better than treating it as "not a server tool at all". */
const SERVER_TOOL_TYPE = /^(web_search|web_fetch)_\d{8}$/

/** Whether this request is the CLI's own nested SEARCH call, rather than an ordinary agentic turn
 *  that merely happens to declare a web-search server tool alongside its real tools.
 *
 *  The distinction was missed in the first version and caught in pre-release review: intercepting
 *  on "a `web_search_*` tool is present" hijacks any request that declares one, answering it with
 *  raw search results and never reaching the model at all. A client is entitled to offer the model
 *  web search as ONE capability among many.
 *
 *  The nested call is unambiguous — read out of the shipped CLI, it is built as
 *  `{ messages:[one user turn], tools:[the single server tool] }`. So the test is: the server tool
 *  is the ONLY tool on the request. An agentic turn always carries client function tools too
 *  (Read/Bash/Edit…), so it can never satisfy this, and the search request always does. */
export function isNestedSearchRequest(tools: AnthropicRequest['tools']): boolean {
  const all = tools ?? []
  if (all.length !== 1) return false
  return findServerTool(all) !== null
}

/** Find the first `web_search_*` / `web_fetch_*` server tool declared in a request, or null.
 *  A server tool is identified by its `type` — client function tools carry `input_schema` and no
 *  `type` at all, so the two can never be confused. */
export function findServerTool(tools: AnthropicRequest['tools']): ServerToolSpec | null {
  for (const t of tools ?? []) {
    const raw = t as unknown as {
      type?: string; name?: string; allowed_domains?: unknown; blocked_domains?: unknown
    }
    const m = typeof raw.type === 'string' ? SERVER_TOOL_TYPE.exec(raw.type) : null
    if (!m) continue
    return {
      kind: m[1] as 'web_search' | 'web_fetch',
      name: typeof raw.name === 'string' && raw.name ? raw.name : m[1],
      allowedDomains: stringList(raw.allowed_domains),
      blockedDomains: stringList(raw.blocked_domains),
    }
  }
  return null
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return out.length ? out : undefined
}

/** Pull the search query out of the nested request. The CLI sends exactly one user message whose
 *  whole content is `WEB_SEARCH_PROMPT_PREFIX + query`, so the prefix is stripped when present;
 *  when it isn't (a different client, or a future CLI that reworded it) the message text is used
 *  as-is rather than returning nothing — a slightly-off query still beats zero results, which is
 *  the bug being fixed. Reads the LAST user message so a client that adds context turns still
 *  resolves to the query it just asked for. */
export function extractSearchQuery(req: AnthropicRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i]
    if (msg.role !== 'user') continue
    const text = (typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n')
    ).trim()
    if (!text) continue
    return text.startsWith(WEB_SEARCH_PROMPT_PREFIX)
      ? text.slice(WEB_SEARCH_PROMPT_PREFIX.length).trim()
      : text
  }
  return ''
}

/** Collapse untrusted page text to a single line. Titles and passages are attacker-controlled
 *  (they are whatever a fetched page says), and they are rendered into a line-oriented text block
 *  below — the exact forgery `builtin.ts`'s own `oneLine` exists to prevent, applied here for the
 *  same reason: without it a page whose title contains newlines can emit its own `[N] …/Source: …`
 *  block and pass itself off as a separate, differently-sourced result. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Whether a result's host passes the caller's domain filters. Compared on the registrable-ish
 *  suffix (`endsWith('.' + d)`) so `allowed_domains: ["npmjs.com"]` keeps `www.npmjs.com`, with
 *  the leading dot making sure `evilnpmjs.com` does NOT sneak through a bare `endsWith`. */
export function domainAllowed(url: string, spec: ServerToolSpec): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return false // unparseable URL — never let it through a filter it can't be checked against
  }
  const matches = (d: string) => {
    const t = d.toLowerCase().replace(/^www\./, '').replace(/^\./, '')
    return host === t || host.endsWith(`.${t}`)
  }
  if (spec.blockedDomains?.some(matches)) return false
  if (spec.allowedDomains?.length) return spec.allowedDomains.some(matches)
  return true
}

/** Anthropic error codes a `web_search_tool_result` may carry instead of a result array. The CLI
 *  branches on `Array.isArray(content)` and reports `content.error_code` when it isn't one, so an
 *  error surfaces to the model as a real "Web search error: <code>" rather than as zero results. */
export type WebSearchErrorCode = 'unavailable' | 'invalid_input' | 'too_many_requests' | 'max_uses_exceeded'

/** Build the `web_search_tool_result` + `server_tool_use` pair plus the human-readable text block.
 *  Exported so the whole response shape is unit-testable without a search provider or a model. */
export function buildWebSearchBlocks(
  query: string,
  results: ResearchResult[],
  error?: { code: WebSearchErrorCode; message: string },
): unknown[] {
  const toolUseId = `srvtoolu_${randomUUID().replace(/-/g, '')}`
  const blocks: unknown[] = [
    { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: { query } },
  ]

  if (error) {
    blocks.push({
      type: 'web_search_tool_result',
      tool_use_id: toolUseId,
      // Object, not array — this is exactly the shape the CLI's `!Array.isArray(content)` branch
      // reads `error_code` off of.
      content: { type: 'web_search_tool_result_error', error_code: error.code },
    })
    blocks.push({ type: 'text', text: error.message })
    return blocks
  }

  blocks.push({
    type: 'web_search_tool_result',
    tool_use_id: toolUseId,
    content: results.map((r) => ({
      type: 'web_search_result',
      title: oneLine(r.title) || r.domain,
      url: r.url,
      ...(r.publishedDate ? { page_age: r.publishedDate } : {}),
    })),
  })

  // The structured block above carries ONLY title+url — that is all the CLI keeps from it
  // (`a.content.map((c) => ({title: c.title, url: c.url}))`), so the actual substance has to
  // travel in a text block, which the CLI concatenates and passes through verbatim. Without this
  // the model would get a list of links and no content, and would have to fetch every one to
  // learn anything.
  blocks.push({ type: 'text', text: renderResultsText(query, results) })
  return blocks
}

/** The text block: a compact, ranked digest with a real excerpt per source. Mirrors the shape
 *  `builtin.ts`'s `execWebSearch` renders for the in-app agent so a model sees the same format
 *  whichever agent it is driving. */
function renderResultsText(query: string, results: ResearchResult[]): string {
  if (results.length === 0) {
    return `No results found for "${oneLine(query)}".`
  }
  // System date, read per render — never captured at module load, since a daemon can run for weeks
  // and a frozen "Retrieved:" stamp would quietly tell the model that today's results are old. UTC,
  // matching builtin.ts's `todayIso()`, so it is comparable with the providers' own publish dates.
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    `RESEARCH RESULTS (${results.length} ranked results for "${oneLine(query)}"):`,
    `Retrieved: ${today} — this search ran today, so treat ${today} as the current date. ` +
      'Weigh each result against its Published date; "unknown" means the source reported no date, not that it is current.',
  ]
  for (const [i, r] of results.entries()) {
    lines.push(`\n[${i + 1}] ${oneLine(r.title)}`)
    lines.push(`Source: ${r.url}`)
    lines.push(
      `Domain: ${r.domain} | Relevance: ${r.relevanceScore.toFixed(2)} | ` +
        `Freshness: ${r.freshnessSignal} | Published: ${r.publishedDate ?? 'unknown'}`,
    )
    lines.push(`Key passage: ${oneLine(r.passage)}`)
  }
  return lines.join('\n').trim()
}

/** Run the search behind a `web_search_*` server tool and return the Anthropic content blocks the
 *  caller should answer the nested request with. Never throws: every failure path resolves to an
 *  error-shaped `web_search_tool_result`, because a thrown error here would surface to the CLI as
 *  the same empty-results silence this module exists to eliminate. */
export async function runWebSearchServerTool(
  query: string,
  spec: ServerToolSpec,
  searchCfg: SearchConfig | undefined,
): Promise<unknown[]> {
  if (!query.trim()) {
    return buildWebSearchBlocks(query, [], {
      code: 'invalid_input',
      message: 'No search query was provided.',
    })
  }
  if (!searchCfg || !searchConfigured(searchCfg)) {
    return buildWebSearchBlocks(query, [], {
      code: 'unavailable',
      // Actionable on purpose: the single most likely reason a TurboLLM user sees no results is
      // that they never set a provider key, and "unavailable" alone would send them hunting
      // through the CLI rather than to the one screen that fixes it.
      message:
        'Web search is unavailable: no search provider is configured in TurboLLM ' +
        '(Settings → Tools → Web search). You cannot search the web on this turn — answer from ' +
        'your own knowledge and say plainly that you could not search, rather than inventing sources.',
    })
  }

  let results: ResearchResult[]
  try {
    results = await research({ query, freshness: 'any' }, searchCfg)
  } catch (e) {
    return buildWebSearchBlocks(query, [], {
      code: 'unavailable',
      message: `Web search failed: could not reach the ${searchCfg.provider} search provider — ${(e as Error).message}`,
    })
  }

  const filtered = results.filter((r) => domainAllowed(r.url, spec)).slice(0, MAX_SEARCH_RESULTS)
  return buildWebSearchBlocks(query, filtered)
}

/** Assemble the full non-streaming Anthropic message for an intercepted server-tool request. */
export function serverToolMessage(modelName: string, blocks: unknown[]): Record<string, unknown> {
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: modelName,
    content: blocks,
    stop_reason: 'end_turn',
    stop_sequence: null,
    // No engine ran, so there is genuinely nothing to report here. Reported as zeros rather than
    // omitted: Claude Code sums the usage fields to size its context meter and errors on absent
    // ones, and inventing plausible-looking counts would corrupt the durable api_usage totals.
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

/** The same response as SSE, for a client that asked for `stream: true`. The nested search request
 *  is issued through the same streaming path as any other turn, so this is the common case, not an
 *  edge case. Emits each block whole (a `content_block_start` carrying the finished block, then an
 *  immediate `content_block_stop`) rather than as deltas — every block here is already fully known
 *  before the first byte is written, and the Anthropic SDK assembles start+stop into the identical
 *  final message it would build from a delta stream. */
export function* serverToolSseEvents(
  modelName: string,
  blocks: unknown[],
): Generator<{ event: string; data: string }> {
  const msgId = `msg_${randomUUID().replace(/-/g, '')}`
  const ev = (event: string, data: Record<string, unknown>) => ({
    event,
    data: JSON.stringify({ type: event, ...data }),
  })

  yield ev('message_start', {
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelName,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  for (const [index, block] of blocks.entries()) {
    yield ev('content_block_start', { index, content_block: block })
    // A text block must also arrive as a delta: the SDK accumulates `text` from `text_delta`
    // events and would otherwise assemble an EMPTY string for it, dropping the entire digest
    // while the structured result block still arrived — search "working" but with no content.
    const b = block as { type?: string; text?: string }
    if (b.type === 'text' && b.text) {
      yield ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    }
    yield ev('content_block_stop', { index })
  }

  yield ev('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 0, output_tokens: 0 },
  })
  yield ev('message_stop', {})
}
