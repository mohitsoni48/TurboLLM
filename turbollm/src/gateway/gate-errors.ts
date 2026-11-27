// How a failed `gate.acquire()` is described to the client, shared by every gateway path that queues for the engine.
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Classifies a `gate.acquire()` failure into one {status, type, message} shape shared by both
 *  the streaming (SSE `error` event, ADR-347 — `status` unused there, a stream is always 200 by
 *  the time it can fail this way) and non-streaming (JSON error response, where `status` is what
 *  the client actually sees) call sites, so `type`/`message` wording can't silently drift between
 *  them. The gate-acquire and fetch() SEQUENCES themselves remain two separate copies (streaming
 *  needs to open the SSE connection before either call; non-streaming doesn't) — this only
 *  centralizes how a failure from either gets described. */
export function classifyGateError(e: unknown): { status: ContentfulStatusCode; type: string; message: string } {
  const aborted = (e as Error).message === 'gate_acquire_aborted'
  return aborted
    ? { status: 400, type: 'invalid_request_error', message: 'Client disconnected while queued for the engine.' }
    : { status: 503, type: 'overloaded_error', message: 'Timed out waiting for a free engine slot.' }
}

/** The same failure as an OpenAI-protocol client of /v1/chat/completions is told it: that endpoint's errors are all
 *  `api_error`s with a code, whether the request is proxied to the engine or answered here (audio replies). */
export function openAiChatGateError(e: unknown): { status: 400 | 503; error: { message: string; type: 'api_error'; code: 'client_disconnected' | 'engine_busy' } } {
  return (e as Error).message === 'gate_acquire_aborted'
    ? { status: 400, error: { message: 'Client disconnected while queued for the engine.', type: 'api_error', code: 'client_disconnected' } }
    : { status: 503, error: { message: 'Timed out waiting for a free engine slot.', type: 'api_error', code: 'engine_busy' } }
}
