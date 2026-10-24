import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  hasLitertlmMagic,
  isLitertMagicNumber,
  isLitertlmFileName,
  litertlmEntryFor,
  litertlmHeaderFromFile,
  litertlmNativeCtxFromFile,
  litertlmNativeCtxFromName,
  litertlmQuantFromName,
} from './litertlm'
import { tmpDir } from '../test-support/tmp'
import { fakeLitertlmBundle as fakeBundle, fakeLitertlmBundleOf } from '../test-support/litertlm-bundle'

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
  assert.deepEqual(await litertlmHeaderFromFile(p), { nativeCtx: 4096, ctxDynamic: false, defaultCtx: 4096, vision: false, audio: false })
})

test('litertlmHeaderFromFile: a KV length that is a magic number (a prime above 10) is a dynamic export, taking one less', async () => {
  // Qwen3-0.6B_dynamic_wi4b32_afp32: caches of 32771 (the runtime's IsMagicNumber), LlmMetadata 4096. It read as
  // "exported for 32,771 tokens", and LFM2.5-VL-450M (4099, a prime too) got max_num_tokens 4099.
  const dir = tmpDir('tllm-litertlm-hdr-')
  const qwen = join(dir, 'Qwen3-0.6B_dynamic.litertlm')
  writeFileSync(qwen, fakeBundle(4096, [[1, 32771], [2, 32771]]))
  assert.deepEqual(await litertlmHeaderFromFile(qwen), { nativeCtx: 32770, ctxDynamic: true, defaultCtx: 4096, vision: false, audio: false })
  const vl = join(dir, 'LFM2.5-VL-450M_int8.litertlm')
  writeFileSync(vl, fakeBundle(4096, [[5, 0], [1, 4099], [2, 4099]]))
  assert.deepEqual(await litertlmHeaderFromFile(vl), { nativeCtx: 4098, ctxDynamic: true, defaultCtx: 4096, vision: false, audio: false })
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
  assert.deepEqual(await litertlmHeaderFromFile(q), { nativeCtx: 0, ctxDynamic: false, defaultCtx: 0, vision: false, audio: false })
})
