// Qwen3.8's chat-template reasoning-depth control. 'low'/'medium'/'xhigh' are sent as
// `chat_template_kwargs.reasoning_effort`; the template `raise_exception`s on anything
// outside those three (verified against the real Qwen3.8-27B chat_template.jinja), so every
// caller on the way from client JSON to the engine request must go through this parser
// rather than forwarding a client-supplied string directly. 'off' is NOT a template value —
// it's this control's way of disabling thinking entirely, same as the old thinking-budget
// slider's 0 position. Callers must translate 'off' into `enable_thinking: false` (and,
// for parity with that slider, `thinking_budget_tokens: 0`) instead of ever putting the
// literal string "off" in `reasoning_effort` — the template's `enable_thinking` branch
// wraps the whole `reasoning_effort` read, so once thinking is off the field is never even
// consulted, but it must still never be sent as "off".
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'xhigh'

const VALID = new Set<string>(['off', 'low', 'medium', 'xhigh'])

/** Undefined for anything not exactly one of the four supported values (including
 *  absent/undefined/empty-string input) — callers omit the field entirely rather than
 *  risk sending a value the template rejects. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && VALID.has(value) ? (value as ReasoningEffort) : undefined
}
