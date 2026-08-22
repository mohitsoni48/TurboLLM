// The public error envelope (spec 27 §7.1). `type` is a FROZEN nine-value set an integrator
// switches on; `code` is open, so a new failure mode is describable without a major version.
import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
// Side-effect-only type import — see audit.ts's identical one for why: pulls in
// hono/request-id's `declare module 'hono' { interface ContextVariableMap { requestId:
// string } }` augmentation so `c.get('requestId')` below is typed.
import type {} from 'hono/request-id'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { StoreError } from '../chat/store/chat-store.js'

export const EXT_ERROR_TYPES = [
  'invalid_request', 'auth', 'not_found', 'conflict',
  'capacity', 'engine', 'storage', 'unsupported', 'internal',
] as const

export type ExtErrorType = (typeof EXT_ERROR_TYPES)[number]

export interface MappedError {
  status: number
  type: ExtErrorType
  code: string
  message: string
  retryable: boolean
}

export function requestId(): string {
  return `req_${randomUUID()}`
}

export function extError(
  c: Context,
  type: ExtErrorType,
  code: string,
  message: string,
  opts?: { status?: number; retryable?: boolean; retryAfterMs?: number; param?: string },
) {
  const status = opts?.status ?? defaultStatus(type)
  // Prefer the id hono/request-id already resolved for this request (routes.chats.ts mounts
  // it ahead of everything else on /api/ext/v1/*, honoring an inbound X-Request-Id or
  // generating one) — that's what lets a support report correlate this error response with
  // the audit trail row auditMiddleware records for the SAME request (audit.ts). Falls back to
  // a fresh id only if extError is ever reached from somewhere that middleware doesn't cover.
  const id = (c.get('requestId') as string | undefined) ?? requestId()
  if (opts?.retryAfterMs) c.header('Retry-After', String(Math.ceil(opts.retryAfterMs / 1000)))
  return c.json({
    error: {
      type, code, message,
      ...(opts?.param ? { param: opts.param } : {}),
      request_id: id,
      retryable: opts?.retryable ?? false,
      ...(opts?.retryAfterMs ? { retry_after_ms: opts.retryAfterMs } : {}),
    },
  }, status as ContentfulStatusCode)
}

function defaultStatus(type: ExtErrorType): number {
  switch (type) {
    case 'invalid_request': return 400
    case 'auth': return 401
    case 'not_found': return 404
    case 'conflict': return 409
    case 'capacity': return 503
    case 'engine': return 502
    case 'storage': return 503
    case 'unsupported': return 501
    case 'internal': return 500
  }
}

/** The app-wide `app.onError` handler (wired once, in `server.ts` — `createApp` has the full
 *  reasoning). Extracted as a pure, directly-testable function rather than an inline closure so
 *  a test can exercise it without standing up a full `Deps`/`createApp()` harness — mirrors
 *  `generation.ts`'s `shouldFlushCheckpoint`/`extractChunkUsage` precedent for the same reason.
 *  Scoped to only reshape `/api/ext/v1/*` responses (the one surface with a documented,
 *  machine-checked error-envelope contract); every other route falls through to Hono's own
 *  default behavior (an `HTTPException`'s own response if it has one, else a logged plain-text
 *  500) — copied verbatim from Hono's own default `errorHandler` so this stays a strict backstop
 *  for the ext API, not a whole-server behavior change. */
export function extErrorHandler(err: unknown, c: Context): Response {
  if (c.req.path.startsWith('/api/ext/v1/')) {
    return extError(c, 'internal', 'internal', 'An unexpected error occurred.', { status: 500 })
  }
  if (err && typeof err === 'object' && 'getResponse' in err) {
    const res = (err as { getResponse: () => Response }).getResponse()
    return c.newResponse(res.body, res)
  }
  console.error(err)
  return c.text('Internal Server Error', 500)
}

/** Translate a store failure into the public catalogue (spec 27 §7.2). An error that is not a
 *  StoreError is deliberately flattened to a generic `internal` — a raw message could carry
 *  SQL, filesystem paths, or another tenant's ids. */
export function mapStoreError(e: unknown): MappedError {
  if (e instanceof StoreError) {
    switch (e.code) {
      case 'not_found':
        return { status: 404, type: 'not_found', code: 'not_found', message: 'Not found.', retryable: false }
      case 'version_conflict':
        return { status: 409, type: 'conflict', code: 'version_conflict', message: e.message, retryable: true }
      case 'not_supported':
        return { status: 501, type: 'unsupported', code: 'not_supported', message: e.message, retryable: false }
      case 'invalid_scope':
        return { status: 400, type: 'invalid_request', code: 'invalid_scope', message: e.message, retryable: false }
      case 'contract_violation':
        return { status: 500, type: 'storage', code: 'storage_contract_violation', message: 'The configured chat store returned data that violates the store contract.', retryable: false }
      case 'invalid_cursor':
        return { status: 400, type: 'invalid_request', code: 'invalid_cursor', message: 'The provided cursor is not valid.', retryable: false }
    }
  }
  return {
    status: 500, type: 'internal', code: 'internal',
    message: 'An unexpected error occurred.', retryable: false,
  }
}
