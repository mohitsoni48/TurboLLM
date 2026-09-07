// Unit coverage for the one shared client-value parser (see reasoning-effort.ts's own doc
// comment: every caller from client JSON to an engine request must go through this rather
// than forwarding a client-supplied string directly, since Qwen3.8's chat template
// `raise_exception`s on anything outside 'low'/'medium'/'xhigh').
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseReasoningEffort } from './reasoning-effort'

test('parseReasoningEffort accepts the four template-native values verbatim', () => {
  assert.equal(parseReasoningEffort('off'), 'off')
  assert.equal(parseReasoningEffort('low'), 'low')
  assert.equal(parseReasoningEffort('medium'), 'medium')
  assert.equal(parseReasoningEffort('xhigh'), 'xhigh')
})

test("parseReasoningEffort aliases the OpenAI-standard 'high' to Qwen3.8's 'xhigh' (GitHub #213)", () => {
  // Generic OpenAI-compatible clients (opencode, LiteLLM, plain SDK scripts) speak the
  // standard low/medium/high vocabulary — 'high' is not a value the template itself
  // recognizes (it would raise_exception), so the parser must translate it rather than
  // reject it outright.
  assert.equal(parseReasoningEffort('high'), 'xhigh')
})

test('parseReasoningEffort rejects anything else, including near-misses and non-strings', () => {
  for (const bad of ['xhigh ', 'Low', 'HIGH', 'ultra', '', null, undefined, 42, {}, ['low']]) {
    assert.equal(parseReasoningEffort(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`)
  }
})
