// Regression: HfClient.getRepo's safetensors (MLX/vLLM) file collection only matched
// `.safetensors`/`.json`, silently excluding a repo's `chat_template.jinja` — the modern
// HF convention for shipping a chat template as a standalone file rather than embedded in
// tokenizer_config.json. Downloading such a repo (e.g. leonsarmiento/Qwen3.6-27B-3bit-mlx,
// reproduced live) left the local model with no chat template at all: mlx-lm degrades
// gracefully without one, but Rapid-MLX/vLLM hard-fail on the first chat message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HfClient } from './hf'

interface TreeEntry {
  type: string
  path: string
  size?: number
  lfs?: { oid?: string; size?: number }
}

/** Stub global.fetch: the repo-info endpoint returns a minimal safetensors-repo payload,
 *  the tree endpoint returns the given entries. */
function withRepo(tree: TreeEntry[], fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/tree/')) {
      return new Response(JSON.stringify(tree), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = real
  })
}

function client(): HfClient {
  return new HfClient(() => '', '0.0.0-test')
}

test('getRepo: safetensors repo file list includes chat_template.jinja alongside weights/config', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'config.json', size: 100 },
    { type: 'file', path: 'tokenizer.json', size: 200 },
    { type: 'file', path: 'tokenizer_config.json', size: 50 },
    { type: 'file', path: 'chat_template.jinja', size: 10 },
    { type: 'file', path: 'model-00001-of-00003.safetensors', lfs: { oid: 'a', size: 1000 } },
    { type: 'file', path: 'README.md', size: 5 },
  ]
  await withRepo(tree, async () => {
    const detail = await client().getRepo('leonsarmiento/Qwen3.6-27B-3bit-mlx')
    assert.equal(detail.safetensors, true)
    const names = detail.files.map((f) => f.name)
    assert.ok(names.includes('chat_template.jinja'), `expected chat_template.jinja in ${JSON.stringify(names)}`)
    assert.ok(!names.includes('README.md'), 'model card assets should still be excluded')
  })
})

test('getRepo: safetensors repo file list still excludes nested (non-root) files', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'config.json', size: 100 },
    { type: 'file', path: 'model-00001-of-00001.safetensors', lfs: { oid: 'a', size: 1000 } },
    { type: 'file', path: 'onnx/model.onnx', size: 999 },
    { type: 'file', path: 'onnx/chat_template.jinja', size: 10 },
  ]
  await withRepo(tree, async () => {
    const detail = await client().getRepo('some/repo')
    const names = detail.files.map((f) => f.name)
    assert.ok(!names.some((n) => n.startsWith('onnx/')), `expected no nested files in ${JSON.stringify(names)}`)
  })
})
