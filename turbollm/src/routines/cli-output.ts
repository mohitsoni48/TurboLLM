// Parses `claude -p ... --output-format stream-json`'s stdout: newline-delimited JSON events,
// the last of which (per Claude Code's documented headless-mode contract) is a single
// `{"type":"result", "is_error": boolean, "result": string, ...}` event carrying the final
// answer text and outcome. Every event BEFORE that one (system/init, assistant/tool-use deltas)
// is intentionally ignored here — a routine's stored result is the final answer, not a full
// transcript replay (unlike code-run-manager.ts's live ring-buffer tail, which a routine run
// has no equivalent of yet — see this plan's Self-review notes on transcript storage).
//
// UNVERIFIED against a real binary as of this plan (see this plan's Investigation findings §3)
// — if the gated ROUTINE_CLI_SMOKE=1 smoke test (cli-routine.smoke.test.ts) ever finds a
// different real shape, only this file needs to change.

export interface ParsedCliResult {
  success: boolean
  resultText: string
  sessionId?: string
}

interface StreamJsonResultEvent {
  type: 'result'
  is_error?: boolean
  result?: string
  session_id?: string
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
      success: lastResult.is_error !== true,
      // A missing OR non-string `result` collapses to '' rather than being passed through:
      // `resultText` is declared `string` and is written straight to RoutineRun.result, so a
      // stray object here would otherwise surface downstream as the literal "[object Object]".
      resultText: typeof lastResult.result === 'string' ? lastResult.result : '',
      sessionId: lastResult.session_id,
    }
  }

  const trimmed = stdout.trim()
  return {
    success: false,
    resultText: trimmed ? trimmed.slice(0, RAW_FALLBACK_MAX_CHARS) : NO_OUTPUT_PLACEHOLDER,
  }
}
