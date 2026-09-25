// Discover's search is narrowed to the active engine's format (gguf under llama.cpp). The Laya engine is never the
// active engine (ADR-443), so without this the real Laya repo (safetensors) could never be found — only the ggmlc
// GGUF conversions, which nothing in TurboLLM can load. Found live on 6996, 2026-09-25.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HfClient } from './hf'

interface Item {
  id: string
  library_name?: string
  tags?: string[]
}

function withSearch(answers: { gguf: Item[]; laya: Item[]; unfiltered?: Item[] }, fn: (urls: string[]) => Promise<void>) {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    urls.push(u)
    const body = u.includes('filter=laya') ? answers.laya : u.includes('filter=gguf') ? answers.gguf : answers.unfiltered ?? []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return fn(urls).finally(() => { globalThis.fetch = real })
}

const client = () => new HfClient(() => '', '0.0.0-test')

const GGUF_CONVERSION = { id: 'mys/laya-GGUF', tags: ['gguf', 'ggmlc', 'laya'] }
const LAYA = { id: 'convaiinnovations/laya', library_name: 'transformers', tags: ['laya', 'transformers'] }
const LAYA_NATIVE = { id: 'telepatia-ai/laya-pt-es-typed', library_name: 'laya', tags: ['laya'] }
const LAYA_MLX = { id: 'aac6fef/laya-mlx', library_name: 'mlx', tags: ['laya', 'mlx'] }
const LAYA_ONNX = { id: 'techtheist/laya-onnx', library_name: 'onnxruntime', tags: ['laya'] }

test('searchModels under llama.cpp also finds the Laya repos the Laya engine can run, listed first', async () => {
  await withSearch({ gguf: [GGUF_CONVERSION], laya: [LAYA, LAYA_MLX, GGUF_CONVERSION, LAYA_NATIVE, LAYA_ONNX] }, async () => {
    const repos = (await client().searchModels('laya', 'llama-server')).map((r) => r.repo)
    assert.deepEqual(repos, ['convaiinnovations/laya', 'telepatia-ai/laya-pt-es-typed', 'mys/laya-GGUF'])
  })
})

test('searchModels asks for Laya repos with the same query and sort', async () => {
  await withSearch({ gguf: [], laya: [] }, async (urls) => {
    await client().searchModels('decision', 'llama-server', 'downloads')
    const layaUrl = urls.find((u) => u.includes('filter=laya'))
    assert.ok(layaUrl, 'no Laya search was made')
    assert.match(layaUrl, /search=decision/)
    assert.match(layaUrl, /sort=downloads/)
  })
})

test('searchModels with no format filter (vLLM) makes no extra Laya search: every repo is already in', async () => {
  await withSearch({ gguf: [], laya: [LAYA], unfiltered: [LAYA] }, async (urls) => {
    const repos = (await client().searchModels('laya', 'vllm')).map((r) => r.repo)
    assert.deepEqual(repos, ['convaiinnovations/laya'])
    assert.equal(urls.filter((u) => u.includes('filter=laya')).length, 0)
  })
})

test('a failed Laya search never fails the search itself', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes('filter=laya')) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify([GGUF_CONVERSION]), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const repos = (await client().searchModels('laya', 'llama-server')).map((r) => r.repo)
    assert.deepEqual(repos, ['mys/laya-GGUF'])
  } finally {
    globalThis.fetch = real
  }
})
