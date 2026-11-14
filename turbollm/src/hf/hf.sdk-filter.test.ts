// Discover follows the active engine row (ADR-462, plan D-10): with the in-app SDK's LiteRT-LM row active, HF is asked
// for `.litertlm` repos (it was asked for GGUF, so no LiteRT model could be found or downloaded), and the speech, voice
// and embedding bundles that share that facet are dropped, since they cannot chat. Every other kind searches exactly
// as before. Every HF call is stubbed; this test never touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EngineFormatRef } from '../engines/compat'
import { HfClient, type RawSearchItem } from './hf'

const client = () => new HfClient(() => '', '0.0.0-test')

const LITERT_ROW: EngineFormatRef = {
  kind: 'turbollm-sdk', name: 'LiteRT-LM',
  sdkEngine: { id: 'litert-lm', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu', 'cpu'] },
}
const LLAMA_ROW: EngineFormatRef = {
  kind: 'turbollm-sdk', name: 'llama.cpp (CPU)',
  sdkEngine: { id: 'llama.cpp-cpu', kind: 'llama.cpp', formats: ['gguf'], backends: ['cpu'] },
}
const LEGACY_ROW: EngineFormatRef = { kind: 'turbollm-sdk' }

/** Answers every HF listing with `rows`, except the Laya side-search, and records each URL asked for. */
async function withHfListing<T>(rows: RawSearchItem[], run: () => Promise<T>): Promise<{ urls: string[]; result: T }> {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    urls.push(url)
    const body = url.includes('filter=laya&') ? [] : rows
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    return { urls, result: await run() }
  } finally {
    globalThis.fetch = real
  }
}

/** libraryFilterFor's body before D-10, pasted verbatim: every row that is not an SDK row still filters like this. */
function filterBefore(engineKind?: string): string {
  if (engineKind === 'mlx' || engineKind === 'rapid-mlx' || engineKind === 'mlx-vlm') return 'filter=mlx&'
  if (engineKind === 'vllm' || engineKind === 'sglang') return ''
  if (engineKind === 'litert-lm') return 'filter=litert-lm&'
  return 'filter=gguf&'
}

const browseUrl = async (engine?: EngineFormatRef) => (await withHfListing([], () => client().browseModels('trending', engine))).urls[0]
const searchUrl = async (engine?: EngineFormatRef) => (await withHfListing([], () => client().searchModels('gemma', engine))).urls[0]

test('the LiteRT-LM SDK row asks HF for the litert-lm facet; the llama.cpp and legacy SDK rows for GGUF', async () => {
  for (const url of [await browseUrl(LITERT_ROW), await searchUrl(LITERT_ROW)]) {
    assert.match(url, /filter=litert-lm&/)
    assert.doesNotMatch(url, /filter=gguf/)
  }
  for (const row of [LLAMA_ROW, LEGACY_ROW]) {
    assert.match(await browseUrl(row), /filter=gguf&/)
    assert.match(await searchUrl(row), /filter=gguf&/)
  }
})

test('every other kind, and no engine at all, asks HF exactly as before', async () => {
  const kinds = ['mlx', 'rapid-mlx', 'mlx-vlm', 'vllm', 'sglang', 'litert-lm', 'llama-server', 'koboldcpp', 'llamafile', 'laya', undefined]
  for (const kind of kinds) {
    const expected = `https://huggingface.co/api/models?${filterBefore(kind)}sort=trendingScore&direction=-1&limit=30&full=false`
    assert.equal(await browseUrl(kind === undefined ? undefined : { kind }), expected, String(kind))
  }
})

// The live HF top 20 under filter=litert-lm by downloads (architecture §3.7 evidence, 2026-11-07): four speech/voice
// bundles carry an ASR/TTS pipeline tag, three embeddinggemma bundles carry none. The chat rows beside them stay, a
// vision-language one included (it may answer text).
const LITERT_LISTING: RawSearchItem[] = [
  { id: 'litert-community/gemma-4-E2B-it-litert-lm', pipeline_tag: 'text-generation' },
  { id: 'litert-community/parakeet-tdt-0.6b-v3', pipeline_tag: 'automatic-speech-recognition' },
  { id: 'litert-community/whisper-tiny', pipeline_tag: 'automatic-speech-recognition' },
  { id: 'litert-community/moonshine-tiny', pipeline_tag: 'automatic-speech-recognition' },
  { id: 'litert-community/Kokoro-82M', pipeline_tag: 'text-to-speech' },
  { id: 'litert-community/embeddinggemma-300m' },
  { id: 'litert-community/embeddinggemma-300m-seq1024' },
  { id: 'litert-community/EmbeddingGemma-300m-int8' },
  { id: 'litert-community/Gemma3-1B-IT' },
  { id: 'litert-community/Qwen3-0.6B', pipeline_tag: 'text-generation' },
  { id: 'litert-community/gemma-3n-E2B-it-litert-lm-preview', pipeline_tag: 'image-text-to-text' },
  { id: 'litert-community/some-encoder', pipeline_tag: 'feature-extraction' },
  { id: 'litert-community/some-similarity', pipeline_tag: 'sentence-similarity' },
]
const CHAT_REPOS = [
  'litert-community/gemma-4-E2B-it-litert-lm',
  'litert-community/Gemma3-1B-IT',
  'litert-community/Qwen3-0.6B',
  'litert-community/gemma-3n-E2B-it-litert-lm-preview',
]

test('on the LiteRT-LM SDK row, speech, voice and embedding bundles are dropped and the chat ones kept', async () => {
  const browsed = await withHfListing(LITERT_LISTING, () => client().browseModels('downloads', LITERT_ROW))
  assert.deepEqual(browsed.result.map((r) => r.repo), CHAT_REPOS)
  const searched = await withHfListing(LITERT_LISTING, () => client().searchModels('gemma', LITERT_ROW))
  assert.deepEqual(searched.result.map((r) => r.repo), CHAT_REPOS)
})

// QA F-1 (E-41, 2026-11-07): community re-uploads of the speech and voice bundles carry no pipeline tag at all (checked
// against the HF API), so only their name or a tag says what they are. A name search listed all four on LiteRT-LM.
const UNTAGGED_REUPLOADS: RawSearchItem[] = [
  { id: 'warped-community/whisper-tiny-litert-lm' },
  { id: 'warped-community/parakeet-tdt-0.6b-litert-lm' },
  { id: 'warped-community/Kokoro-82M-litert-lm' },
  { id: 'warped-community/moonshine-tiny-litert-lm' },
  { id: 'someone/voice-bundle-litert-lm', tags: ['litert-lm', 'text-to-speech'] },
  { id: 'someone/gemma-3-1b-it-litert-lm' },
  { id: 'someone/Qwen3-0.6B-litert-lm' },
  { id: 'someone/LFM2-1.2B-litert-lm', tags: ['litert-lm', 'text-generation'] },
]

test('on the LiteRT-LM SDK row, untagged speech and voice re-uploads are dropped by name or tag; chat ones stay', async () => {
  const { result } = await withHfListing(UNTAGGED_REUPLOADS, () => client().searchModels('litert', LITERT_ROW))
  assert.deepEqual(result.map((r) => r.repo), [
    'someone/gemma-3-1b-it-litert-lm',
    'someone/Qwen3-0.6B-litert-lm',
    'someone/LFM2-1.2B-litert-lm',
  ])
})

test('a search row carries its pipeline tag', async () => {
  const { result } = await withHfListing(LITERT_LISTING, () => client().browseModels('downloads', LITERT_ROW))
  assert.equal(result[0].pipelineTag, 'text-generation')
  assert.equal(result[1].pipelineTag, undefined)
})

test('the plain litert-lm engine keeps every row, as before', async () => {
  const { result } = await withHfListing(LITERT_LISTING, () => client().browseModels('downloads', { kind: 'litert-lm' }))
  assert.deepEqual(result.map((r) => r.repo), LITERT_LISTING.map((r) => r.id))
})
