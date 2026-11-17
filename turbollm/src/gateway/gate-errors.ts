// How a failed `gate.acquire()` is described to the client, shared by every gateway path that queues for the engine.
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export /** Classifies a `gate.acquire()` failure into one {status, type, message} shape shared by both
 *  the streaming (SSE `error` event, ADR-347 — `status` unused there, a stream is always 200 by
 *  the time it can fail this way) and non-streaming (JSON error response, where `status` is what
 *  the client actually sees) call sites, so `type`/`message` wording can't silently drift between
 *  them. The gate-acquire and fetch() SEQUENCES themselves remain two separate copies (streaming
 *  needs to open the SSE connection before either call; non-streaming doesn't) — this only
 *  centralizes how a failure from either gets described. */
function classifyGateError(e: unknown): { status: ContentfulStatusCode; type: string; message: string } {
  const aborted = (e as Error).message === 'gate_acquire_aborted'
  return aborted
    ? { status: 400, type: 'invalid_request_error', message: 'Client disconnected while queued for the engine.' }
    : { status: 503, type: 'overloaded_error', message: 'Timed out waiting for a free engine slot.' }
}
