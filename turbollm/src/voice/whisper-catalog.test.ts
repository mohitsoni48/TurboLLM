import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WHISPER_LANGUAGES, WHISPER_MODEL_FILE, WHISPER_MODELS, isEnglishOnlyFile, isWhisperLanguage, normalizeLanguage, tidyTranscript,
  whisperCatalogModel,
} from './whisper-catalog'

test('catalog ids are unique, so a saved model id names exactly one entry', () => {
  const ids = WHISPER_MODELS.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('catalog files are unique and each is a name the models folder scan accepts', () => {
  // A file the scan rejects would download fine and then never show as installed.
  const files = WHISPER_MODELS.map((m) => m.file)
  assert.equal(new Set(files).size, files.length)
  for (const file of files) assert.match(file, WHISPER_MODEL_FILE, file)
})

test('every catalog sha256 is 64 lowercase hex characters and every size is positive', () => {
  for (const m of WHISPER_MODELS) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/, `${m.id} sha256`)
    assert.ok(Number.isInteger(m.sizeBytes) && m.sizeBytes > 0, `${m.id} size`)
  }
})

test('exactly one catalog model is recommended', () => {
  assert.equal(WHISPER_MODELS.filter((m) => m.recommended).length, 1)
})

test('English-only catalog entries are marked non-multilingual, and only they', () => {
  for (const m of WHISPER_MODELS) assert.equal(m.multilingual, !isEnglishOnlyFile(m.file), m.id)
  assert.ok(WHISPER_MODELS.some((m) => !m.multilingual))
})

test('whisperCatalogModel finds an entry by id and is undefined for an unknown one', () => {
  assert.equal(whisperCatalogModel('base')?.file, 'ggml-base.bin')
  assert.equal(whisperCatalogModel('nope'), undefined)
})

test('isEnglishOnlyFile follows whisper.cpp naming, quantized or not', () => {
  assert.equal(isEnglishOnlyFile('ggml-base.en.bin'), true)
  assert.equal(isEnglishOnlyFile('ggml-small.en-q5_1.bin'), true)
  assert.equal(isEnglishOnlyFile('ggml-base.bin'), false)
  assert.equal(isEnglishOnlyFile('ggml-base-q5_1.bin'), false)
})

test('isWhisperLanguage accepts auto and whisper codes and rejects everything else', () => {
  for (const ok of ['auto', 'en', 'yue', 'haw']) assert.equal(isWhisperLanguage(ok), true, ok)
  for (const bad of ['', 'EN', 'english', 'xx', ' en', 'en-US']) assert.equal(isWhisperLanguage(bad), false, JSON.stringify(bad))
  for (const bad of [undefined, null, 5, {}, ['en']]) assert.equal(isWhisperLanguage(bad), false, String(bad))
})

test('isWhisperLanguage does not mistake an Object.prototype name for a language', () => {
  // A plain `in` check would accept these, and whisper-server then refuses to start with the bad default.
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(isWhisperLanguage(bad), false, bad)
  assert.equal(normalizeLanguage('constructor'), null)
})

test('the language table has no auto entry, since auto is not a language whisper knows', () => {
  assert.equal(Object.hasOwn(WHISPER_LANGUAGES, 'auto'), false)
})

test('normalizeLanguage lower-cases, trims and drops the region of what OpenAI clients send', () => {
  assert.equal(normalizeLanguage('EN'), 'en')
  assert.equal(normalizeLanguage(' en-US '), 'en')
  assert.equal(normalizeLanguage('pt_BR'), 'pt')
  assert.equal(normalizeLanguage('AUTO'), 'auto')
  assert.equal(normalizeLanguage('yue'), 'yue')
})

test('normalizeLanguage returns null for a language whisper does not know and for an empty one', () => {
  assert.equal(normalizeLanguage('klingon'), null)
  assert.equal(normalizeLanguage(''), null)
  assert.equal(normalizeLanguage('   '), null)
  assert.equal(normalizeLanguage('-US'), null)
})

test('tidyTranscript joins whisper-server segment lines into one line', () => {
  assert.equal(tidyTranscript(' Hello there.\n  How are you?\r\n Fine.\n'), 'Hello there. How are you? Fine.')
})

test('tidyTranscript strips [BLANK_AUDIO] and returns an empty string when that is all there was', () => {
  assert.equal(tidyTranscript(' [BLANK_AUDIO]\n'), '')
  assert.equal(tidyTranscript(' [BLANK_AUDIO]\n [BLANK_AUDIO]'), '')
  assert.equal(tidyTranscript(''), '')
  assert.equal(tidyTranscript(' hi [BLANK_AUDIO] there'), 'hi there')
})

test('WHISPER_MODEL_FILE rejects names that could point outside the models folder or are not ggml files', () => {
  // The id of a model that is not in the catalog is used as a file name, so this is the path-traversal guard.
  for (const bad of ['../x.bin', 'ggml-a/b.bin', 'ggml-a\\b.bin', 'ggml-.bin', 'model.bin', 'ggml-x.gguf', 'ggml-..bin/../x.bin', '/ggml-x.bin']) {
    assert.equal(WHISPER_MODEL_FILE.test(bad), false, bad)
  }
  for (const good of ['ggml-base.bin', 'ggml-my_model-v2.en.bin', 'ggml-small.en-q5_1.bin']) assert.equal(WHISPER_MODEL_FILE.test(good), true, good)
})

test('the web language picker mirrors the catalog table', async () => {
  const web = await import('../../web/src/lib/voice/languages')
  assert.deepEqual({ ...web.WHISPER_LANGUAGE_NAMES }, { ...WHISPER_LANGUAGES })
  assert.equal(web.AUTO_LANGUAGE, 'auto')
})
