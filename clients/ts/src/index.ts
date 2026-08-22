// @turbollm/chat-client
//
// A zero-runtime-dependency TypeScript client for TurboLLM's public External Chat API
// (spec 27, `/api/ext/v1`). This package intentionally does NOT import anything from
// `turbollm/src` — it only knows the wire contract: the error envelope (§7.1), the DTO
// field names (§3.2), the pagination envelope (§5.2), and the SSE event scheme (§6.3).
//
// The one thing worth building a client around, rather than leaving to every integrator to
// get wrong independently, is spec §7.3's reconciliation rule: a stream that closes without a
// `done` frame means the outcome is UNKNOWN, not failed — the run record is the source of
// truth. `RunStream` tracks that automatically instead of making every caller remember it.

/** The nine frozen `type` values from spec 27 §7.1 — a client switches on these; `code` is
 *  open and may grow without a major version bump. */
export type ExtErrorType =
  | 'invalid_request'
  | 'auth'
  | 'not_found'
  | 'conflict'
  | 'capacity'
  | 'engine'
  | 'storage'
  | 'unsupported'
  | 'internal'

export interface ExtErrorBody {
  type: ExtErrorType
  code: string
  message: string
  param?: string
  request_id?: string
  retryable?: boolean
  retry_after_ms?: number
}

/** Thrown for any non-2xx response. Carries the parsed error envelope (spec 27 §7.1) as typed
 *  properties instead of forcing every caller to re-parse `error.json()` on a caught error. */
export class ApiError extends Error {
  readonly type: ExtErrorType
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly requestId?: string
  readonly status: number

  constructor(status: number, body: Partial<ExtErrorBody> | undefined) {
    super(body?.message ?? `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.type = (body?.type ?? 'internal') as ExtErrorType
    this.code = body?.code ?? 'internal'
    this.retryable = body?.retryable ?? false
    this.retryAfterMs = body?.retry_after_ms
    this.requestId = body?.request_id
  }
}

export interface Chat {
  id: string
  owner: string
  title?: string | null
  model?: string | null
  system_prompt?: string | null
  sampling?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  message_count: number
  last_message_at?: string | null
  version: number
  created_at: string
  updated_at: string
}

export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'failed' | 'aborted'

export interface Message {
  id: string
  chat_id: string
  seq: number
  role: MessageRole
  content: string
  status: MessageStatus
  version: number
  created_at: string
  edited: boolean
  // Heavy fields — present only when requested via `?include=` (spec 27 §5.3).
  reasoning?: string
  attachments?: string[]
  // Matches the real wire shape persisted into `ChatMessage.toolCalls` and flowed unchanged
  // through `dto.ts` (server's `generation.ts` `ToolCallRecord` / `tools/execute-with-approval.ts`
  // `sink()` payloads) — `id`/`name`/`args`, not `name`/`arguments` as an earlier draft of this
  // client and spec §3.2's sample JSON both incorrectly showed.
  tool_calls?: Array<{ id: string; name: string; args: unknown; result?: unknown; error?: unknown }>
  // The raw engine `chunk.usage` object captured by generation.ts — NOT the richer,
  // internal-chat-only MessageStats shape (tokens_per_second/model) an earlier draft of this type
  // wrongly declared as required; those come from a separate wire field (`chunk.timings`) plus
  // local daemon state generation.ts never reads. prompt_tokens/completion_tokens are typed
  // (optional, since an aborted/failed run may never receive a usage chunk at all) because they
  // are the fields actually reliably present across engines — mirrors chat-routes.ts's own
  // `finalUsage` local type. The index signature keeps this honest for anything engine-specific
  // beyond that, matching openapi.ts's intentionally generic (`additionalProperties: true`) schema.
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; [key: string]: unknown }
  metadata?: Record<string, unknown>
}

export type RunStatus = 'queued' | 'streaming' | 'complete' | 'failed' | 'aborted'

export interface Run {
  id: string
  chat_id: string
  message_id: string
  status: RunStatus
  event_seq: number
  // Narrower than the full error envelope (`ExtErrorBody`) on purpose: the server's
  // `PublicRun.error` (`run-manager.ts`) only ever populates `type`/`code`/`message` — never
  // `param`/`request_id`/`retryable`/`retry_after_ms`. Typing this as the full `ExtErrorBody`
  // would let `if (run.error?.retryable) …` compile and silently always be falsy.
  error: Pick<ExtErrorBody, 'type' | 'code' | 'message'> | null
  created_at: string
  ended_at: string | null
}

export interface Page<T> {
  data: T[]
  has_more: boolean
  next_cursor: string | null
}

export interface ListOpts {
  owner?: string
  cursor?: string
  limit?: number
  q?: string
}

export interface ListMessagesOpts {
  owner?: string
  cursor?: string
  limit?: number
  include?: HeavyField[]
}

export type HeavyField = 'reasoning' | 'attachments' | 'tool_calls' | 'usage' | 'metadata'

export interface CreateChatInput {
  owner?: string
  title?: string
  model?: string
  system_prompt?: string
  sampling?: Record<string, unknown>
  metadata?: Record<string, unknown>
  idempotencyKey?: string
}

export interface UpdateChatInput {
  owner?: string
  title?: string
  system_prompt?: string
  sampling?: Record<string, unknown>
  metadata?: Record<string, unknown>
  ifVersion?: number
}

export interface AppendMessageInput {
  owner?: string
  role?: MessageRole
  // Optional, not required: the server accepts and persists an attachments-only message with
  // absent/empty content, rejecting a request only when BOTH content and attachments are empty
  // (spec 27's content-OR-attachments rule; matches SendParams below).
  content?: string
  reasoning?: string
  attachments?: string[]
  metadata?: Record<string, unknown>
  include?: HeavyField[]
}

export interface SendParams {
  owner?: string
  role?: MessageRole
  // Optional, not required — see AppendMessageInput's `content` doc comment for the rule.
  content?: string
  attachments?: string[]
  // No per-message `sampling` field (release-gate I6): no route on the server ever read one —
  // only chat-level sampling (chats.create/.update) affects generation. An earlier draft of this
  // client sent one that the server silently ignored; removed rather than shipping a v1 field
  // that does nothing. Use `chats.update(chatId, { sampling })` before sending if you need to
  // change it.
  metadata?: Record<string, unknown>
  idempotencyKey?: string
}

export interface UpdateMessageInput {
  owner?: string
  content?: string
  metadata?: Record<string, unknown>
  ifVersion?: number
  include?: HeavyField[]
}

/** One event off an SSE stream (spec 27 §6.3). `event_seq` — carried as the SSE `id:` field —
 *  is the single monotonic resume token across every event kind on a run. */
export interface ExtEvent {
  event: string
  data: unknown
  eventSeq: number | undefined
}

/** The four terminal shapes a `done` frame's `status` field can carry (spec 27 §3.2's `Run`),
 *  plus `'unknown'` for a stream that closed without ever seeing a `done` frame at all — spec
 *  27 §7.3's reconciliation rule: a closed connection with no terminal frame is NOT a failure,
 *  it is unresolved, and the run record (`GET /runs/{id}`) is the only source of truth for it. */
export type RunOutcome = 'complete' | 'failed' | 'aborted' | 'unknown'

export interface TurboLLMChatOptions {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
}

interface RequestOpts {
  method?: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
  accept?: string
}

function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/** Parses one `\n\n`-delimited SSE frame block into `{ event, data, id }`. Comment lines
 *  (`: heartbeat`, spec 27 §8.3 item 7) and blank lines are ignored; a frame with no explicit
 *  `event:` line defaults to `'message'`, matching the SSE spec's own default. */
function parseFrame(block: string): { event: string; data: string; id?: string } | null {
  let event = 'message'
  let id: string | undefined
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0 && event === 'message' && id === undefined) return null
  return { event, data: dataLines.join('\n'), id }
}

/** An `AsyncIterable<ExtEvent>` over a run's SSE stream, exposing the bookkeeping spec §7.3
 *  needs so a caller never has to reimplement it: `lastEventSeq` for `?after=` reconnects,
 *  `runId` once the `run` frame arrives, and `outcome` — set from a `done` frame's `status`,
 *  left `'unknown'` if the body ends without one. */
export class RunStream implements AsyncIterable<ExtEvent> {
  lastEventSeq: number | undefined
  runId: string | undefined
  outcome: RunOutcome = 'unknown'

  private readonly body: Promise<Response>

  constructor(body: Promise<Response>) {
    this.body = body
  }

  /** Turns one `\n\n`-delimited block into an `ExtEvent`, updating the running bookkeeping
   *  (`lastEventSeq`, `runId`, `outcome`) along the way. Returns `null` for a blank block (the
   *  trailing chunk after the final separator, or a heartbeat-only comment line). */
  private toEvent(block: string): ExtEvent | null {
    if (block.trim() === '') return null
    const parsed = parseFrame(block)
    if (!parsed) return null
    const eventSeq = parsed.id !== undefined ? Number(parsed.id) : undefined
    if (eventSeq !== undefined && !Number.isNaN(eventSeq)) this.lastEventSeq = eventSeq
    let data: unknown = parsed.data
    try { data = parsed.data ? JSON.parse(parsed.data) : undefined } catch { /* leave as raw string */ }

    if (parsed.event === 'run' && data && typeof data === 'object') {
      this.runId = (data as { run_id?: string }).run_id
    }
    if (parsed.event === 'done' && data && typeof data === 'object') {
      const status = (data as { status?: string }).status
      if (status === 'complete' || status === 'failed' || status === 'aborted') this.outcome = status
    }
    return { event: parsed.event, data, eventSeq }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ExtEvent> {
    const res = await this.body

    // A request can be rejected BEFORE the server ever enters SSE mode — `invalid_input`,
    // `generation_in_flight`, `model_not_loaded`, `replay_window_exceeded`, `rate_limited`,
    // `context_overflow`, `not_found` are all plain JSON `{ error: {...} } bodies via
    // `extError`, regardless of the `Accept: text/event-stream` header this client sent
    // (spec 27 §7.2; `respondWithRun` only reaches `streamSSE(...)` after every one of those
    // checks passes). Without this check, a one-line JSON error blob has no `\n\n` separator,
    // gets silently swallowed by the frame parser at end-of-stream, and `send()` — spec's "the
    // one endpoint that matters" — would complete with zero events and no exception instead of
    // throwing. Treat any non-2xx response as a request failure, exactly like `request()` does
    // for JSON calls, before ever touching `res.body` as an SSE stream.
    if (!res.ok) {
      let parsed: { error?: Partial<ExtErrorBody> } | undefined
      try { parsed = (await res.json()) as { error?: Partial<ExtErrorBody> } } catch { parsed = undefined }
      throw new ApiError(res.status, parsed?.error)
    }

    const reader = res.body?.getReader()

    if (!reader) {
      // No readable body stream on this Response (atypical for a real fetch, but keeps this
      // robust against a Response-like object that only implements `.text()`) — fall back to
      // reading it as one complete blob.
      for (const block of (await res.text()).split('\n\n')) {
        const ev = this.toEvent(block)
        if (ev) yield ev
      }
      return
    }

    // Read the body incrementally rather than buffering the whole response up front. A real
    // generation streams tokens over tens of seconds; a caller rendering `delta` events live
    // (see README) needs each frame as soon as it completes, not all at once when the
    // connection finally closes — buffering here would silently turn a streaming response
    // into a blocking one.
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const ev = this.toEvent(block)
        if (ev) yield ev
        sep = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    const ev = this.toEvent(buffer)
    if (ev) yield ev
  }
}

/** The public TypeScript client for `/api/ext/v1` (spec 27). Zero runtime dependencies — it
 *  relies entirely on the global `fetch`, injectable via `options.fetch` for testing or for
 *  runtimes that need a polyfill. */
export class TurboLLMChat {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly doFetch: typeof fetch

  constructor(options: TurboLLMChatOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.doFetch = options.fetch ?? fetch
  }

  /** Sends one authenticated request and returns the raw `Response` — used by `request()` for
   *  JSON calls and directly by `runs.stream`/`send`/`resume` for SSE, since those need the
   *  response body as a stream/text rather than pre-parsed JSON. */
  private async raw(path: string, opts: RequestOpts = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`
    const headers: Record<string, string> = {
      // The bearer token is the ONLY place the key travels — never a query string, which
      // would leak into server logs, proxy logs, and the browser's own history/referrer.
      Authorization: `Bearer ${this.apiKey}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.accept ? { Accept: opts.accept } : {}),
      ...opts.headers,
    }
    return this.doFetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  }

  /** Parses the error envelope into `ApiError` (spec 27 §7.1) and returns typed JSON on
   *  success. Every JSON-mode method on this client goes through here. */
  private async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const res = await this.raw(path, opts)
    if (!res.ok) {
      let parsed: { error?: Partial<ExtErrorBody> } | undefined
      try { parsed = (await res.json()) as { error?: Partial<ExtErrorBody> } } catch { parsed = undefined }
      throw new ApiError(res.status, parsed?.error)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  readonly chats = {
    list: (opts: ListOpts = {}): Promise<Page<Chat>> =>
      this.request(`/chats`, { query: { owner: opts.owner, cursor: opts.cursor, limit: opts.limit, q: opts.q } }),

    create: (input: CreateChatInput = {}): Promise<Chat> =>
      this.request(`/chats`, {
        method: 'POST',
        body: {
          owner: input.owner, title: input.title, model: input.model,
          system_prompt: input.system_prompt, sampling: input.sampling, metadata: input.metadata,
        },
        headers: input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : undefined,
      }),

    get: (id: string, opts: { owner?: string } = {}): Promise<Chat> =>
      this.request(`/chats/${encodeURIComponent(id)}`, { query: { owner: opts.owner } }),

    update: (id: string, patch: UpdateChatInput = {}): Promise<Chat> =>
      this.request(`/chats/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: {
          owner: patch.owner, title: patch.title, system_prompt: patch.system_prompt,
          sampling: patch.sampling, metadata: patch.metadata, if_version: patch.ifVersion,
        },
      }),

    delete: (id: string, opts: { owner?: string } = {}): Promise<void> =>
      this.request(`/chats/${encodeURIComponent(id)}`, { method: 'DELETE', query: { owner: opts.owner } }),
  }

  readonly messages = {
    list: (chatId: string, opts: ListMessagesOpts = {}): Promise<Page<Message>> =>
      this.request(`/chats/${encodeURIComponent(chatId)}/messages`, {
        query: { owner: opts.owner, cursor: opts.cursor, limit: opts.limit, include: opts.include?.join(',') },
      }),

    get: (id: string, opts: { owner?: string; include?: HeavyField[] } = {}): Promise<Message> =>
      this.request(`/messages/${encodeURIComponent(id)}`, {
        query: { owner: opts.owner, include: opts.include?.join(',') },
      }),

    update: (id: string, patch: UpdateMessageInput = {}): Promise<Message> =>
      this.request(`/messages/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        query: { include: patch.include?.join(',') },
        body: { owner: patch.owner, content: patch.content, metadata: patch.metadata, if_version: patch.ifVersion },
      }),

    delete: (id: string, opts: { owner?: string } = {}): Promise<void> =>
      this.request(`/messages/${encodeURIComponent(id)}`, { method: 'DELETE', query: { owner: opts.owner } }),

    /** The `generate: false` path (spec 27 §5.1): appends a message with no run, for
     *  back-filling history without touching the GPU. Forwards `attachments`/`metadata` just
     *  like `send()`/`SendParams` do on the generate path — the server fully reads and persists
     *  both here too, so silently dropping them would be client-side data loss. */
    append: (chatId: string, input: AppendMessageInput): Promise<Message> =>
      this.request(`/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        query: { include: input.include?.join(',') },
        body: {
          owner: input.owner, role: input.role ?? 'user', content: input.content,
          reasoning: input.reasoning, attachments: input.attachments, metadata: input.metadata,
          generate: false,
        },
      }),
  }

  // Every run route resolves owner from the QUERY STRING, never a body (routes.runs.ts) — the
  // server 404s a run whose owner doesn't match the caller's own (scopeFor defaults absent
  // owner to 'default'). Release-gate I5: none of these forwarded `owner` at all, so
  // resume() — the client's headline feature and the whole reason it exists — was unusable for
  // exactly the multi-owner case the README's own example demonstrates (a run created for
  // `owner: 'user_123'` via `send()` 404s on the very next `runs.get`/`cancel`/`resume`).
  readonly runs = {
    get: (id: string, opts: { owner?: string } = {}): Promise<Run> =>
      this.request(`/runs/${encodeURIComponent(id)}`, { query: { owner: opts.owner } }),

    list: (opts: { owner?: string } = {}): Promise<Run[]> =>
      this.request<{ data: Run[] }>(`/runs`, { query: { owner: opts.owner } }).then((page) => page.data),

    cancel: (id: string, opts: { owner?: string } = {}): Promise<Run> =>
      this.request(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', query: { owner: opts.owner } }),

    /** Attaches (or re-attaches, via `after`) to a run's SSE stream (spec 27 §6.3). */
    stream: (runId: string, after?: number, opts: { owner?: string } = {}): RunStream =>
      new RunStream(this.raw(`/runs/${encodeURIComponent(runId)}/stream`, {
        query: { after, owner: opts.owner },
        accept: 'text/event-stream',
      })),
  }

  /** Appends a message and starts a run, returning a `RunStream` of typed events (spec 27
   *  §5.1's `Accept: text/event-stream` path). This is the one endpoint that matters — send a
   *  message, consume the stream. */
  send(chatId: string, params: SendParams): RunStream {
    return new RunStream(this.raw(`/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      accept: 'text/event-stream',
      headers: params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : undefined,
      body: {
        owner: params.owner, role: params.role ?? 'user', content: params.content,
        attachments: params.attachments, metadata: params.metadata,
        generate: true,
      },
    }))
  }

  /** Convenience wrapper over `runs.stream` implementing spec §7.3's reconciliation rule: if
   *  the server answers `409 replay_window_exceeded` (the cursor aged out of the run's replay
   *  buffer), re-read the message via `runs.get` to resynchronize and attach fresh from the
   *  run's current `event_seq` instead of surfacing the error to the caller. `owner` must match
   *  whatever the run was created under (`send()`'s own `owner` param) — omitting it defaults
   *  to `'default'` server-side, same as every other call in this client (release-gate I5). */
  async resume(runId: string, afterSeq: number, opts: { owner?: string } = {}): Promise<RunStream> {
    const probe = await this.raw(`/runs/${encodeURIComponent(runId)}/stream`, {
      query: { after: afterSeq, owner: opts.owner },
      accept: 'text/event-stream',
    })
    if (probe.status === 409) {
      let code: string | undefined
      try { code = ((await probe.clone().json()) as { error?: { code?: string } }).error?.code } catch { /* ignore */ }
      if (code === 'replay_window_exceeded') {
        const run = await this.runs.get(runId, opts)
        return this.runs.stream(runId, run.event_seq, opts)
      }
      throw new ApiError(409, ((await probe.json().catch(() => undefined)) as { error?: ExtErrorBody } | undefined)?.error)
    }
    return new RunStream(Promise.resolve(probe))
  }
}
