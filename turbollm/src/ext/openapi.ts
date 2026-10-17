// turbollm/src/ext/openapi.ts
//
// The OpenAPI 3.1 document for /api/ext/v1 (spec 27 §5-§7, Phase 4 Task 4).
//
// EXT_ROUTES is the single source of truth for "what is live" — every route registered by
// routes.chats.ts and routes.runs.ts has exactly one entry here, plus this task's own
// GET /openapi.json. buildOpenApiDocument() assembles the document ENTIRELY by iterating this
// manifest, so a route added to either registrar without a matching manifest entry cannot drift
// silently: openapi.test.ts's drift-guard test constructs a real Hono app via
// registerExtChatRoutes and fails the moment a live route has no manifest entry.
//
// Kept deliberately dumb: no reflection over the route files themselves (Hono handlers carry no
// runtime-inspectable schema), so the manifest is hand-maintained prose-as-data. That is the
// honest trade this design makes — see the brief's own framing: "a hand-written OpenAPI file is
// wrong within two releases," which this addresses by making the ONE hand-written artifact a
// flat list of `{method, path}` pairs a reviewer can diff against the route files in seconds,
// rather than a 900-line paths object no one rereads in full.
import { EXT_ERROR_TYPES } from './errors.js'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** One manifest entry per live route. `path` uses Hono's own `:param` syntax — matching
 *  `app.routes[].path` exactly (verified against a live Hono instance; Hono does not rewrite
 *  `:id` to `{id}` on `.routes`) — so the drift-guard test's string comparison needs no
 *  translation layer that could itself hide a mismatch. Translated to `{param}` only when
 *  building the OpenAPI `paths` key, per the 3.1 spec. */
export interface RouteSpec {
  method: HttpMethod
  path: string
  summary: string
  /** Absent ⇒ no specific scope requirement (still behind the blanket auth/rate-limit
   *  middleware) — `GET /capabilities` and `GET /openapi.json` are the two live examples. */
  scope?: 'chats:read' | 'chats:write' | 'runs:write'
  /** Dotted audit action (audit.ts's `AuditEntry.action`), documented so an integrator reading
   *  the schema knows which calls show up in `GET /audit`. Absent ⇒ not audited (reads). */
  audited?: string
  requestSchema?: string
  responseSchema?: string
  /** SSE endpoints document `text/event-stream` alongside `application/json` (spec §5.1, §6.3),
   *  always under 200: that is what streamSSE answers. */
  sse?: boolean
  /** A second possible success response, for the one route whose response shape depends on
   *  request BODY content rather than just the `Accept` header (which `sse` already covers).
   *  `POST /chats/:id/messages` is the sole user: `generate:false` returns this entry's primary
   *  `responseSchema` (`Message`, 201); `generate` omitted or `true` — the default, and the case
   *  spec §5.1 calls "the one endpoint that matters" — forwards internally to
   *  `POST .../messages/generate` and returns THIS shape instead. Documenting only the primary
   *  response would describe the minority code path and silently omit the majority one. */
  altResponse?: { status: string; description: string; schema: string; sse?: boolean }
  /** Override for `buildOperation`'s default status inference (POST+schema -> 201, POST without
   *  a schema -> 202, DELETE -> 204, else 200). Release-gate I11: that default is wrong for any
   *  POST that doesn't actually return 201 — `POST .../messages/generate` returns 202 (it's a
   *  Run, not a fully-formed resource yet) and `POST /runs/:id/cancel` returns 200 (updating an
   *  existing resource, not creating one). Set explicitly rather than special-cased in the
   *  inference function, so the NEXT route that doesn't fit the convention fails loudly (a
   *  missing successStatus falls back to the wrong default) instead of silently drifting again. */
  successStatus?: string
  /** Query parameters the handler reads, other than `owner` (derived separately — see
   *  NO_OWNER_PARAM_PATHS). openapi.test.ts scans the route files' `c.req.query(...)` calls and
   *  fails when a route reads one this list does not name, or names one it never reads. */
  query?: QueryParam[]
  /** Optional request headers the handler reads (beyond auth, `Accept` and `X-Request-Id`):
   *  `Idempotency-Key`. openapi.test.ts checks every handler reading one documents it. */
  headers?: QueryParam[]
  /** Error `type`s this route can answer with, each documented at that type's usual status
   *  (`errorResponses`). `type:status` documents a type a route sends with a different status
   *  — e.g. `auth:403` (insufficient_scope / tenant_not_supported, auth.ts) next to the plain
   *  401, or `engine:409` (context_overflow, routes.runs.ts). */
  errors: string[]
}

// Every route on this surface sits behind routes.chats.ts's blanket per-tenant rate limiter
// (`app.use(BASE/*, ...)`, registered ahead of every route including ones added later by
// routes.runs.ts and mount.ts) — spec §5.4 confirms read AND write traffic is rate limited, so
// `capacity` belongs in the shared read-error set, not just the write one.
// `auth:403`: every scoped route refuses a key lacking the scope, or resolving to the local
// tenant, with 403 (auth.ts) — 401 alone undersold it.
// `internal` (500): extErrorHandler's backstop, and mapStoreError's fallback, can answer any route.
const CHAT_ERRORS = ['auth', 'auth:403', 'not_found', 'invalid_request', 'capacity', 'internal']
const WRITE_ERRORS = [...CHAT_ERRORS, 'conflict', 'storage']
// Routes that call the chat store also surface mapStoreError's 501 `not_supported` (errors.ts) —
// the answer for every such call when no adapter serves the key's tenant — and its `storage`
// (an adapter returning malformed data), on reads as much as writes.
const STORE_READ_ERRORS = [...CHAT_ERRORS, 'unsupported', 'storage']
const STORE_WRITE_ERRORS = [...WRITE_ERRORS, 'unsupported']
// Body caps (limits.ts) are `invalid_request` sent as 413 payload_too_large; the context-window
// refusal is `engine` sent as 409 context_overflow (routes.runs.ts), never the type's 502.
const BODY_CAP_ERRORS = ['invalid_request:413']

export interface QueryParam {
  name: string
  description: string
  /** Defaults to 'string'. */
  type?: 'string' | 'integer'
}
// The chat store's cursor pagination (sqlite-chat-store.ts's clampLimit) and dto.ts's include=.
const CURSOR_PARAM: QueryParam = { name: 'cursor', description: "Opaque cursor: the previous page's `next_cursor`. Omit for the first page." }
const LIMIT_PARAM: QueryParam = { name: 'limit', type: 'integer', description: 'Page size, an integer (any other value gets 400 invalid_input). The built-in store takes 1-200 (larger values are clamped to 200) and defaults to 50; a configured store adapter applies its own bounds.' }
// idempotency.ts: kept 24 h, in memory only, scoped to tenant + owner + operation.
const IDEMPOTENCY_KEY = 'Optional client-chosen key that makes a retry safe: a repeat with the same key (and owner) within 24 hours'
const IDEMPOTENCY_TAIL = 'Keys are held in memory, so a daemon restart forgets them. Reusing a key for a different request is refused with 409 idempotency_key_reused.'
const IDEMPOTENCY_GENERATE = `${IDEMPOTENCY_KEY} reattaches to the original run instead of appending the message again. ${IDEMPOTENCY_TAIL} Once that run has left memory (about an hour after it ends), a JSON repeat returns its stored record and a streaming repeat is refused with 409 replay_window_exceeded; a run that can no longer be found at all is refused with 409 idempotency_replay_expired.`
const INCLUDE_PARAM: QueryParam = {
  name: 'include',
  description: 'Comma-separated heavy fields to return on each message: reasoning, attachments, tool_calls, usage, metadata. Omitted fields are left out of the response.',
}

export const EXT_ROUTES: RouteSpec[] = [
  // ── routes.chats.ts ───────────────────────────────────────────────────────────────────────
  {
    method: 'GET', path: '/capabilities',
    summary: 'Store capabilities, limits, and model info.',
    // No `requireScope` call, but still behind the blanket extAuth (401) and per-tenant rate
    // limiter (429) middleware routes.chats.ts registers ahead of every route on this surface.
    responseSchema: 'Capabilities', errors: ['auth', 'capacity', 'internal'],
  },
  {
    method: 'GET', path: '/chats',
    summary: 'List chats, cursor-paginated.',
    scope: 'chats:read', responseSchema: 'ChatPage', errors: STORE_READ_ERRORS,
    query: [CURSOR_PARAM, LIMIT_PARAM, { name: 'q', description: 'Search text. The built-in store matches it as a substring of chat titles (message content is not searched); a configured store adapter applies its own matching. Honoured only when GET /capabilities reports `search: true`.' }],
  },
  {
    method: 'POST', path: '/chats',
    summary: 'Create a chat.',
    scope: 'chats:write', audited: 'chat.create',
    requestSchema: 'ChatInput', responseSchema: 'Chat', errors: STORE_WRITE_ERRORS,
    headers: [{ name: 'Idempotency-Key', description: `${IDEMPOTENCY_KEY} returns the chat it created instead of creating another. ${IDEMPOTENCY_TAIL}` }],
  },
  {
    method: 'GET', path: '/chats/:id',
    summary: 'Fetch one chat.',
    scope: 'chats:read', responseSchema: 'Chat', errors: STORE_READ_ERRORS,
  },
  {
    method: 'PATCH', path: '/chats/:id',
    summary: 'Update title, system_prompt, sampling, or metadata.',
    scope: 'chats:write', audited: 'chat.update',
    requestSchema: 'ChatPatch', responseSchema: 'Chat', errors: STORE_WRITE_ERRORS,
  },
  {
    method: 'DELETE', path: '/chats/:id',
    summary: 'Delete a chat and its messages.',
    scope: 'chats:write', audited: 'chat.delete', errors: STORE_WRITE_ERRORS,
  },
  {
    method: 'GET', path: '/chats/:id/messages',
    summary: 'List messages in a chat, cursor-paginated.',
    scope: 'chats:read', responseSchema: 'MessagePage', errors: STORE_READ_ERRORS,
    query: [CURSOR_PARAM, LIMIT_PARAM, INCLUDE_PARAM],
  },
  {
    method: 'POST', path: '/chats/:id/messages',
    summary: 'Append a message. Default (generate omitted or true): forwards to POST .../messages/generate and starts a run. generate:false: append only, no run.',
    scope: 'chats:write', audited: 'message.create',
    requestSchema: 'MessageInput', responseSchema: 'Message',
    // The DEFAULT path (generate omitted or true — spec §5.1's "the one endpoint that
    // matters") never returns `Message`/201 at all: routes.chats.ts forwards the request
    // verbatim to POST .../messages/generate (via `app.fetch`) and relays THAT response —
    // `Run`/202 as JSON, or an SSE stream, per Accept. `Message`/201 above is accurate only for
    // the explicit `generate:false` case. `engine` (context_overflow) is reachable here too,
    // since it originates in the forwarded route.
    altResponse: {
      status: '202', schema: 'Run', sse: true,
      description: 'Default (generate omitted or true): identical to calling POST .../messages/generate directly — the async Run (JSON), or with Accept: text/event-stream an SSE stream answered with 200 (spec §5.1).',
    },
    errors: [...STORE_WRITE_ERRORS, ...BODY_CAP_ERRORS, 'engine:409'],
    // Read only on the generate:false path, which answers with a Message.
    query: [{ ...INCLUDE_PARAM, description: `generate:false only. ${INCLUDE_PARAM.description}` }],
    // Read by the forwarded generate route; generate:false ignores it.
    headers: [{ name: 'Idempotency-Key', description: `generate omitted or true only. ${IDEMPOTENCY_GENERATE}` }],
  },
  {
    method: 'GET', path: '/messages/:id',
    summary: 'Fetch one message.',
    scope: 'chats:read', responseSchema: 'Message', errors: STORE_READ_ERRORS,
    query: [INCLUDE_PARAM],
  },
  {
    method: 'PATCH', path: '/messages/:id',
    summary: 'Edit message content.',
    scope: 'chats:write', audited: 'message.update',
    requestSchema: 'MessagePatch', responseSchema: 'Message', errors: [...STORE_WRITE_ERRORS, ...BODY_CAP_ERRORS],
    query: [INCLUDE_PARAM],
  },
  {
    method: 'DELETE', path: '/messages/:id',
    summary: 'Delete a message.',
    scope: 'chats:write', audited: 'message.delete', errors: STORE_WRITE_ERRORS,
  },
  {
    method: 'GET', path: '/audit',
    summary: "The tenant's own audit trail of mutations.",
    scope: 'chats:read', responseSchema: 'AuditPage', errors: CHAT_ERRORS,
    query: [
      { name: 'limit', type: 'integer', description: 'Page size, a positive integer (larger values are clamped to 200). Default 200.' },
      { name: 'since', description: 'ISO 8601 date or date-time in extended format, e.g. 2026-10-15, 2026-10-15T10:00:00Z or 2026-10-15T12:00:00.250+02:00 (seconds and fraction optional; a date, or a bare YYYY-MM or YYYY, is midnight UTC; a date-time with neither Z nor an offset is read in the daemon\'s local time zone): only rows at or after that instant. A + offset may be sent percent-encoded (%2B) or raw: a raw + decodes to a space, and a space in its place is read as +. Any other form, the basic format (20261015T100000Z) included, is refused with 400 invalid_input.' },
      { name: 'before', description: 'The `id` of the oldest row a previous page returned: only rows older than it.' },
    ],
  },

  // ── routes.runs.ts ────────────────────────────────────────────────────────────────────────
  {
    method: 'POST', path: '/chats/:id/messages/generate',
    summary: 'Start a generation run for a chat (SSE or JSON, per Accept).',
    scope: 'runs:write', audited: 'run.start',
    requestSchema: 'MessageInput', responseSchema: 'Run', sse: true,
    successStatus: '202', errors: [...STORE_WRITE_ERRORS, ...BODY_CAP_ERRORS, 'engine:409'],
    headers: [{ name: 'Idempotency-Key', description: IDEMPOTENCY_GENERATE }],
  },
  {
    method: 'GET', path: '/runs',
    summary: 'List runs for the tenant.',
    scope: 'chats:read', responseSchema: 'RunPage', errors: CHAT_ERRORS,
  },
  {
    method: 'GET', path: '/runs/:id',
    summary: "Run status — the source of truth for a run's outcome.",
    scope: 'chats:read', responseSchema: 'Run', errors: CHAT_ERRORS,
  },
  {
    method: 'GET', path: '/runs/:id/stream',
    summary: "Attach or re-attach to a run's SSE event stream. Query `after` is the last event_seq (SSE `id`) already received: only later frames are sent. Omit it (or pass 0) to replay from the first frame.",
    scope: 'chats:read', sse: true, errors: [...CHAT_ERRORS, 'conflict'],
    query: [{ name: 'after', type: 'integer', description: 'The last event_seq (SSE `id`) already received; only later frames are sent. Omit it (or pass 0) to replay from the first frame.' }],
  },
  {
    method: 'POST', path: '/runs/:id/cancel',
    summary: 'Abort a run.',
    scope: 'runs:write', audited: 'run.cancel', responseSchema: 'Run',
    successStatus: '200', errors: WRITE_ERRORS,
  },

  // ── this task ─────────────────────────────────────────────────────────────────────────────
  {
    method: 'GET', path: '/openapi.json',
    summary: 'This OpenAPI 3.1 document.',
    // Registered under the same `/api/ext/v1/*` prefix as every other route (mount.ts), so it
    // is subject to the same blanket extAuth (401) and per-tenant rate limiter (429) middleware
    // today — NOT keyless. (Whether it should eventually be made keyless, so an integrator can
    // read the schema before it has a key, is a real but separate product decision — see this
    // task's report — not something this manifest entry should misrepresent in the meantime.)
    responseSchema: 'OpenApiDocument', errors: ['auth', 'capacity', 'internal'],
  },
]

type JsonSchema = Record<string, unknown>

function pageOf(itemRef: string): JsonSchema {
  return {
    allOf: [{ $ref: '#/components/schemas/Page' }],
    properties: { data: { type: 'array', items: { $ref: `#/components/schemas/${itemRef}` } } },
  }
}

function buildSchemas(): Record<string, JsonSchema> {
  const Chat: JsonSchema = {
    type: 'object',
    description: 'A conversation (spec 27 §3.2). `tenant` is never serialized.',
    properties: {
      id: { type: 'string' },
      owner: { type: 'string' },
      title: { type: 'string' },
      model: { type: 'string', description: 'Advisory; the daemon serves whatever is loaded.' },
      system_prompt: { type: 'string' },
      sampling: { type: 'object', additionalProperties: true },
      metadata: { type: 'object', additionalProperties: true, description: 'Free-form, stored verbatim, never interpreted.' },
      message_count: { type: 'integer' },
      last_message_at: { type: ['string', 'null'], format: 'date-time' },
      version: { type: 'integer', description: 'Optimistic-concurrency token (spec §4.6).' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
    required: [
      'id', 'owner', 'title', 'model', 'system_prompt', 'sampling', 'metadata',
      'message_count', 'last_message_at', 'version', 'created_at', 'updated_at',
    ],
  }

  // Base fields are always present; heavy fields are gated behind `?include=` (dto.ts's
  // HEAVY_FIELDS/parseInclude) and therefore MUST NOT be in `required` — that is the exact
  // property openapi.test.ts's fifth test asserts, so a schema written any other way fails it.
  const Message: JsonSchema = {
    type: 'object',
    description: 'One turn (spec 27 §3.2). Heavy fields are omitted unless requested via ?include=.',
    properties: {
      id: { type: 'string' },
      chat_id: { type: 'string' },
      seq: { type: 'integer' },
      role: { type: 'string', enum: ['user', 'assistant'] },
      content: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'streaming', 'complete', 'failed', 'aborted'] },
      version: { type: 'integer' },
      created_at: { type: 'string', format: 'date-time' },
      edited: { type: 'boolean' },
      reasoning: { type: 'string', description: 'Heavy field — include=reasoning.' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Heavy field — include=attachments.' },
      tool_calls: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Heavy field — include=tool_calls.' },
      usage: { type: 'object', additionalProperties: true, description: 'Heavy field — include=usage.' },
      metadata: { type: 'object', additionalProperties: true, description: 'Heavy field — include=metadata.' },
    },
    required: ['id', 'chat_id', 'seq', 'role', 'content', 'status', 'version', 'created_at', 'edited'],
  }

  const Run: JsonSchema = {
    type: 'object',
    description: 'One generation attempt (spec 27 §3.2, §6). The source of truth for a run outcome.',
    properties: {
      id: { type: 'string' },
      chat_id: { type: 'string' },
      message_id: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'streaming', 'complete', 'failed', 'aborted'] },
      event_seq: { type: 'integer', description: 'Seq (SSE `id`) of the latest event; frames are numbered from 1, so 0 means none yet — the resume token (spec §6.3). GET /runs/{id}/stream?after=N sends only frames after N: pass the last SSE `id` you received. Stored only when the status changes, so for a run the daemon no longer holds in memory (about an hour after it ends, or after a restart) it is informational: an ended run reads the seq of its done frame, but a run that was streaming when the daemon stopped reads 0.' },
      error: { type: ['object', 'null'], additionalProperties: true },
      created_at: { type: 'string', format: 'date-time' },
      ended_at: { type: ['string', 'null'], format: 'date-time' },
    },
    required: ['id', 'chat_id', 'message_id', 'status', 'event_seq', 'error', 'created_at', 'ended_at'],
  }

  const Page: JsonSchema = {
    type: 'object',
    description: 'Cursor-paginated collection (spec §5.2). Cursors are opaque base64.',
    properties: {
      data: { type: 'array', items: {} },
      has_more: { type: 'boolean' },
      next_cursor: { type: ['string', 'null'] },
    },
    required: ['data', 'has_more', 'next_cursor'],
  }

  // `type.enum` is spread from EXT_ERROR_TYPES — the same frozen nine values errors.ts exports —
  // so the schema and the runtime enum cannot drift apart the way a hand-copied list would.
  const Error: JsonSchema = {
    type: 'object',
    description: 'The public error envelope (spec 27 §7.1).',
    properties: {
      error: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...EXT_ERROR_TYPES], description: 'Coarse, frozen — a client switches on this.' },
          code: { type: 'string', description: 'Precise, open — new codes are non-breaking.' },
          message: { type: 'string' },
          param: { type: 'string' },
          request_id: { type: 'string' },
          retryable: { type: 'boolean' },
          retry_after_ms: { type: 'integer' },
        },
        required: ['type', 'code', 'message', 'request_id', 'retryable'],
      },
    },
    required: ['error'],
  }

  const Capabilities: JsonSchema = {
    type: 'object',
    properties: {
      capabilities: {
        type: 'object',
        properties: {
          branching: { type: 'boolean' },
          folders: { type: 'boolean' },
          search: { type: 'boolean' },
          batch: { type: 'boolean' },
        },
      },
      limits: {
        type: 'object',
        properties: {
          max_page_size: { type: 'integer' },
          max_body_bytes: { type: 'integer' },
          max_attachments: { type: 'integer' },
        },
      },
    },
    required: ['capabilities', 'limits'],
  }

  const ChatInput: JsonSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      model: { type: 'string' },
      system_prompt: { type: 'string' },
      sampling: { type: 'object', additionalProperties: true },
      metadata: { type: 'object', additionalProperties: true },
      owner: { type: 'string', description: "The integrator's end user. Defaults to 'default'." },
    },
  }

  const ChatPatch: JsonSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      system_prompt: { type: 'string' },
      sampling: { type: 'object', additionalProperties: true },
      metadata: { type: 'object', additionalProperties: true },
      owner: { type: 'string' },
      if_version: { type: 'integer', description: 'Optimistic-concurrency token; mismatch ⇒ 409 version_conflict.' },
    },
  }

  // `content` is intentionally absent from `required` below: the live route code
  // (routes.chats.ts, routes.runs.ts) accepts and persists an attachments-only message with
  // absent/empty `content`, rejecting a request only when BOTH `content` is empty AND
  // `attachments` is empty (`if (!content && !(attachments?.length)) return extError(...)`).
  // JSON Schema has no direct way to express "at least one of these two properties" as part of
  // a flat `required` list, so the real rule is documented in prose on the schema itself instead
  // of encoded as a (misleading) `required: ['content']` that would contradict the server.
  const MessageInput: JsonSchema = {
    type: 'object',
    description: 'At least one of `content` or a non-empty `attachments` array must be present — an attachments-only message with no content is valid and will be persisted as such.',
    properties: {
      role: { type: 'string', enum: ['user', 'assistant'], description: 'Defaults to user. assistant only with generate: false: a turn that starts a run (POST .../messages/generate, or generate omitted or true) must be user, and any other role gets 400 invalid_input.' },
      content: { type: 'string', description: 'Optional if a non-empty `attachments` array is present — at least one of `content` or `attachments` is required.' },
      reasoning: { type: 'string' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'data: URIs. Max 4 per message (spec §4.1). Optional if `content` is present — at least one of `content` or `attachments` is required.' },
      owner: { type: 'string' },
      generate: { type: 'boolean', description: 'Defaults to true. false appends without starting a run.' },
      // Release-gate I6: no route on this surface reads a per-message `sampling` field — only
      // POST /chats and PATCH /chats/:id/messages ("PATCH /chats/:id") ChatInput/ChatPatch's own
      // CHAT-level `sampling` is ever used by generation (generation.ts's `ctx.chat.sampling`).
      // A per-message override was documented and sent by the TS client but silently ignored —
      // removed here (and from the client) rather than freezing a v1 field that does nothing.
      metadata: { type: 'object', additionalProperties: true },
    },
  }

  const MessagePatch: JsonSchema = {
    type: 'object',
    properties: {
      content: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
      owner: { type: 'string' },
      if_version: { type: 'integer' },
    },
  }

  const AuditRow: JsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      owner: { type: 'string' },
      action: { type: 'string', description: 'Dotted verb, e.g. chat.create, message.update, run.start.' },
      target_id: { type: ['string', 'null'] },
      request_id: { type: 'string' },
      status: { type: 'integer' },
      key_prefix: { type: 'string', description: 'First 8 characters of the presented key only.' },
      at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'owner', 'action', 'target_id', 'request_id', 'status', 'key_prefix', 'at'],
  }

  // NOT `pageOf('AuditRow')`: unlike the other List endpoints, GET /audit isn't cursor-paginated
  // — `AuditLog.list()` (audit.ts) takes `limit`/`since`/`before` (a row id), no opaque cursor,
  // and the route (routes.chats.ts) returns exactly `{ data: [...] }`. `pageOf()`'s `allOf: [Page]` would
  // require `has_more`/`next_cursor`, which this response never has (openapi.test.ts's
  // response-fidelity test catches that mismatch directly).
  const AuditPage: JsonSchema = {
    type: 'object',
    description: 'A page of audit rows (spec 27 §10), newest first, at most `limit` (default and max 200). No has_more/next_cursor: page backward by passing the `id` of the oldest row received as `before`, until a page holds fewer than `limit` rows. `since` (ISO timestamp, inclusive) bounds how far back to read.',
    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/AuditRow' } } },
    required: ['data'],
  }

  // NOT `pageOf('Run')`, for the same reason as AuditPage: GET /runs (routes.runs.ts) returns
  // exactly `{ data: [...] }` — no cursor, no has_more/next_cursor.
  const RunPage: JsonSchema = {
    type: 'object',
    description: "The caller's runs. Not cursor-paginated.",
    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Run' } } },
    required: ['data'],
  }

  return {
    Chat, Message, Run, Page, Error,
    Capabilities, ChatInput, ChatPatch, MessageInput, MessagePatch,
    ChatPage: pageOf('Chat'), MessagePage: pageOf('Message'), RunPage,
    AuditRow, AuditPage,
    OpenApiDocument: { type: 'object', description: 'This document itself.', additionalProperties: true },
  }
}

/** Collects the `:param` names out of a Hono-style path. `route.path` itself is kept `:id`-style
 *  everywhere it's used for comparison against a live Hono app (`app.routes[].path`, which the
 *  drift-guard tests rely on matching byte-for-byte) — only `templatePath` (below), used solely
 *  for the OpenAPI `paths` object's own KEY, converts to `{id}`. */
function pathParamNames(path: string): string[] {
  const params: string[] = []
  path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => { params.push(name); return _m })
  return params
}

/** `:id` -> `{id}`, for the `paths` object key ONLY (spec-3.1-required templating). Release-gate
 *  I11: the document previously kept Hono's `:id` syntax in the key itself and declared params
 *  only via a non-standard `x-path-params` extension — a client generated from this document
 *  requested the LITERAL path `/chats/:id`, since no standard OpenAPI tool understands `:id`
 *  templating or that extension field. */
function templatePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

// Every route WITHOUT a requestSchema resolves `owner` from the query string (routes.chats.ts /
// routes.runs.ts's `scopeFor(c, c.req.query('owner'))`) — a route WITH a requestSchema takes it
// from the body instead (already covered by that schema's own `owner` property). These two are
// the only routes with neither: `owner` isn't part of their scope at all.
const NO_OWNER_PARAM_PATHS = new Set(['/capabilities', '/openapi.json'])

function errorResponses(codes: string[]): Record<string, JsonSchema> {
  const statusFor: Record<string, number> = {
    auth: 401, not_found: 404, invalid_request: 400, conflict: 409,
    // `storage` is 500, not errors.ts's defaultStatus 503: its only producer, mapStoreError's
    // storage_contract_violation, sends it with 500.
    capacity: 429, engine: 502, storage: 500, unsupported: 501, internal: 500,
  }
  // Grouped by status: two types can share one (`conflict` and `engine:409`), and the response
  // must name both rather than the last one overwriting the first.
  const typesByStatus: Record<string, string[]> = {}
  for (const entry of codes) {
    const [type, explicit] = entry.split(':')
    const status = explicit ?? String(statusFor[type] ?? 500)
    const types = typesByStatus[status] ?? (typesByStatus[status] = [])
    if (!types.includes(type)) types.push(type)
  }
  const responses: Record<string, JsonSchema> = {}
  for (const [status, types] of Object.entries(typesByStatus)) {
    responses[status] = {
      description: `${types.join(', ')} — see the Error schema's \`type\` enum.`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    }
  }
  return responses
}

/** Deterministic `operationId`, derived from method+path rather than hand-listed per manifest
 *  entry — one less field for a route addition to forget. `:id` params capitalize to `Id`; the
 *  one dotted segment (`openapi.json`) drops its dot rather than producing an invalid
 *  identifier-with-a-dot. */
function operationIdFor(route: RouteSpec): string {
  const segments = route.path.split('/').filter(Boolean).map((seg) => {
    const name = seg.startsWith(':') ? seg.slice(1) : seg.replace(/\./g, '')
    return name.charAt(0).toUpperCase() + name.slice(1)
  })
  return route.method.toLowerCase() + segments.join('')
}

function buildOperation(route: RouteSpec): JsonSchema {
  const successStatus = route.successStatus ?? (
    route.method === 'POST' ? (route.responseSchema ? '201' : '202')
    : route.method === 'DELETE' ? '204'
    : '200'
  )

  // A MediaType object (the value under each content-type key) has no `description` field of
  // its own in OpenAPI 3.1 — only the enclosing Response object does. The SSE event-name note
  // therefore lives on the response's `description`, not attached to the `text/event-stream`
  // entry (an earlier draft put it there and failed redocly's `struct` rule for exactly that
  // reason — Step 5's real-validator pass, not a guess).
  const sseNote = 'Named SSE events: run, delta, reasoning, tool_call, usage, error, done (spec §5.1, §6.3).'
  const sseContent = { 'text/event-stream': { schema: { type: 'string' } } }
  // Hono's streamSSE always answers 200, whatever status the route's JSON answer has. The dual-
  // mode routes listed text/event-stream under their JSON answer's 202, which the stream never
  // sent, so the stream is documented as its own 200 response.
  const sseResponse = { description: `OK. For Accept: text/event-stream. ${sseNote}`, content: sseContent }
  let successResponse: JsonSchema
  if (route.responseSchema && route.sse) {
    // Dual-mode: POST .../messages/generate answers JSON (202) or SSE (200), per Accept (spec §5.1).
    successResponse = {
      description: 'OK.',
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.responseSchema}` } } },
    }
  } else if (route.sse) {
    // SSE-only: GET .../stream never answers JSON (routes.runs.ts calls streamSSE unconditionally).
    successResponse = { description: `OK. ${sseNote}`, content: sseContent }
  } else if (route.responseSchema) {
    successResponse = {
      description: 'OK.',
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.responseSchema}` } } },
    }
  } else {
    successResponse = { description: 'No content.' }
  }

  const responses: Record<string, JsonSchema> = {
    [successStatus]: successResponse,
    ...(route.responseSchema && route.sse ? { '200': sseResponse } : {}),
    ...errorResponses(route.errors),
  }

  // A second, genuinely distinct success response for a route whose shape depends on request
  // BODY content (see RouteSpec.altResponse's own doc comment — currently just
  // POST /chats/:id/messages, whose default path forwards to and mirrors .../messages/generate).
  if (route.altResponse) {
    const alt = route.altResponse
    responses[alt.status] = {
      description: alt.description,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${alt.schema}` } } },
    }
    if (alt.sse) responses['200'] = { ...sseResponse, description: `Default (generate omitted or true) with Accept: text/event-stream. ${sseNote}` }
  }

  // Path params: real `parameters` entries (release-gate I11), not the non-standard
  // `x-path-params` extension this document used to rely on — see templatePath's doc comment.
  const pathParams = pathParamNames(route.path).map((name) => ({
    name, in: 'path', required: true, schema: { type: 'string' },
  }))
  const ownerParam = (!route.requestSchema && !NO_OWNER_PARAM_PATHS.has(route.path))
    ? [{ name: 'owner', in: 'query', required: false, schema: { type: 'string' }, description: "The integrator's end user. Defaults to 'default'." }]
    : []
  const queryParams = (route.query ?? []).map((q) => ({
    name: q.name, in: 'query', required: false, schema: { type: q.type ?? 'string' }, description: q.description,
  }))
  const headerParams = (route.headers ?? []).map((h) => ({
    name: h.name, in: 'header', required: false, schema: { type: h.type ?? 'string' }, description: h.description,
  }))
  const parameters = [...pathParams, ...ownerParam, ...queryParams, ...headerParams]

  const operation: JsonSchema = {
    operationId: operationIdFor(route),
    summary: route.summary,
    ...(route.scope ? { 'x-required-scope': route.scope } : {}),
    ...(route.audited ? { 'x-audited-action': route.audited } : {}),
    ...(parameters.length ? { parameters } : {}),
    responses,
  }

  if (route.requestSchema) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.requestSchema}` } } },
    }
  }

  return operation
}

/** Assembles the full document from EXT_ROUTES alone (see this file's header comment). Every
 *  path/operation pair below is derived from the manifest — nothing here can name a route the
 *  manifest doesn't list, which is the other half of the drift guard (the test file's fourth
 *  test covers the reverse direction: a live route the manifest doesn't list). */
export function buildOpenApiDocument(version: string): {
  openapi: string
  info: { title: string; version: string; license: { name: string; url: string } }
  servers: { url: string; description: string }[]
  components: { securitySchemes: JsonSchema; schemas: Record<string, JsonSchema> }
  security: JsonSchema[]
  paths: Record<string, Record<string, JsonSchema>>
} {
  const paths: Record<string, Record<string, JsonSchema>> = {}

  for (const route of EXT_ROUTES) {
    const key = `/api/ext/v1${templatePath(route.path)}`
    const pathItem = paths[key] ?? (paths[key] = {})
    pathItem[route.method.toLowerCase()] = buildOperation(route)
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboLLM External Chat API',
      version,
      license: { name: 'FSL-1.1-ALv2', url: 'https://github.com/mohitsoni48/TurboLLM/blob/main/LICENSE.md' },
    },
    servers: [
      // Origin only: every `paths` key already starts with /api/ext/v1, and OpenAPI appends the
      // path key to the server URL, so a prefix here would double it (/api/ext/v1/api/ext/v1/...).
      { url: 'http://127.0.0.1:6996', description: 'Default loopback port; configurable per instance.' },
    ],
    components: {
      securitySchemes: {
        // Release-gate I11: this used to document a fictional `tllm-ext-<tenant-prefix>-<secret>`
        // shape — generateApiKey() (auth.ts) has always produced `tllm-` + 40 random
        // alphanumeric characters, with no tenant encoded in the key string itself (the tenant
        // is a separate config.json field on the stored key record). There is currently no
        // dedicated key-minting flow for this API; an operator adds `tenant`/`scopes` to a key
        // entry in config.json directly.
        bearerAuth: { type: 'http', scheme: 'bearer', description: "tllm-<40 random alphanumeric characters> (auth.ts's generateApiKey; spec 27 §10). The tenant is a separate field on the stored key record, not part of the key string. Server-side only — never ship in client JavaScript." },
      },
      schemas: buildSchemas(),
    },
    security: [{ bearerAuth: [] }],
    paths,
  }
}
