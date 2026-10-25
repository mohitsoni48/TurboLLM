// LiteRT-LM's servers read thinking from a top-level reasoning_effort only (upstream `litert-lm serve` 0.18.0's
// parse_thinking_config; the Android app's server accepts it too). TurboLLM said everything in llama.cpp's shape,
// thinking_budget_tokens and chat_template_kwargs, which serve never reads: the chat's Off, the daemon's own off for
// titles, memory and compaction, a Code budget and Claude Code's thinking setting never reached a .litertlm, and the
// bundle's template default always decided (Qwen3 thinks by default, Gemma 4 does not).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  shapeLitertLmThinking, LITERT_LM_REASONING_EFFORTS, LITERT_LM_NO_TOOL_CALLING_NOTE, litertLmToolsFor,
  litertLmRequestSampling, litertLmSamplingNote, rememberLitertLmModel, shapeLitertLmRequest, litertLmIgnoredFieldsNote,
  shapeLitertLmToolChoice,
} from './litert-lm-request'
import { webSearchTool, FETCH_URL_TOOL, RUN_CODE_TOOL } from '../tools/builtin'
import { CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL, DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL } from '../routines/routine-tools'
import { LIST_AGENTS_TOOL, CREATE_AGENT_TOOL } from '../chat/chat-agent-tools'
import { LIST_MODELS_TOOL } from '../models/model-tools'

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

// ── tools ─────────────────────────────────────────────────────────────────────────────────────

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: 'd', parameters: { type: 'object' } } })

test('litertLmToolsFor: a model that calls tools gets them; one whose template cannot show them gets none, with a note', () => {
  const tools = [tool('web_search'), tool('fetch_url')]
  const messages = [{ role: 'user', content: 'hi' }]
  assert.deepEqual(litertLmToolsFor({ toolCalls: true }, tools, messages, 4096), { tools })
  // Unknown (a model loaded by path, a header that says nothing): the engine decides, as for any model.
  assert.deepEqual(litertLmToolsFor(undefined, tools, messages, 4096), { tools })
  assert.deepEqual(litertLmToolsFor({}, tools, messages, 0), { tools })
  assert.deepEqual(litertLmToolsFor({ toolCalls: false }, tools, messages, 4096), { tools: [], note: LITERT_LM_NO_TOOL_CALLING_NOTE })
  // No tools, no note.
  assert.deepEqual(litertLmToolsFor({ toolCalls: false }, [], messages, 4096), { tools: [] })
})

test('litertLmToolsFor: tools that do not fit in the model\'s context with the conversation are not sent, and the note says so', () => {
  // TurboLLM's own chat tools take about 3,600 tokens: in a 4096-token bundle (every litert-community one read here)
  // they leave no room, and the runtime refuses the turn ("Input token ids are too long"), a chat that worked.
  const own = [webSearchTool(), FETCH_URL_TOOL, RUN_CODE_TOOL, CREATE_ROUTINE_TOOL, LIST_ROUTINES_TOOL, UPDATE_ROUTINE_TOOL,
    DELETE_ROUTINE_TOOL, RUN_ROUTINE_NOW_TOOL, LIST_AGENTS_TOOL, CREATE_AGENT_TOOL, LIST_MODELS_TOOL]
  const messages = [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is new in Rust?' }]
  const small = litertLmToolsFor({ toolCalls: true }, own, messages, 4096)
  assert.deepEqual(small.tools, [])
  assert.match(small.note ?? '', /^The tools \(about [\d,]+ tokens\) do not fit in this model's 4,096-token context/)
  // The same tools in Qwen3-0.6B_dynamic opened at 16k fit; so do two tools in 4096.
  assert.equal(litertLmToolsFor({ toolCalls: true }, own, messages, 16384).tools.length, own.length)
  assert.equal(litertLmToolsFor({ toolCalls: true }, own.slice(1, 3), messages, 4096).tools.length, 2)
  // The conversation counts too, text parts and earlier calls included; an image part's data does not.
  const long = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(12000) }] }]
  assert.deepEqual(litertLmToolsFor({ toolCalls: true }, own.slice(1, 3), long, 4096).tools, [])
  const image = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(50000) } }, { type: 'text', text: 'what is this?' }] }]
  assert.equal(litertLmToolsFor({ toolCalls: true }, own.slice(1, 3), image, 4096).tools.length, 2)
  const calls = [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'fetch_url', arguments: 'y'.repeat(12000) } }] }]
  assert.deepEqual(litertLmToolsFor({ toolCalls: true }, own.slice(1, 3), calls, 4096).tools, [])
})

test('litertLmToolsFor: a past answer\'s reasoning_content, which a template may show, counts toward the conversation', () => {
  // The chat sends a LiteRT-LM model its past reasoning there (chat-compaction.ts buildEngineMessages).
  const two = [webSearchTool(), FETCH_URL_TOOL]
  const answered = [{ role: 'assistant', content: 'Paris.', reasoning_content: 'z'.repeat(12000) }, { role: 'user', content: 'And Italy?' }]
  assert.deepEqual(litertLmToolsFor({ toolCalls: true }, two, answered, 4096).tools, [])
  assert.equal(litertLmToolsFor({ toolCalls: true }, two, [{ role: 'assistant', content: 'Paris.' }, { role: 'user', content: 'And Italy?' }], 4096).tools.length, 2)
})

// ── sampling ──────────────────────────────────────────────────────────────────────────────────

const QWEN3 = '/models/Qwen3-0.6B.litertlm'
const LFM2 = '/models/LFM2.5-230M_int8.litertlm'
const req = (model: string, fields: Record<string, unknown>): Record<string, unknown> => shapeLitertLmRequest({ model, messages: [], ...fields })
const sampling = (b: Record<string, unknown>) => Object.fromEntries(['temperature', 'top_p', 'top_k', 'seed'].filter((k) => k in b).map((k) => [k, b[k]]))

test('litertLmRequestSampling: a model\'s saved Sampling in the request fields LiteRT-LM reads', () => {
  assert.deepEqual(litertLmRequestSampling({ temp: 0.3, topK: 64 }), { temperature: 0.3, top_k: 64 })
  assert.deepEqual(litertLmRequestSampling({}), {})
})

test('a request to a LiteRT-LM model carries the sampling the user saved for it, under the request\'s own', () => {
  // LiteRT-LM takes sampling per request only: the model's Sampling settings reached none of its requests.
  rememberLitertLmModel(QWEN3, { sampling: { temperature: 0.3, top_k: 64 }, native: false })
  assert.deepEqual(sampling(req(QWEN3, {})), { temperature: 0.3, top_k: 64 })
  assert.deepEqual(sampling(req(QWEN3, { temperature: 0.9, top_k: null })), { temperature: 0.9, top_k: 64 }, 'a thread\'s or client\'s value wins; null is unset')
  assert.deepEqual(sampling(req('/models/other.litertlm', {})), {}, 'a model not loaded here: nothing')
})

test('a request that sets part of the sampler gets the rest from the bundle\'s own: a temperature alone is no longer greedy', () => {
  // `serve` fills what a request leaves out with top_k 1, top_p 0.95, temperature 1.0: Qwen3's 20 / 0.95 / 0.6 was gone
  // and top_k 1 is greedy, so the thread's temperature did nothing.
  rememberLitertLmModel(QWEN3, { sampling: {}, sampler: { topK: 20, topP: 0.95, temp: 0.6 }, native: false })
  assert.deepEqual(sampling(req(QWEN3, { temperature: 0.7 })), { temperature: 0.7, top_k: 20, top_p: 0.95 })
  assert.deepEqual(sampling(req(QWEN3, { seed: 7 })), { seed: 7, top_k: 20, top_p: 0.95, temperature: 0.6 })
  assert.deepEqual(sampling(req(QWEN3, { top_k: 5 })), { top_k: 5, top_p: 0.95, temperature: 0.6 })
  // Nothing set: nothing sent, so the runtime samples with the bundle's own as it is.
  assert.deepEqual(sampling(req(QWEN3, {})), {})
  // A bundle with none of its own: nothing added (its servers' fill is the runtime's own default).
  rememberLitertLmModel(LFM2, { sampling: {}, native: false })
  assert.deepEqual(sampling(req(LFM2, { temperature: 0.7 })), { temperature: 0.7 })
})

test('a temperature a LiteRT-LM model ignores is said: no sampler of its own and no top_k is greedy on serve', () => {
  rememberLitertLmModel(LFM2, { sampling: {}, native: false })
  const note = litertLmSamplingNote({ model: LFM2, temperature: 0.7 })
  assert.match(note ?? '', /decodes it greedily \(Top K 1\)/)
  assert.equal(litertLmSamplingNote({ model: LFM2, temperature: 0.7, top_k: 40 }), undefined, 'a top_k is set')
  assert.equal(litertLmSamplingNote({ model: LFM2 }), undefined, 'nothing set: the model\'s own')
  assert.equal(litertLmSamplingNote({ model: LFM2, temperature: 0 }), undefined, 'temperature 0 is greedy anyway')
  rememberLitertLmModel(LFM2, { sampling: { temperature: 0.5 }, native: false })
  assert.ok(litertLmSamplingNote({ model: LFM2 }), 'the model\'s saved temperature counts')
  // The Android app's server samples such a request with no top-k limit itself; a bundle with its own sampler is completed.
  rememberLitertLmModel(LFM2, { sampling: {}, native: true })
  assert.equal(litertLmSamplingNote({ model: LFM2, temperature: 0.7 }), undefined)
  rememberLitertLmModel(QWEN3, { sampling: {}, sampler: { topK: 20, topP: 0.95, temp: 0.6 }, native: false })
  assert.equal(litertLmSamplingNote({ model: QWEN3, temperature: 0.7 }), undefined)
})

// ── settings LiteRT-LM reads under other names, or not at all ───────────────────────────────────

test('litertLmRequestSampling: the penalties and stop, the repeat penalty as llama.cpp\'s repeat_penalty, as a thread\'s', () => {
  // The Repeat penalty is llama.cpp's: the Android server applies repeat_penalty over llama.cpp's last 64 tokens, and
  // repetition_penalty over the whole reply.
  assert.deepEqual(
    litertLmRequestSampling({ repeatPenalty: 1.1, presencePenalty: 0.5, frequencyPenalty: 0.2, stop: ['###'] }),
    { repeat_penalty: 1.1, presence_penalty: 0.5, frequency_penalty: 0.2, stop: ['###'] },
  )
  assert.deepEqual(litertLmRequestSampling({ stop: [] }), {})
})

test('Top K 0 is no top-k limit on `serve`, which refuses a top_k below 1: the largest top_k there is', () => {
  // `serve` answered {"top_k": 0} with 400 "top_k should be positive, but got 0", though the dialogs offer 0 (llama.cpp's
  // "disabled") and the Android app's server takes it as no limit.
  const M = '/models/q.litertlm'
  rememberLitertLmModel(M, { sampling: {}, native: false })
  assert.equal(req(M, { top_k: 0 }).top_k, 2147483647, 'the CPU sampler clamps it to the vocabulary')
  assert.equal(req(M, { top_k: -1 }).top_k, 2147483647)
  assert.equal(req(M, { top_k: 40 }).top_k, 40)
  rememberLitertLmModel(M, { sampling: { top_k: 0 }, native: false })
  assert.equal(req(M, {}).top_k, 2147483647, 'a saved Top K 0 too')
  rememberLitertLmModel(M, { sampling: {}, native: true })
  assert.equal(req(M, { top_k: 0 }).top_k, 0, 'the Android server maps it itself')
})

test('a Min P saved on a LiteRT-LM model is carried and said, not dropped: LiteRT-LM has no Min P', () => {
  // The model dialog offers no Min P for LiteRT-LM, but one saved before (or an earlier build's whole profile's) stays in
  // the profile: it went nowhere, and nothing said so. Sent, it is named as not applied (by the chat's note, the
  // gateway's header on `serve`, the Android app's server's own header).
  assert.deepEqual(litertLmRequestSampling({ minP: 0.2 }), { min_p: 0.2 })
  assert.deepEqual(litertLmRequestSampling({ minP: 0 }), {}, 'Min P 0 is off')
  const M = '/models/q.litertlm'
  rememberLitertLmModel(M, { sampling: litertLmRequestSampling({ minP: 0.2 }), native: false })
  assert.equal(req(M, {}).min_p, 0.2)
  // Named as the model's own setting, which the chat does not show, and where to clear it.
  assert.equal(
    litertLmIgnoredFieldsNote({ model: M }),
    'This LiteRT-LM server (litert-lm serve) does not apply the Min P saved in this model\'s settings: this reply was ' +
      'written without it. The Android app\'s LiteRT-LM applies stop strings and penalties; no LiteRT-LM has Min P. ' +
      'Clear that Min P under Models → the model\'s Load settings and reload the model.',
  )
  rememberLitertLmModel(M, { sampling: litertLmRequestSampling({ minP: 0.2 }), native: true })
  assert.equal(
    litertLmIgnoredFieldsNote({ model: M }),
    'LiteRT-LM has no Min P: this reply was sampled without the Min P saved in this model\'s settings. Clear that Min P ' +
      'under Models → the model\'s Load settings and reload the model.',
  )
})

test('a setting a LiteRT-LM server does not apply is said: Min P on either, stop strings and penalties on `serve`', () => {
  const M = '/models/q.litertlm'
  rememberLitertLmModel(M, { sampling: {}, native: false })
  assert.equal(litertLmIgnoredFieldsNote({ model: M, temperature: 0.7 }), undefined)
  assert.match(litertLmIgnoredFieldsNote({ model: M, min_p: 0.05 }) ?? '', /does not apply Min P: this reply was written without it\. /)
  assert.match(litertLmIgnoredFieldsNote({ model: M, min_p: 0.05, stop: ['###'] }) ?? '', /does not apply Min P and stop strings: this reply was written without them\. /)
  assert.match(litertLmIgnoredFieldsNote({ model: M, stop: ['###'], repeat_penalty: 1.1 }) ?? '', /does not apply stop strings and repetition, presence and frequency penalties: this reply was written without them\. /)
  assert.equal(litertLmIgnoredFieldsNote({ model: M, repeat_penalty: 1, presence_penalty: 0, stop: [] }), undefined, 'off values are nothing to apply')
  rememberLitertLmModel(M, { sampling: { presence_penalty: 0.5 }, native: false })
  assert.ok(litertLmIgnoredFieldsNote({ model: M }), 'the model\'s saved penalty counts')
  // The Android app's server cuts at a stop string and applies the penalties; neither has Min P.
  rememberLitertLmModel(M, { sampling: {}, native: true })
  assert.equal(litertLmIgnoredFieldsNote({ model: M, stop: ['###'], repeat_penalty: 1.1 }), undefined)
  assert.equal(litertLmIgnoredFieldsNote({ model: M, min_p: 0.05 }), 'LiteRT-LM has no Min P: this reply was sampled without it.')
})

test('a Min P a chat thread sets is named as the thread\'s, with where to clear it', () => {
  // The thread settings show no Min P slider for LiteRT-LM, so a thread's own (set under another engine) was named only
  // as "Min P", with no word of whose it is or where it goes away.
  const M = '/models/q.litertlm'
  rememberLitertLmModel(M, { sampling: {}, native: true })
  assert.equal(litertLmIgnoredFieldsNote({ model: M, min_p: 0.1 }, { fromThread: true }),
    'LiteRT-LM has no Min P: this reply was sampled without this thread\'s Min P. Clear that Min P in Thread settings.')
  rememberLitertLmModel(M, { sampling: {}, native: false })
  assert.equal(litertLmIgnoredFieldsNote({ model: M, min_p: 0.1, stop: ['###'] }, { fromThread: true }),
    'This LiteRT-LM server (litert-lm serve) does not apply this thread\'s Min P and stop strings: this reply was ' +
      'written without them. The Android app\'s LiteRT-LM applies stop strings and penalties; no LiteRT-LM has Min P. ' +
      'Clear that Min P in Thread settings.')
  // A Min P the thread leaves to the model's saved settings is still the model's.
  rememberLitertLmModel(M, { sampling: { min_p: 0.2 }, native: true })
  assert.match(litertLmIgnoredFieldsNote({ model: M }, { fromThread: true }) ?? '', /without the Min P saved in this model's settings\./)
})

// ── tool_choice ───────────────────────────────────────────────────────────────────────────────

test('tool_choice "none" sends no tools: `serve` reads no tool_choice', () => {
  const tools = [{ type: 'function', function: { name: 'read' } }]
  const none = { tools, tool_choice: 'none' as unknown }
  shapeLitertLmToolChoice(none)
  assert.equal('tools' in none, false)
  const typed: Record<string, unknown> = { tools, tool_choice: { type: 'none' } }
  shapeLitertLmToolChoice(typed)
  assert.equal('tools' in typed, false)
  for (const choice of [undefined, 'auto', 'required', { type: 'function', function: { name: 'read' } }]) {
    const b: Record<string, unknown> = { tools, tool_choice: choice }
    shapeLitertLmToolChoice(b)
    assert.deepEqual(b.tools, tools, String(JSON.stringify(choice)))
  }
})
