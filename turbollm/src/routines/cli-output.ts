// Parses `claude -p ... --output-format stream-json`'s stdout: newline-delimited JSON events,
// the last of which (per Claude Code's documented headless-mode contract) is a single
// `{"type":"result", "is_error": boolean, "result": string, ...}` event carrying the final
// answer text and outcome. Every event BEFORE that one (system/init, assistant/tool-use deltas)
// is intentionally ignored here — a routine's stored result is the final answer, not a full
// transcript replay (unlike code-run-manager.ts's live ring-buffer tail, which a routine run
// has no equivalent of yet; storing a full routine transcript is deliberately out of scope for
// spec 20 v1, §9).
//
// This shape is taken from the CLI's documented headless contract, NOT measured against a real
// binary: every field below is therefore treated as untrusted and type-guarded rather than
// asserted. If the gated ROUTINE_CLI_SMOKE=1 smoke test (cli-routine.smoke.test.ts) ever finds a
// different real shape, only this file needs to change.

export interface ParsedCliResult {
  success: boolean
  resultText: string
  sessionId?: string
}

/** Deliberately `unknown` rather than the documented `boolean`/`string`: these values come out of
 *  `JSON.parse` on a subprocess's stdout, so declaring the expected types here would make the
 *  guards below look redundant to the compiler while doing nothing at runtime. `unknown` makes
 *  each guard load-bearing — removing one stops compiling. */
interface StreamJsonResultEvent {
  type: 'result'
  is_error?: unknown
  result?: unknown
  session_id?: unknown
}

function isResultEvent(v: unknown): v is StreamJsonResultEvent {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'result'
}

const NO_OUTPUT_PLACEHOLDER = '(no output)'
const RAW_FALLBACK_MAX_CHARS = 2000

export function parseClaudeCliStreamJson(stdout: string): ParsedCliResult {
  // `.trim()` per line rather than splitting on /\r?\n/: it handles the CRLF the CLI emits on
  // Windows and any stray indentation in the same pass, and drops blank lines via the filter.
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  let lastResult: StreamJsonResultEvent | null = null

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (isResultEvent(parsed)) lastResult = parsed
    } catch {
      // Non-JSON noise (a stray log line, a warning printed before the CLI settles into
      // stream-json mode) — never fatal, just skipped.
    }
  }

  if (lastResult) {
    return {
      // Only a literal `false` (or an absent field) counts as success. `is_error !== true` would
      // read the STRING "true" — a plausible shape from a JSON producer that stringifies flags —
      // as a successful run, i.e. it fails open on exactly the field that decides the outcome.
      success: lastResult.is_error === undefined ? true : lastResult.is_error === false,
      // A missing OR non-string `result` collapses to '' rather than being passed through:
      // `resultText` is declared `string` and is written straight to RoutineRun.result, so a
      // stray object here would otherwise surface downstream as the literal "[object Object]".
      resultText: typeof lastResult.result === 'string' ? lastResult.result : '',
      // Same guard, same reason: `sessionId` is declared `string | undefined` and is what a
      // later resume is keyed on, so a non-string must become "no session", not a typed lie.
      sessionId: typeof lastResult.session_id === 'string' ? lastResult.session_id : undefined,
    }
  }

  const trimmed = stdout.trim()
  return {
    success: false,
    resultText: trimmed ? trimmed.slice(0, RAW_FALLBACK_MAX_CHARS) : NO_OUTPUT_PLACEHOLDER,
  }
}
