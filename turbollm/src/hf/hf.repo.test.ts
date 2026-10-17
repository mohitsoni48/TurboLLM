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

/** Stub global.fetch: the repo-info endpoint returns a minimal safetensors-repo payload (or `info`),
 *  the tree endpoint returns the given entries. */
function withRepo(tree: TreeEntry[], fn: () => Promise<void>, info: object = {}): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/tree/')) {
      return new Response(JSON.stringify(tree), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } })
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

test('getRepo: a Laya repo is marked laya and lists its nested checkpoint files, with no checkpoint rows', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'README.md', size: 5 },
    { type: 'file', path: 'encoder/config.json', size: 20 },
    { type: 'file', path: 'model.safetensors', lfs: { oid: 'en', size: 808 } },
    { type: 'file', path: 'multilingual/encoder/config.json', size: 20 },
    { type: 'file', path: 'multilingual/model.safetensors', lfs: { oid: 'ml', size: 647 } },
    { type: 'file', path: 'multilingual/rl_agent_config.json', size: 5 },
    { type: 'file', path: 'multilingual/tokenizer/tokenizer.json', size: 30 },
    { type: 'file', path: 'rl_agent_config.json', size: 5 },
    { type: 'file', path: 'tokenizer/tokenizer.json', size: 30 },
  ]
  await withRepo(tree, async () => {
    const detail = await client().getRepo('convaiinnovations/laya')
    assert.equal(detail.safetensors, true)
    assert.equal(detail.laya, true)
    assert.equal(detail.checkpoints, undefined)
    assert.ok(detail.files.some((f) => f.name === 'multilingual/model.safetensors'))
    assert.ok(detail.files.some((f) => f.name === 'encoder/config.json'))
    assert.ok(!detail.files.some((f) => f.name === 'README.md'))
  }, { library_name: 'transformers' })
})

// The category and the engine-adapted search already leave the MLX port out (ADR-443 (8)); opening it by address must
// not offer it as a Laya download either.
test('getRepo: a Laya-shaped MLX port is not marked laya, so it cannot be downloaded as a Laya model', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'rl_agent_config.json', size: 5 },
    { type: 'file', path: 'mlx_config.json', size: 5 },
    { type: 'file', path: 'model.safetensors', lfs: { oid: 'mlx', size: 808 } },
    { type: 'file', path: 'encoder/config.json', size: 20 },
  ]
  await withRepo(tree, async () => {
    assert.equal((await client().getRepo('aac6fef/laya-mlx')).laya, undefined)
  }, { library_name: 'mlx' })
})

// A Laya-shaped repo that names no library (Luni/laya-grounded) has always downloaded as a Laya model; only a repo
// that names ANOTHER library is a port the engine cannot load.
test('getRepo: a Laya-shaped repo that names no library is still marked laya', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'rl_agent_config.json', size: 5 },
    { type: 'file', path: 'model.safetensors', lfs: { oid: 'x', size: 808 } },
    { type: 'file', path: 'encoder/config.json', size: 20 },
  ]
  await withRepo(tree, async () => {
    assert.equal((await client().getRepo('Luni/laya-grounded')).laya, true)
  })
})

test('getRepo: an ordinary safetensors repo is not marked laya', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'config.json', size: 100 },
    { type: 'file', path: 'tokenizer.json', size: 200 },
    { type: 'file', path: 'model.safetensors', lfs: { oid: 'a', size: 1000 } },
  ]
  await withRepo(tree, async () => {
    assert.equal((await client().getRepo('some/repo')).laya, undefined)
  })
})

/** Stub a tree served in pages: page i answers with `pages[i]` and, except the last, a
 *  `Link: <…cursor=i+1>; rel="next"` header. Every requested tree URL is recorded. */
function withPagedTree(pages: TreeEntry[][], fn: (treeUrls: string[]) => Promise<void>, nextLink?: (i: number) => string): Promise<void> {
  const real = globalThis.fetch
  const treeUrls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/tree/')) {
      treeUrls.push(u)
      const i = Number(new URL(u).searchParams.get('cursor') ?? 0)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (i + 1 < pages.length) {
        headers.link = nextLink?.(i + 1) ?? `<https://huggingface.co/api/models/owner/repo/tree/main?recursive=true&cursor=${i + 1}>; rel="next"`
      }
      return new Response(JSON.stringify(pages[Math.min(i, pages.length - 1)]), { status: 200, headers })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return fn(treeUrls).finally(() => {
    globalThis.fetch = real
  })
}

test('getRepo: follows the tree listing\'s Link rel="next" pagination — files past the first page are listed', async () => {
  const page1: TreeEntry[] = [{ type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'a', size: 10 } }]
  const page2: TreeEntry[] = [{ type: 'file', path: 'model-Q8_0.gguf', lfs: { oid: 'b', size: 20 } }]
  await withPagedTree([page1, page2], async (treeUrls) => {
    const detail = await client().getRepo('owner/repo')
    assert.deepEqual(detail.files.map((f) => f.name), ['model-Q4_K_M.gguf', 'model-Q8_0.gguf'])
    assert.equal(treeUrls.length, 2)
  })
})

test('getRepo: tree pagination is bounded, and a next link to another origin is never followed', async () => {
  const page: TreeEntry[] = [{ type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'a', size: 10 } }]
  // A listing that never ends: stops at the page cap instead of looping forever.
  await withPagedTree(new Array(500).fill(page), async (treeUrls) => {
    await client().getRepo('owner/repo')
    assert.equal(treeUrls.length, 50)
  })
  // The token-carrying request must not be steered off huggingface.co.
  await withPagedTree([page, page], async (treeUrls) => {
    await client().getRepo('owner/repo')
    assert.equal(treeUrls.length, 1)
  }, () => '<https://evil.example/api/models/owner/repo/tree/main?cursor=1>; rel="next"')
})

test('getRepo: same-named split shards in two quant folders stay two rows, each listed by its full path', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Q4_K_M/model-00001-of-00003.gguf', lfs: { oid: 'a1', size: 10 } },
    { type: 'file', path: 'Q4_K_M/model-00002-of-00003.gguf', lfs: { oid: 'a2', size: 10 } },
    { type: 'file', path: 'Q4_K_M/model-00003-of-00003.gguf', lfs: { oid: 'a3', size: 10 } },
    { type: 'file', path: 'Q8_0/model-00001-of-00003.gguf', lfs: { oid: 'b1', size: 20 } },
    { type: 'file', path: 'Q8_0/model-00002-of-00003.gguf', lfs: { oid: 'b2', size: 20 } },
    { type: 'file', path: 'Q8_0/model-00003-of-00003.gguf', lfs: { oid: 'b3', size: 20 } },
    { type: 'file', path: 'other-Q5_K_M.gguf', lfs: { oid: 'c', size: 5 } },
  ]
  await withRepo(tree, async () => {
    const { files } = await client().getRepo('owner/repo')
    assert.deepEqual(
      files.map((f) => [f.name, f.sizeBytes, f.parts, f.quant]),
      [
        ['other-Q5_K_M.gguf', 5, 1, 'Q5_K_M'], // a unique basename keeps its plain name
        ['Q4_K_M/model-00001-of-00003.gguf', 30, 3, '?'],
        ['Q8_0/model-00001-of-00003.gguf', 60, 3, '?'],
      ],
    )
  })
})

test('getRepo: a failed later tree page fails the listing instead of passing half of it off as the repo', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('cursor=2')) return new Response('boom', { status: 500 })
    if (u.includes('/tree/')) {
      return new Response(JSON.stringify([{ type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'a', size: 10 } }]), {
        status: 200,
        headers: { link: '<https://huggingface.co/api/models/owner/repo/tree/main?recursive=true&cursor=2>; rel="next"' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    await assert.rejects(() => client().getRepo('owner/repo'), (e: unknown) => (e as { code?: string }).code === 'hf_unreachable')
  } finally {
    globalThis.fetch = real
  }
})
