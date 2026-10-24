// LiteRT-LM's servers read thinking from a top-level reasoning_effort only (upstream `litert-lm serve` 0.18.0's
// parse_thinking_config; the Android app's server accepts it too). TurboLLM said everything in llama.cpp's shape,
// thinking_budget_tokens and chat_template_kwargs, which serve never reads: the chat's Off, the daemon's own off for
// titles, memory and compaction, a Code budget and Claude Code's thinking setting never reached a .litertlm, and the
// bundle's template default always decided (Qwen3 thinks by default, Gemma 4 does not).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shapeLitertLmThinking, LITERT_LM_REASONING_EFFORTS } from './litert-lm-request'

const shaped = (body: Record<string, unknown>): Record<string, unknown> => {
  const b = structuredClone(body)
  shapeLitertLmThinking(b)
  return b
}

test('thinking off in any of llama.cpp\'s spellings is reasoning_effort none', () => {
  assert.equal(shaped({ thinking_budget_tokens: 0 }).reasoning_effort, 'none')
  assert.equal(shaped({ chat_template_kwargs: { enable_thinking: false } }).reasoning_effort, 'none')
  assert.equal(shaped({ thinking_budget_tokens: 0, chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } }).reasoning_effort, 'none')
  assert.equal(shaped({ chat_template_kwargs: { reasoning_effort: 'off' } }).reasoning_effort, 'none')
})

test('thinking on is an on-level; a level LiteRT-LM takes is sent as that level', () => {
  assert.equal(shaped({ thinking_budget_tokens: 512 }).reasoning_effort, 'medium')
  assert.equal(shaped({ chat_template_kwargs: { enable_thinking: true } }).reasoning_effort, 'medium')
  for (const level of ['low', 'medium', 'xhigh']) assert.equal(shaped({ chat_template_kwargs: { reasoning_effort: level } }).reasoning_effort, level)
})

test('nothing said about thinking sends nothing: the bundle\'s template decides', () => {
  assert.equal('reasoning_effort' in shaped({ messages: [] }), false)
  assert.equal('reasoning_effort' in shaped({ chat_template_kwargs: { preserve_thinking: true } }), false)
})

test('a client\'s own reasoning_effort reaches the server as it is; TurboLLM\'s own Off is none', () => {
  for (const v of LITERT_LM_REASONING_EFFORTS) assert.equal(shaped({ reasoning_effort: v, thinking_budget_tokens: 0 }).reasoning_effort, v)
  assert.equal(shaped({ reasoning_effort: 'ultra' }).reasoning_effort, 'ultra', 'the server answers an unknown one with a 400 naming it')
  assert.equal(shaped({ reasoning_effort: 'off' }).reasoning_effort, 'none')
  // An unset optional (LiteLLM sends null) says nothing: the other fields decide.
  assert.equal(shaped({ reasoning_effort: null, thinking_budget_tokens: 0 }).reasoning_effort, 'none')
})

test('the llama.cpp-shaped fields stay: the Android server takes a budget from them', () => {
  const b = shaped({ thinking_budget_tokens: 512, chat_template_kwargs: { enable_thinking: true } })
  assert.equal(b.thinking_budget_tokens, 512)
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: true })
})
