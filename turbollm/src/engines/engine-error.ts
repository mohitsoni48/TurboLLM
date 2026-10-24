// What an engine said when it refused or failed a request, for the user to read: the chat, the extension API and
// routines all report it. The chat read only the response body, and the extension API and routines read nothing at
// all ("Engine returned 400"), so a refusal's reason never reached the user. Upstream's `litert-lm serve` puts it in the
// HTTP status line ("400 Missing model", "400 Invalid sampler parameters: ValueError: top_k should be positive, but got
// 0.", "500 RuntimeError: Failed to create conversation"), with Python's stock HTML error page as the body, which the
// chat showed in the reason's place. A reason that ends with a newline (every exception's text does) ends the status
// line early: a strict HTTP client, the daemon's own among them, refuses such a reply ("fetch failed"), and a lenient
// one reads the page's own headers ("Server: BaseHTTP/0.6 ...") into the body, past which the page is read here.
import { STATUS_CODES } from 'node:http'
import type { Deps } from '../deps'
import { litertLmTurnErrorMessage } from './litert-lm'
import { redactLocalPaths } from '../util/redact-paths'

/** The error message an SSE chunk carries, if it is an error chunk: `{"error": "…"}` or `{"error": {"message": "…"}}`. */
export function streamChunkError(chunk: Record<string, unknown>): string | null {
  const err = chunk.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
    return JSON.stringify(err)
  }
  return null
}

/** An HTML error page's "Message: …" line (Python's http.server, which upstream `litert-lm serve` answers every error
 *  with), unescaped; '' when it has none. */
function htmlPageMessage(text: string): string {
  const m = /<p>\s*Message:\s*([\s\S]*?)\.?\s*<\/p>/i.exec(text)
  if (!m) return ''
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim()
}

/** The engine's own reason for a response that is not OK: from its body, `{"error": …}` (OpenAI, llama.cpp, the
 *  Android app's LiteRT-LM), else `{"message": …}` (vLLM) / `{"detail": …}` (FastAPI), else the raw text; with no body,
 *  or an HTML error page for one (`litert-lm serve`), the status line's reason when it is the engine's own rather than
 *  HTTP's stock phrase ("Bad Request"), else the page's "Message:". At most 500 characters; '' when the engine said
 *  nothing. Reads the body. */
export async function engineErrorReason(res: Response): Promise<string> {
  let text = ''
  try { text = await res.text() } catch { /* no body */ }
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  const msg = obj
    ? streamChunkError(obj) ?? (typeof obj.message === 'string' ? obj.message : typeof obj.detail === 'string' ? obj.detail : null)
    : null
  const status = res.statusText.trim()
  const fromStatus = status && status !== STATUS_CODES[res.status] ? status : ''
  // A page is the HTTP server's, not the engine's words (and may carry its own headers, see the top of this file).
  if (msg === null && /<!DOCTYPE html|<html[\s>]/i.test(text)) return (fromStatus || htmlPageMessage(text)).slice(0, 500)
  const fromBody = (msg ?? text).trim()
  return (fromBody || fromStatus).slice(0, 500)
}

/** An engine's error text as a user sees it: the LiteRT-LM context hint where it applies, and local paths redacted
 *  (redactLocalPaths), since it reaches every client of the conversation, a Turbo Link peer's and an integrator's
 *  included. */
export function engineErrorText(d: Pick<Deps, 'manager' | 'store'>, engineKind: string, raw: string): string {
  return redactLocalPaths(d, engineKind === 'litert-lm' ? litertLmTurnErrorMessage(raw) : raw)
}
