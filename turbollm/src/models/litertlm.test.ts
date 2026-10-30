import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  hasLitertlmMagic,
  isLitertMagicNumber,
  isLitertlmFileName,
  jinjaTemplateReadsReasoning,
  jinjaTemplateTakesTools,
  litertlmEntryFor,
  llmMetadataSampler,
  litertlmHeaderFromFile,
  litertlmNativeCtxFromFile,
  litertlmNativeCtxFromName,
  litertlmQuantFromName,
} from './litertlm'
import { tmpDir } from '../test-support/tmp'
import { fakeLitertlmBundle as fakeBundle, fakeLitertlmBundleOf, fakeLlmMetadata } from '../test-support/litertlm-bundle'

function scratch(t: TestContext): string {
  const dir = tmpDir('turbollm-litertlm-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('isLitertlmFileName matches the extension case-insensitively and nothing else', () => {
  assert.equal(isLitertlmFileName('gemma-3n-E2B-it-int4.litertlm'), true)
  assert.equal(isLitertlmFileName('MODEL.LITERTLM'), true)
  assert.equal(isLitertlmFileName('model.gguf'), false)
  assert.equal(isLitertlmFileName('model.litertlm.part'), false)
})

test('hasLitertlmMagic accepts the 8-byte LITERTLM header and rejects anything else', async (t) => {
  const dir = scratch(t)
  const good = join(dir, 'good.litertlm')
  const html = join(dir, 'html.litertlm')
  const short = join(dir, 'short.litertlm')
  writeFileSync(good, Buffer.concat([Buffer.from('LITERTLM'), Buffer.alloc(64)]))
  writeFileSync(html, '<html>404 not found</html>')
  writeFileSync(short, 'LITER')
  assert.equal(await hasLitertlmMagic(good), true)
  assert.equal(await hasLitertlmMagic(html), false)
  assert.equal(await hasLitertlmMagic(short), false)
  assert.equal(await hasLitertlmMagic(join(dir, 'missing.litertlm')), false)
})

test('litertlmQuantFromName reads the precision from separators and takes the last match', () => {
  assert.equal(litertlmQuantFromName('gemma-3n-E2B-it-int4.litertlm'), 'INT4')
  assert.equal(litertlmQuantFromName('Qwen3-0.6B_q8_ekv4096.litertlm'), 'Q8')
  assert.equal(litertlmQuantFromName('model-fp16.litertlm'), 'FP16')
  assert.equal(litertlmQuantFromName('int8-model-int4.litertlm'), 'INT4')
  assert.equal(litertlmQuantFromName('plain.litertlm'), '?')
  // a number-letter run inside a word is not a precision
  assert.equal(litertlmQuantFromName('print4-model.litertlm'), '?')
})

test('litertlmNativeCtxFromName reads ekvNNNN and returns 0 when absent', () => {
  assert.equal(litertlmNativeCtxFromName('Qwen3-0.6B_multi-prefill-seq_q8_ekv4096.litertlm'), 4096)
  assert.equal(litertlmNativeCtxFromName('model-ekv1280.litertlm'), 1280)
  assert.equal(litertlmNativeCtxFromName('model.litertlm'), 0)
  assert.equal(litertlmNativeCtxFromName('model-ekv12.litertlm'), 0)
})

test('litertlmEntryFor builds a single-file, text-only library entry', () => {
  const e = litertlmEntryFor('/models/gemma-3n-E2B-it-int4.litertlm', '/models', 3_000_000_000, 1_700_000_000_000)
  assert.equal(e.format, 'litertlm')
  assert.equal(e.name, 'gemma 3n E2B it int4')
  assert.equal(e.quant, 'INT4')
  assert.equal(e.path, '/models/gemma-3n-E2B-it-int4.litertlm')
  assert.equal(e.key, 'gemma 3n e2b it int4|INT4|3000000000')
  assert.equal(e.vision, false)
  assert.equal(e.audio, false)
  assert.equal(e.mmprojPath, null)
  assert.equal(e.incomplete, false)
  assert.equal(e.parseError, null)
})

test('litertlmEntryFor flags an empty file as incomplete', () => {
  assert.equal(litertlmEntryFor('/m/a.litertlm', '/m', 0, 0).incomplete, true)
})

// ── context limit from the header ──────────────────────────────────────────────────────────

test('litertlmNativeCtxFromFile: the global KV caches\' maximum_sequence_length is the limit, the smallest winning', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'LFM2.5-230M_int8.litertlm')
  // A conv state (type 5, no length), a global key cache at 8192 and a global value cache at 4096.
  writeFileSync(p, fakeBundle(4096, [[5, 0], [1, 8192], [2, 4096]]))
  assert.equal(await litertlmNativeCtxFromFile(p), 4096)
})

test('litertlmNativeCtxFromFile: a sliding-window cache\'s length is its window, not the context', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'gemma.litertlm')
  writeFileSync(p, fakeBundle(32768, [[3, 512], [4, 512], [1, 32768], [2, 32768]]))
  assert.equal(await litertlmNativeCtxFromFile(p), 32768)
})

test('litertlmNativeCtxFromFile: untyped caches count only when none is typed, and then the largest wins', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  // An older export: no types at all, a 512-token sliding window beside the 8192-token global caches.
  const old = join(dir, 'old.litertlm')
  writeFileSync(old, fakeBundle(0, [[0, 512], [0, 8192], [0, 8192]]))
  assert.equal(await litertlmNativeCtxFromFile(old), 8192)
  // Typed global caches present: untyped ones are ignored, even a shorter one.
  const mixed = join(dir, 'mixed.litertlm')
  writeFileSync(mixed, fakeBundle(0, [[0, 512], [1, 4096], [2, 4096]]))
  assert.equal(await litertlmNativeCtxFromFile(mixed), 4096)
})

test('litertlmNativeCtxFromFile: no limit when no global cache declares one — LlmMetadata alone is only a default', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'm.litertlm')
  writeFileSync(p, fakeBundle(32768, []))
  assert.equal(await litertlmNativeCtxFromFile(p), 0)
})

test('litertlmNativeCtxFromFile: 0 for anything it cannot read', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'bad.litertlm')
  writeFileSync(p, Buffer.from('LITERTLM garbage that is not a header'))
  assert.equal(await litertlmNativeCtxFromFile(p), 0)
  assert.equal(await litertlmNativeCtxFromFile(join(dir, 'missing.litertlm')), 0)
})

test('litertlmEntryFor: the header limit wins over the name tag, which stays the fallback', () => {
  assert.equal(litertlmEntryFor('/m/x_ekv8192.litertlm', '/m', 10, 0, 4096).nativeCtx, 4096)
  assert.equal(litertlmEntryFor('/m/x_ekv8192.litertlm', '/m', 10, 0).nativeCtx, 8192)
})

// ── the bundle's own default context, and dynamic exports ─────────────────────────────────────

test('litertlmHeaderFromFile: LlmMetadata.max_num_tokens is the bundle\'s own default; a static KV length is its limit', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'LFM2.5-230M_int8.litertlm')
  writeFileSync(p, fakeBundle(4096, [[5, 0], [1, 4096], [2, 4096]]))
  assert.deepEqual(await litertlmHeaderFromFile(p), { nativeCtx: 4096, ctxDynamic: false, defaultCtx: 4096, vision: false, audio: false, toolCalls: false, sampler: null, reasoningHistory: null })
})

test('litertlmHeaderFromFile: a KV length that is a magic number (a prime above 10) is a dynamic export, taking one less', async () => {
  // Qwen3-0.6B_dynamic_wi4b32_afp32: caches of 32771 (the runtime's IsMagicNumber), LlmMetadata 4096. It read as
  // "exported for 32,771 tokens", and LFM2.5-VL-450M (4099, a prime too) got max_num_tokens 4099.
  const dir = tmpDir('tllm-litertlm-hdr-')
  const qwen = join(dir, 'Qwen3-0.6B_dynamic.litertlm')
  writeFileSync(qwen, fakeBundle(4096, [[1, 32771], [2, 32771]]))
  assert.deepEqual(await litertlmHeaderFromFile(qwen), { nativeCtx: 32770, ctxDynamic: true, defaultCtx: 4096, vision: false, audio: false, toolCalls: false, sampler: null, reasoningHistory: null })
  const vl = join(dir, 'LFM2.5-VL-450M_int8.litertlm')
  writeFileSync(vl, fakeBundle(4096, [[5, 0], [1, 4099], [2, 4099]]))
  assert.deepEqual(await litertlmHeaderFromFile(vl), { nativeCtx: 4098, ctxDynamic: true, defaultCtx: 4096, vision: false, audio: false, toolCalls: false, sampler: null, reasoningHistory: null })
  assert.equal(isLitertMagicNumber(4096), false)
  assert.equal(isLitertMagicNumber(7), false, 'primes up to 10 are sizes')
  assert.equal(isLitertMagicNumber(4097), false, '17 * 241')
})

test('litertlmEntryFor: carries the dynamic flag and the bundle\'s own default context', () => {
  const e = litertlmEntryFor('/m/q.litertlm', '/m', 10, 0, { nativeCtx: 32770, ctxDynamic: true, defaultCtx: 4096 })
  assert.equal(e.nativeCtx, 32770)
  assert.equal(e.ctxDynamic, true)
  assert.equal(e.defaultCtx, 4096)
  const plain = litertlmEntryFor('/m/x_ekv8192.litertlm', '/m', 10, 0)
  assert.equal(plain.ctxDynamic, undefined)
  assert.equal(plain.defaultCtx, undefined)
})

test('litertlmHeaderFromFile: vision and audio are the encoder sections the bundle carries', async () => {
  const dir = tmpDir('tllm-litertlm-hdr-')
  const p = join(dir, 'vl.litertlm')
  writeFileSync(p, fakeLitertlmBundleOf([
    { type: 3, items: { model_type: 'tf_lite_prefill_decode', backend_constraint: 'cpu' } },
    { type: 3, items: { model_type: 'TF_LITE_VISION_ENCODER' } },
    { type: 5, data: Buffer.from([0x28, 0x80, 0x20]) }, // LlmMetadata: max_num_tokens 4096
  ]))
  const h = await litertlmHeaderFromFile(p)
  assert.equal(h.vision, true)
  assert.equal(h.audio, false)
  assert.equal(h.defaultCtx, 4096)
  const e = litertlmEntryFor(p, dir, 10, 0, h)
  assert.equal(e.vision, true)
  assert.equal(e.audio, false)
  // A string item that is not model_type, or a section that is not a TFLiteModel, says nothing about modalities.
  const q = join(dir, 'other.litertlm')
  writeFileSync(q, fakeLitertlmBundleOf([{ type: 3, items: { note: 'tf_lite_vision_encoder' } }, { type: 1, items: { model_type: 'tf_lite_audio_encoder_hw' } }]))
  assert.deepEqual(await litertlmHeaderFromFile(q), { nativeCtx: 0, ctxDynamic: false, defaultCtx: 0, vision: false, audio: false, toolCalls: null, sampler: null, reasoningHistory: null })
})

// ── tool calling ──────────────────────────────────────────────────────────────────────────────

// The lines that read `tools` in the templates of litert-community's LFM2.5-230M, Qwen3-0.6B and gemma-4-E2B-it, and
// what Gemma3-1B-IT's and LFM2.5-VL-450M's (which read none) have instead.
const LFM2_TOOLS = `{%- if tools -%}
{%- set ns.system_prompt = ns.system_prompt + ("\\n" if ns.system_prompt else "") + "List of tools: [" -%}
{%- for tool in tools -%}{%- set ns.system_prompt = ns.system_prompt + (tool | tojson) -%}{%- endfor -%}
{%- endif -%}`
const QWEN3_TOOLS = `{%- if tools or messages[0]['role'] == 'system' -%}{%- if tools -%}
{{- "# Tools\\n\\nYou are provided with function signatures within <tools></tools> XML tags:\\n<tools>" -}}
{%- for tool in tools -%}{{- '\\n' + tool | tojson -}}{%- endfor -%}{%- endif -%}{%- endif -%}`
const NO_TOOLS = `{{ bos_token }}{%- for message in messages -%}{{ '<start_of_turn>' + message['role'] + '\\n' }}
{{ message['content'] | trim }}{{ '<end_of_turn>\\n' }}{%- endfor -%}`

test('jinjaTemplateTakesTools: a template that reads `tools` in its code, not the word in its text', () => {
  assert.equal(jinjaTemplateTakesTools(LFM2_TOOLS), true)
  assert.equal(jinjaTemplateTakesTools(QWEN3_TOOLS), true)
  assert.equal(jinjaTemplateTakesTools('{{- tools | tojson -}}'), true)
  assert.equal(jinjaTemplateTakesTools(NO_TOOLS), false)
  // The word in a string literal, in the template's text, or as another name's part or attribute is not the variable.
  assert.equal(jinjaTemplateTakesTools(`{{- "List of tools: [" -}}{{ '<tools>' }}`), false)
  assert.equal(jinjaTemplateTakesTools('You may use tools. {{ message.tools }} {{ tools_in_user_message }}'), false)
})

test('litertlmHeaderFromFile: tool calling is what LlmMetadata declares, else its template, else its model type\'s default template', async (t) => {
  // A bundle whose template never shows the model the tools (Gemma3-1B-IT, LFM2.5-VL) cannot call them; LFM2.5's,
  // Qwen3's and Gemma 4's can. A bundle with no template of its own renders the runtime's default for its model type,
  // which shows tools for FunctionGemma (litert-community's mobile-actions bundle: model type function_gemma, no
  // template) and Gemma 3n only. supports_function_calling, where declared, is the bundle's own word.
  const dir = scratch(t)
  const toolCallsOf = async (name: string, meta: Parameters<typeof fakeLlmMetadata>[0] | null): Promise<boolean | null> => {
    const p = join(dir, name)
    writeFileSync(p, fakeLitertlmBundleOf(meta ? [{ type: 5, data: fakeLlmMetadata(meta) }] : [{ type: 3, items: { model_type: 'tf_lite_prefill_decode' } }]))
    return (await litertlmHeaderFromFile(p)).toolCalls
  }
  assert.equal(await toolCallsOf('lfm2.litertlm', { maxNumTokens: 4096, template: LFM2_TOOLS }), true)
  assert.equal(await toolCallsOf('qwen3.litertlm', { maxNumTokens: 4096, template: QWEN3_TOOLS }), true)
  assert.equal(await toolCallsOf('gemma3-1b.litertlm', { maxNumTokens: 4096, template: NO_TOOLS }), false)
  assert.equal(await toolCallsOf('functiongemma.litertlm', { maxNumTokens: 1024, modelType: 3 }), true)
  assert.equal(await toolCallsOf('gemma3n.litertlm', { modelType: 2 }), true)
  assert.equal(await toolCallsOf('gemma3.litertlm', { modelType: 4 }), false)
  assert.equal(await toolCallsOf('untyped.litertlm', { maxNumTokens: 4096 }), false)
  assert.equal(await toolCallsOf('declared-no.litertlm', { template: LFM2_TOOLS, supportsFunctionCalling: false }), false)
  assert.equal(await toolCallsOf('declared-yes.litertlm', { template: NO_TOOLS, supportsFunctionCalling: true }), true)
  assert.equal(await toolCallsOf('no-metadata.litertlm', null), null, 'no LlmMetadata: the header says nothing')
  // A file cut short before its LlmMetadata says nothing either, rather than "no tools".
  const whole = fakeLitertlmBundleOf([{ type: 5, data: fakeLlmMetadata({ template: LFM2_TOOLS }) }])
  const cut = join(dir, 'cut.litertlm')
  writeFileSync(cut, whole.subarray(0, whole.length - 8))
  assert.equal((await litertlmHeaderFromFile(cut)).toolCalls, null)
})

test('litertlmEntryFor: carries whether the model calls tools, absent when the header says nothing', () => {
  assert.equal(litertlmEntryFor('/m/a.litertlm', '/m', 10, 0, { toolCalls: true }).toolCalls, true)
  assert.equal(litertlmEntryFor('/m/b.litertlm', '/m', 10, 0, { toolCalls: false }).toolCalls, false)
  assert.equal('toolCalls' in litertlmEntryFor('/m/c.litertlm', '/m', 10, 0, { toolCalls: null }), false)
  assert.equal('toolCalls' in litertlmEntryFor('/m/d.litertlm', '/m', 10, 0), false)
})

// ── past reasoning ────────────────────────────────────────────────────────────────────────────

// The lines of litert-community's LFM2.5-230M template that read a past turn's reasoning; Qwen3-0.6B's assistant
// branch (its content as it is, no reasoning); Gemma 4's, which strips only its own thinking channel from the content.
const LFM2_REASONING = `{%- if message.role == "assistant" -%}
{%- set thinking = message.thinking or message.reasoning or message.reasoning_content -%}
{%- if thinking and (preserve_thinking or loop.index0 > ns.last_user_index) -%}{{- "<think>" + thinking + "</think>" -}}{%- endif -%}`
const QWEN3_ASSISTANT = `{%- elif message['role'] == 'assistant' -%}{{- '<|im_start|>' + message['role'] + '\\n' + content -}}`
const GEMMA4_ASSISTANT = `{%- macro strip_thinking(text) -%}{%- for part in text.split('<channel|>') -%}{%- endfor -%}{%- endmacro -%}
{{- strip_thinking(message['content']) -}}`

test('jinjaTemplateReadsReasoning: a template that reads a message\'s past reasoning in its code', () => {
  assert.equal(jinjaTemplateReadsReasoning(LFM2_REASONING), true)
  assert.equal(jinjaTemplateReadsReasoning("{%- set t = message.get('reasoning_content') -%}"), true)
  assert.equal(jinjaTemplateReadsReasoning("{{ message['thinking'] }}"), true)
  assert.equal(jinjaTemplateReadsReasoning(QWEN3_ASSISTANT), false)
  assert.equal(jinjaTemplateReadsReasoning(GEMMA4_ASSISTANT), false)
  // The word in the template's text or in a string literal, or a longer name, is not a read.
  assert.equal(jinjaTemplateReadsReasoning('Think: message.reasoning {{ "message.reasoning_content" }} {{ m.thinking_budget }}'), false)
})

test('litertlmHeaderFromFile and litertlmEntryFor: whether the bundle\'s template reads past reasoning; nothing said without one', async (t) => {
  const dir = scratch(t)
  const of = async (name: string, meta: Parameters<typeof fakeLlmMetadata>[0]): Promise<boolean | null> => {
    const p = join(dir, name)
    writeFileSync(p, fakeLitertlmBundleOf([{ type: 5, data: fakeLlmMetadata(meta) }]))
    return (await litertlmHeaderFromFile(p)).reasoningHistory
  }
  assert.equal(await of('lfm2.litertlm', { maxNumTokens: 4096, template: LFM2_REASONING }), true)
  assert.equal(await of('qwen3.litertlm', { maxNumTokens: 4096, template: QWEN3_ASSISTANT }), false)
  assert.equal(await of('gemma4.litertlm', { template: GEMMA4_ASSISTANT }), false)
  assert.equal(await of('functiongemma.litertlm', { maxNumTokens: 1024, modelType: 3 }), null, 'the runtime\'s default template: not judged')
  assert.equal(litertlmEntryFor('/m/a.litertlm', '/m', 10, 0, { reasoningHistory: false }).reasoningHistory, false)
  assert.equal(litertlmEntryFor('/m/b.litertlm', '/m', 10, 0, { reasoningHistory: true }).reasoningHistory, true)
  assert.equal('reasoningHistory' in litertlmEntryFor('/m/c.litertlm', '/m', 10, 0, { reasoningHistory: null }), false)
})

// ── the bundle's own sampler ──────────────────────────────────────────────────────────────────

test('llmMetadataSampler: the bundle\'s own sampler, as the request fields that reproduce it', () => {
  // Qwen3-0.6B_dynamic_wi4b32_afp32's sampler_params, byte for byte: TOP_P, k 20, p 0.95, temperature 0.6.
  const qwen3 = Buffer.concat([Buffer.from([0x22, 14]), Buffer.from('080210141d3333733f259a99193f', 'hex')])
  assert.deepEqual(llmMetadataSampler(qwen3), { topK: 20, topP: 0.95, temp: 0.6 })
  assert.deepEqual(llmMetadataSampler(fakeLlmMetadata({ sampler: { type: 2, k: 64, p: 0.95, temperature: 1.0 } })), { topK: 64, topP: 0.95, temp: 1 })
  // The CPU sampler is TOP_P only: TOP_K is TOP_P with top_p 1, GREEDY is top_k 1; a TOP_P with no k has no top-k limit.
  assert.deepEqual(llmMetadataSampler(fakeLlmMetadata({ sampler: { type: 1, k: 40, temperature: 0.8 } })), { topK: 40, topP: 1, temp: 0.8 })
  assert.deepEqual(llmMetadataSampler(fakeLlmMetadata({ sampler: { type: 3 } })), { topK: 1 })
  assert.deepEqual(llmMetadataSampler(fakeLlmMetadata({ sampler: { type: 2, p: 0.9, temperature: 0.7 } })), { topP: 0.9, temp: 0.7 })
  // None, or TYPE_UNSPECIFIED (the runtime decides): nothing of its own. LFM2.5-230M and Gemma3-1B declare none.
  assert.equal(llmMetadataSampler(fakeLlmMetadata({ maxNumTokens: 4096 })), null)
  assert.equal(llmMetadataSampler(fakeLlmMetadata({ sampler: { type: 0, k: 5 } })), null)
})

test('litertlmHeaderFromFile and litertlmEntryFor: the entry carries the bundle\'s own sampler', async (t) => {
  const dir = scratch(t)
  const p = join(dir, 'qwen3.litertlm')
  writeFileSync(p, fakeLitertlmBundleOf([{ type: 5, data: fakeLlmMetadata({ maxNumTokens: 4096, sampler: { type: 2, k: 20, p: 0.95, temperature: 0.6 } }) }]))
  const h = await litertlmHeaderFromFile(p)
  assert.deepEqual(h.sampler, { topK: 20, topP: 0.95, temp: 0.6 })
  assert.deepEqual(litertlmEntryFor(p, dir, 10, 0, h).sampler, { topK: 20, topP: 0.95, temp: 0.6 })
  assert.equal('sampler' in litertlmEntryFor(p, dir, 10, 0, { sampler: null }), false)
})
