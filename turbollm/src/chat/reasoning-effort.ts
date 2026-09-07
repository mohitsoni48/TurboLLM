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

// 'high' is the OpenAI-standard `reasoning_effort` enum value (low/medium/high) that generic
// OpenAI-compatible clients — opencode, LiteLLM, plain SDK scripts — send natively; Qwen3.8's
// own template only ever recognizes the literal string 'xhigh' and `raise_exception`s on
// anything else (GitHub #213: a client-side 'high' variant otherwise 500s the whole turn, or
// silently never applies on an engine build old enough to forward it raw). Aliased here, in
// the one shared parser, so every caller gets it for free rather than each reimplementing it.
// A `Map`, not a plain object: a plain-object lookup (`ALIASES[value]`) resolves inherited
// `Object.prototype` members for a key like 'constructor' or '__proto__', handing back a
// function or `Object.prototype` itself instead of `undefined` — which this parser's callers
// then write straight into `chat_template_kwargs.reasoning_effort`, the exact `raise_exception`
// this function exists to prevent. A `Map` has no prototype-chain lookup, so no key can do that.
const ALIASES = new Map<string, ReasoningEffort>([['high', 'xhigh']])

/** Undefined for anything not exactly one of the four supported values or the 'high' alias
 *  (including absent/undefined/empty-string input) — callers omit the field entirely rather
 *  than risk sending a value the template rejects. */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  if (VALID.has(value)) return value as ReasoningEffort
  return ALIASES.get(value)
}
