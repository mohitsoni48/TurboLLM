import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  hasLitertlmMagic,
  isLitertlmFileName,
  litertlmEntryFor,
  litertlmNativeCtxFromName,
  litertlmQuantFromName,
} from './litertlm'
import { tmpDir } from '../test-support/tmp'

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
