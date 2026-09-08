// Developer request log (issue #211 follow-up): "the log needs to show the actual request,
// response, and every sampling parameter, like LM Studio" — founder, after using the Monitor
// tab shipped in ADR-409/v1.12.5.
//
// Why this can't be the engine's own stderr log: verified live against a real llama.cpp log —
// every line is `slot print_timing` / `launch_slot_` / `release`. No prompt, no response, no
// `temperature`. TurboLLM supports 7+ engines with unrelated stderr formats, so LM Studio parity
// has to be captured at TurboLLM's OWN proxy layer (gateway.ts / chat-upstream.ts), which is
// engine-agnostic by construction — not scraped out of a process's stderr.
//
// In-memory only, by design (a founder decision this session, not an oversight): prompts and
// responses are the most sensitive data in the app. Nothing here is ever written to
// turbollm.db or sent to telemetry. The whole log is gone on daemon restart — an explicit
// Export button is the only way to keep one.
import { randomUUID } from 'node:crypto'
import type { Deps } from '../deps'
import type { RequestLogConfig } from '../config/config'

/** Fail-safe read of the request-log config off a live `Deps`. Falls back to "off" (never to
 *  "on") when `requestLog` is absent from the snapshot — a hand-built test `Deps` double that
 *  skips `config.ts`'s `normalize()`, or a config loaded before this field existed and read
 *  before normalize ran. Every capture site goes through this rather than reading
 *  `d.store.snapshot().requestLog` directly, so there is exactly one place this fallback lives. */
export function requestLogConfig(d: Deps): RequestLogConfig {
  return d.store.snapshot().requestLog ?? { enabled: false, captureBodies: false, maxEntries: 500 }
}

/** The exact sampling/generation params LM Studio-style logs show. A WHITELIST, not a dump of
 *  the raw request body — an unknown field (a future engine's own extension, a malformed client
 *  payload) is silently dropped rather than leaking arbitrary keys into a log a developer will
 *  copy-paste into a bug report. */
const PARAM_KEYS = [
  'temperature', 'top_p', 'top_k', 'min_p', 'max_tokens', 'max_completion_tokens',
  'presence_penalty', 'frequency_penalty', 'repeat_penalty', 'seed', 'stop',
  'reasoning_effort', 'response_format', 'tool_choice', 'n', 'logprobs',
] as const

export function extractParams(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!body) return out
  for (const key of PARAM_KEYS) {
    if (body[key] !== undefined) out[key] = body[key]
  }
  return out
}

/** Cheap shape summary — always captured, even with body logging off, so the list view has
 *  something to show ("12 messages, 3 tools, 480 system chars") without holding the bodies. */
export function summarizeRequest(body: Record<string, unknown> | null | undefined): RequestLogEntry['counts'] {
  const messages = Array.isArray(body?.messages) ? (body!.messages as unknown[]) : []
  const tools = Array.isArray(body?.tools) ? (body!.tools as unknown[]) : []
  let systemChars = 0
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown }
    if (msg?.role === 'system' && typeof msg.content === 'string') systemChars += msg.content.length
  }
  return { messages: messages.length, tools: tools.length, systemChars }
}

export type RequestSource = 'openai' | 'anthropic' | 'chat'

export interface RequestLogEntry {
  id: string
  ts: number
  source: RequestSource
  harness: string | null
  codeSessionId: string | null
  modelKey: string | null
  /** Turbo Link machine name when this generation was federated to another host; null for
   *  local. Mirrors the same `remote` distinction gateway.ts's usage recording already makes. */
  remote: string | null
  stream: boolean
  params: Record<string, unknown>
  counts: { messages: number; tools: number; systemChars: number }
  status: number | null
  error: { code: string; message: string } | null
  timings: { ttftMs: number | null; durationMs: number | null }
  tokens: { prompt: number; completion: number; promptTps: number | null; genTps: number | null }
  finishReason: string | null
  /** Only populated when `captureBodies` was on for this request. Kept as pre-serialized JSON
   *  strings (not parsed objects) so a huge Code turn's body counts toward the byte budget
   *  precisely, instead of an estimate on top of a live object graph. */
  bodies: { request: string; response: string } | null
}

/** What a capture call has in hand before the response is known — the entry is created here
 *  and finalized once the drain completes (or the request fails outright). */
export type RequestLogDraft = Pick<
  RequestLogEntry,
  'source' | 'harness' | 'codeSessionId' | 'modelKey' | 'remote' | 'stream' | 'params' | 'counts'
> & { requestBody?: string }

export interface RequestLogFinal {
  status: number | null
  error?: { code: string; message: string }
  ttftMs?: number | null
  durationMs?: number | null
  promptTokens?: number
  completionTokens?: number
  promptTps?: number | null
  genTps?: number | null
  finishReason?: string | null
  responseBody?: string
}

const DEFAULT_MAX_ENTRIES = 500
/** ~32 MB — generous enough for a long Code session with body capture on, small enough that a
 *  forgotten toggle can't grow the daemon's RSS without bound. Only bodies count against this;
 *  metadata-only entries are a few hundred bytes and effectively free against it. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

type Listener = (entry: RequestLogEntry) => void

/** A bounded, dual-capped (count AND bytes) in-memory log of every completion this daemon has
 *  proxied, plus a pub/sub hook for the live SSE stream. Structurally similar to
 *  `code/run-buffer.ts`'s `RingBuffer` (seq-numbered append log) but keyed by request id rather
 *  than session seq, and evicted by two limits instead of one — a body-capture session can hit
 *  the byte cap long before it hits the count cap. */
export class RequestLog {
  private entries: RequestLogEntry[] = []
  private bodyBytes = 0
  private listeners = new Set<Listener>()

  constructor(
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  /** Begin an entry (request known, response not yet). Returns the id to finalize later —
   *  never call this a second time for the same request; call `finalize` once the drain ends. */
  start(draft: RequestLogDraft): string {
    const id = randomUUID()
    const entry: RequestLogEntry = {
      id,
      ts: Date.now(),
      source: draft.source,
      harness: draft.harness,
      codeSessionId: draft.codeSessionId,
      modelKey: draft.modelKey,
      remote: draft.remote,
      stream: draft.stream,
      params: draft.params,
      counts: draft.counts,
      status: null,
      error: null,
      timings: { ttftMs: null, durationMs: null },
      tokens: { prompt: 0, completion: 0, promptTps: null, genTps: null },
      finishReason: null,
      bodies: draft.requestBody !== undefined ? { request: draft.requestBody, response: '' } : null,
    }
    this.append(entry)
    return id
  }

  /** Fill in the response half. A no-op if the id was already evicted (e.g. a `clear()` raced
   *  a slow drain) — fail-safe, same convention as `recordOpenAiStreamUsage` (gateway.ts). */
  finalize(id: string, result: RequestLogFinal): void {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return
    entry.status = result.status
    entry.error = result.error ?? null
    entry.timings = {
      ttftMs: result.ttftMs ?? entry.timings.ttftMs,
      durationMs: result.durationMs ?? entry.timings.durationMs,
    }
    entry.tokens = {
      prompt: result.promptTokens ?? entry.tokens.prompt,
      completion: result.completionTokens ?? entry.tokens.completion,
      promptTps: result.promptTps ?? entry.tokens.promptTps,
      genTps: result.genTps ?? entry.tokens.genTps,
    }
    entry.finishReason = result.finishReason ?? entry.finishReason
    if (entry.bodies && result.responseBody !== undefined) {
      this.bodyBytes -= byteLen(entry.bodies.response)
      entry.bodies.response = result.responseBody
      this.bodyBytes += byteLen(result.responseBody)
      this.evictToByteBudget()
    }
    this.notify(entry)
  }

  private append(entry: RequestLogEntry): void {
    this.entries.push(entry)
    if (entry.bodies) this.bodyBytes += byteLen(entry.bodies.request) + byteLen(entry.bodies.response)
    while (this.entries.length > this.maxEntries) this.evictOldest()
    this.evictToByteBudget()
    this.notify(entry)
  }

  /** Every capture site calls `start`/`finalize` directly, mostly OUTSIDE their own try/catch
   *  (the whole point is to observe a request without perturbing it) — a listener that throws
   *  must never propagate out of here. Left unguarded, it would either break the real request
   *  the caller is actually serving, or (worse, in gateway.ts/chat-upstream.ts's `.catch`-style
   *  fallback finalizers) re-enter `finalize` and overwrite a just-recorded SUCCESS with a
   *  spurious "drain failed" error. */
  private notify(entry: RequestLogEntry): void {
    for (const fn of this.listeners) {
      try { fn(entry) } catch { /* a subscriber's own bug must never affect the capture site */ }
    }
  }

  private evictToByteBudget(): void {
    while (this.bodyBytes > this.maxBytes && this.entries.length > 0) this.evictOldest()
  }

  private evictOldest(): void {
    const gone = this.entries.shift()
    if (gone?.bodies) this.bodyBytes -= byteLen(gone.bodies.request) + byteLen(gone.bodies.response)
  }

  /** Most-recent-last, matching `GET /api/v1/engine/logs`'s convention. `bodies: false` strips
   *  request/response payloads from every returned row regardless of whether they were
   *  captured — the list endpoint never leaks bodies unless the caller explicitly opts in
   *  per-request (`?bodies=1`), independent of whether the daemon-wide toggle is on. */
  list(opts: { limit?: number; since?: number; source?: RequestSource; modelKey?: string; status?: 'ok' | 'error'; bodies?: boolean } = {}): RequestLogEntry[] {
    let rows = this.entries
    if (opts.since !== undefined) rows = rows.filter((e) => e.ts > opts.since!)
    if (opts.source) rows = rows.filter((e) => e.source === opts.source)
    if (opts.modelKey) rows = rows.filter((e) => e.modelKey === opts.modelKey)
    if (opts.status === 'ok') rows = rows.filter((e) => e.status !== null && e.status < 400)
    if (opts.status === 'error') rows = rows.filter((e) => e.status === null || e.status >= 400 || !!e.error)
    if (opts.limit !== undefined) rows = rows.slice(-opts.limit)
    return opts.bodies ? rows : rows.map(stripBodies)
  }

  get(id: string): RequestLogEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  clear(): void {
    this.entries = []
    this.bodyBytes = 0
  }

  /** Live fan-out for the SSE route. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

function stripBodies(e: RequestLogEntry): RequestLogEntry {
  return e.bodies ? { ...e, bodies: null } : e
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export interface OpenAiSseDrainResult {
  promptTokens: number
  completionTokens: number
  promptTps: number | null
  genTps: number | null
  ttftMs: number | null
  finishReason: string | null
  /** Reassembled generated text — only when `captureBody` was passed true. '' otherwise. */
  responseText: string
}

/** The ONE OpenAI-SSE-chunk scanner both capture sites use: gateway.ts's own usage-recording
 *  drain (`recordOpenAiStreamUsage`, which ALSO does gateway-only side effects — the live
 *  engine-card counter, terminal-agent tool-call attribution, the durable `api_usage` row —
 *  via `onDelta`/`onChunk`) and chat-upstream.ts's in-app-chat capture, which needs none of
 *  that. Pulled out here so there is exactly one place that knows the OpenAI streaming
 *  chunk shape (`data: {...}` lines, `usage`, `timings`, `choices[0].delta`), never two
 *  drifting copies of the same `TextDecoder` + line-split loop.
 *
 *  Never touches the stream it was handed for anything but reading — callers are expected to
 *  pass a `tee()`'d copy, same convention as every drain in gateway.ts. */
export async function drainOpenAiSseForLog(
  body: ReadableStream<Uint8Array>,
  opts: { captureBody: boolean; startedAt?: number; onChunk?: (chunk: Record<string, unknown>) => void } = { captureBody: false },
): Promise<OpenAiSseDrainResult> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let promptTokens = 0
  let completionTokens = 0
  let promptTps: number | null = null
  let genTps: number | null = null
  let ttftMs: number | null = null
  let finishReason: string | null = null
  let responseText = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') continue
      let chunk: Record<string, unknown>
      try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
      const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
      if (usage) {
        if (usage.prompt_tokens) promptTokens = usage.prompt_tokens
        if (usage.completion_tokens) completionTokens = usage.completion_tokens
      }
      const timings = chunk.timings as { prompt_per_second?: number; predicted_per_second?: number } | undefined
      if (timings) {
        if (timings.prompt_per_second) promptTps = timings.prompt_per_second
        if (timings.predicted_per_second) genTps = timings.predicted_per_second
      }
      const delta = (chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined)?.[0]?.delta
      if (delta && (delta.content || delta.reasoning_content)) {
        if (ttftMs === null && opts.startedAt !== undefined) ttftMs = Date.now() - opts.startedAt
        if (opts.captureBody && delta.content) responseText += delta.content
      }
      const reason = (chunk.choices as Array<{ finish_reason?: string | null }> | undefined)?.[0]?.finish_reason
      if (reason) finishReason = reason
      opts.onChunk?.(chunk)
    }
  }
  return { promptTokens, completionTokens, promptTps, genTps, ttftMs, finishReason, responseText }
}
