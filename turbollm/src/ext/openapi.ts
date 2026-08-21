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
  /** SSE endpoints document `text/event-stream` alongside `application/json` (spec §5.1, §6.3). */
  sse?: boolean
  /** A second possible success response, for the one route whose response shape depends on
   *  request BODY content rather than just the `Accept` header (which `sse` already covers).
   *  `POST /chats/:id/messages` is the sole user: `generate:false` returns this entry's primary
   *  `responseSchema` (`Message`, 201); `generate` omitted or `true` — the default, and the case
   *  spec §5.1 calls "the one endpoint that matters" — forwards internally to
   *  `POST .../messages/generate` and returns THIS shape instead. Documenting only the primary
   *  response would describe the minority code path and silently omit the majority one. */
  altResponse?: { status: string; description: string; schema: string; sse?: boolean }
  errors: string[]
}

// Every route on this surface sits behind routes.chats.ts's blanket per-tenant rate limiter
// (`app.use(BASE/*, ...)`, registered ahead of every route including ones added later by
// routes.runs.ts and mount.ts) — spec §5.4 confirms read AND write traffic is rate limited, so
// `capacity` belongs in the shared read-error set, not just the write one.
const CHAT_ERRORS = ['auth', 'not_found', 'invalid_request', 'capacity']
const WRITE_ERRORS = [...CHAT_ERRORS, 'conflict', 'storage']

export const EXT_ROUTES: RouteSpec[] = [
  // ── routes.chats.ts ───────────────────────────────────────────────────────────────────────
  {
    method: 'GET', path: '/capabilities',
    summary: 'Store capabilities, limits, and model info.',
    // No `requireScope` call, but still behind the blanket extAuth (401) and per-tenant rate
    // limiter (429) middleware routes.chats.ts registers ahead of every route on this surface.
    responseSchema: 'Capabilities', errors: ['auth', 'capacity'],
  },
  {
    method: 'GET', path: '/chats',
    summary: 'List chats, cursor-paginated.',
    scope: 'chats:read', responseSchema: 'ChatPage', errors: CHAT_ERRORS,
  },
  {
    method: 'POST', path: '/chats',
    summary: 'Create a chat.',
    scope: 'chats:write', audited: 'chat.create',
    requestSchema: 'ChatInput', responseSchema: 'Chat', errors: WRITE_ERRORS,
  },
  {
    method: 'GET', path: '/chats/:id',
    summary: 'Fetch one chat.',
    scope: 'chats:read', responseSchema: 'Chat', errors: CHAT_ERRORS,
  },
  {
    method: 'PATCH', path: '/chats/:id',
    summary: 'Update title, system_prompt, sampling, or metadata.',
    scope: 'chats:write', audited: 'chat.update',
    requestSchema: 'ChatPatch', responseSchema: 'Chat', errors: WRITE_ERRORS,
  },
  {
    method: 'DELETE', path: '/chats/:id',
    summary: 'Delete a chat and its messages.',
    scope: 'chats:write', audited: 'chat.delete', errors: WRITE_ERRORS,
  },
  {
    method: 'GET', path: '/chats/:id/messages',
    summary: 'List messages in a chat, cursor-paginated.',
    scope: 'chats:read', responseSchema: 'MessagePage', errors: CHAT_ERRORS,
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
      description: 'Default (generate omitted or true): identical to calling POST .../messages/generate directly — the async Run (JSON) or an SSE stream, per Accept (spec §5.1).',
    },
    errors: [...WRITE_ERRORS, 'engine'],
  },
  {
    method: 'GET', path: '/messages/:id',
    summary: 'Fetch one message.',
    scope: 'chats:read', responseSchema: 'Message', errors: CHAT_ERRORS,
  },
  {
    method: 'PATCH', path: '/messages/:id',
    summary: 'Edit message content.',
    scope: 'chats:write', audited: 'message.update',
    requestSchema: 'MessagePatch', responseSchema: 'Message', errors: WRITE_ERRORS,
  },
  {
    method: 'DELETE', path: '/messages/:id',
    summary: 'Delete a message.',
    scope: 'chats:write', audited: 'message.delete', errors: WRITE_ERRORS,
  },
  {
    method: 'GET', path: '/audit',
    summary: "The tenant's own audit trail of mutations.",
    scope: 'chats:read', responseSchema: 'AuditPage', errors: CHAT_ERRORS,
  },

  // ── routes.runs.ts ────────────────────────────────────────────────────────────────────────
  {
    method: 'POST', path: '/chats/:id/messages/generate',
    summary: 'Start a generation run for a chat (SSE or JSON, per Accept).',
    scope: 'runs:write', audited: 'run.start',
    requestSchema: 'MessageInput', responseSchema: 'Run', sse: true,
    errors: [...WRITE_ERRORS, 'engine'],
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
    summary: "Attach or re-attach to a run's SSE event stream.",
    scope: 'chats:read', sse: true, errors: [...CHAT_ERRORS, 'conflict'],
  },
  {
    method: 'POST', path: '/runs/:id/cancel',
    summary: 'Abort a run.',
    scope: 'runs:write', audited: 'run.cancel', responseSchema: 'Run', errors: WRITE_ERRORS,
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
    responseSchema: 'OpenApiDocument', errors: ['auth', 'capacity'],
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
      event_seq: { type: 'integer', description: 'Monotonic event counter — the resume token (spec §6.3).' },
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
      role: { type: 'string', enum: ['user', 'assistant'] },
      content: { type: 'string', description: 'Optional if a non-empty `attachments` array is present — at least one of `content` or `attachments` is required.' },
      reasoning: { type: 'string' },
      attachments: { type: 'array', items: { type: 'string' }, description: 'data: URIs. Max 4 per message (spec §4.1). Optional if `content` is present — at least one of `content` or `attachments` is required.' },
      owner: { type: 'string' },
      generate: { type: 'boolean', description: 'Defaults to true. false appends without starting a run.' },
      sampling: { type: 'object', additionalProperties: true },
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
  // — `AuditLog.list()` (audit.ts) takes only `limit`/`since`, no cursor, and the route
  // (routes.chats.ts) returns exactly `{ data: [...] }`. `pageOf()`'s `allOf: [Page]` would
  // require `has_more`/`next_cursor`, which this response never has (openapi.test.ts's
  // response-fidelity test catches that mismatch directly).
  const AuditPage: JsonSchema = {
    type: 'object',
    description: 'A page of audit rows (spec 27 §10). Not cursor-paginated — page backward using `since`.',
    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/AuditRow' } } },
    required: ['data'],
  }

  return {
    Chat, Message, Run, Page, Error,
    Capabilities, ChatInput, ChatPatch, MessageInput, MessagePatch,
    ChatPage: pageOf('Chat'), MessagePage: pageOf('Message'), RunPage: pageOf('Run'),
    AuditRow, AuditPage,
    OpenApiDocument: { type: 'object', description: 'This document itself.', additionalProperties: true },
  }
}

/** Collects the `:param` names out of a Hono-style path. The path ITSELF is kept verbatim as
 *  the `paths` key (matching `r.path` byte-for-byte, `:id` included) rather than rewritten to
 *  OpenAPI 3.1's `{param}` template syntax — openapi.test.ts's second test builds its expected
 *  key as `` `/api/ext/v1${r.path}` `` with no translation, so a rewritten key would silently
 *  stop matching the manifest it is supposed to mirror. The trade-off, stated rather than
 *  hidden: strict OpenAPI tooling expects `{param}` templating for path parameters, so this
 *  document intentionally omits per-parameter `parameters` entries (there is no `{id}` for one
 *  to attach to) rather than emit a mismatched declaration that would itself be invalid. */
function pathParamNames(path: string): string[] {
  const params: string[] = []
  path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => { params.push(name); return _m })
  return params
}

function errorResponses(codes: string[]): Record<string, JsonSchema> {
  const responses: Record<string, JsonSchema> = {}
  const statusFor: Record<string, number> = {
    auth: 401, not_found: 404, invalid_request: 400, conflict: 409,
    capacity: 429, engine: 502, storage: 503, unsupported: 501, internal: 500,
  }
  for (const code of codes) {
    const status = String(statusFor[code] ?? 500)
    responses[status] = {
      description: `${code} — see the Error schema's \`type\` enum.`,
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
  const successStatus = route.method === 'POST' ? (route.responseSchema ? '201' : '202')
    : route.method === 'DELETE' ? '204'
    : '200'

  // A MediaType object (the value under each content-type key) has no `description` field of
  // its own in OpenAPI 3.1 — only the enclosing Response object does. The SSE event-name note
  // therefore lives on the response's `description`, not attached to the `text/event-stream`
  // entry (an earlier draft put it there and failed redocly's `struct` rule for exactly that
  // reason — Step 5's real-validator pass, not a guess).
  const sseNote = 'Named SSE events: run, delta, reasoning, tool_call, usage, error, done (spec §5.1, §6.3).'
  const sseContent = { 'text/event-stream': { schema: { type: 'string' } } }
  let successResponse: JsonSchema
  if (route.responseSchema && route.sse) {
    // Dual-mode: POST .../messages/generate answers JSON (202) or SSE, per Accept (spec §5.1).
    successResponse = {
      description: `OK. For Accept: text/event-stream, ${sseNote}`,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${route.responseSchema}` } },
        ...sseContent,
      },
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
    ...errorResponses(route.errors),
  }

  // A second, genuinely distinct success response for a route whose shape depends on request
  // BODY content (see RouteSpec.altResponse's own doc comment — currently just
  // POST /chats/:id/messages, whose default path forwards to and mirrors .../messages/generate).
  if (route.altResponse) {
    const alt = route.altResponse
    responses[alt.status] = {
      description: alt.description,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${alt.schema}` } },
        ...(alt.sse ? sseContent : {}),
      },
    }
  }

  const operation: JsonSchema = {
    operationId: operationIdFor(route),
    summary: route.summary,
    ...(route.scope ? { 'x-required-scope': route.scope } : {}),
    ...(route.audited ? { 'x-audited-action': route.audited } : {}),
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
    const key = `/api/ext/v1${route.path}`
    const pathItem = paths[key] ?? (paths[key] = {})
    const operation = buildOperation(route)
    // Documented as an extension field rather than a `parameters: [{in: 'path', ...}]` entry —
    // see pathParamNames' own doc comment on why: the path key deliberately keeps `:id` rather
    // than `{id}`, and OpenAPI requires an `in: path` parameter to correspond to a `{...}`
    // template expression that literally isn't in this key.
    const params = pathParamNames(route.path)
    if (params.length) operation['x-path-params'] = params
    pathItem[route.method.toLowerCase()] = operation
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboLLM External Chat API',
      version,
      license: { name: 'FSL-1.1-ALv2', url: 'https://github.com/mohitsoni48/TurboLLM/blob/main/LICENSE.md' },
    },
    servers: [
      { url: 'http://127.0.0.1:6996/api/ext/v1', description: 'Default loopback port; configurable per instance.' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'tllm-ext-<tenant-prefix>-<secret> (spec 27 §10). Server-side only — never ship in client JavaScript.' },
      },
      schemas: buildSchemas(),
    },
    security: [{ bearerAuth: [] }],
    paths,
  }
}
