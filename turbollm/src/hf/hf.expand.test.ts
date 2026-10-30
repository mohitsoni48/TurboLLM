// Tests for HfClient.expandModelFiles (spec 10 §3): expanding a chosen GGUF into every
// concrete file to fetch — all shards of its split group + its mmproj projector — with
// matching scoped to the chosen file's own repo directory and the targeted revision
// threaded into the tree query.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HfClient } from './hf'

interface TreeEntry {
  type: string
  path: string
  size?: number
  lfs?: { oid?: string; size?: number }
}

/** Stub global.fetch so getJson returns the given tree for the tree endpoint. Captures
 *  every requested URL so tests can assert the revision the query targeted. */
function withTree(tree: TreeEntry[], fn: (urls: string[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    urls.push(u)
    if (u.includes('/tree/')) {
      return new Response(JSON.stringify(tree), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return fn(urls).finally(() => {
    globalThis.fetch = real
  })
}

function client(): HfClient {
  return new HfClient(() => '', '0.0.0-test')
}

test('expandModelFiles: single-file quant pulls the shared mmproj alongside it (root dir)', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Qwen3-VL-Q4_K_M.gguf', lfs: { oid: 'aaa', size: 100 } },
    { type: 'file', path: 'mmproj-F16.gguf', lfs: { oid: 'proj', size: 20 } },
    { type: 'file', path: 'README.md', size: 5 },
  ]
  await withTree(tree, async () => {
    const { dir, files } = await client().expandModelFiles('unsloth/Qwen3-VL-GGUF', 'Qwen3-VL-Q4_K_M.gguf')
    assert.equal(dir, '')
    assert.deepEqual(
      files.map((f) => [f.rfilename, f.mmproj]),
      [
        ['Qwen3-VL-Q4_K_M.gguf', false],
        ['mmproj-F16.gguf', true],
      ],
    )
    assert.equal(files[0].sha256, 'aaa')
    assert.equal(files[1].size, 20)
  })
})

test('expandModelFiles: split quant expands to every shard (by first-shard basename) + mmproj', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'gpt-oss-120b-Q4_K_M-00001-of-00003.gguf', lfs: { oid: 's1', size: 10 } },
    { type: 'file', path: 'gpt-oss-120b-Q4_K_M-00002-of-00003.gguf', lfs: { oid: 's2', size: 10 } },
    { type: 'file', path: 'gpt-oss-120b-Q4_K_M-00003-of-00003.gguf', lfs: { oid: 's3', size: 10 } },
    // A different quant's shards must NOT be pulled in.
    { type: 'file', path: 'gpt-oss-120b-Q8_0-00001-of-00002.gguf', lfs: { oid: 'x1', size: 99 } },
    { type: 'file', path: 'mmproj-F16.gguf', lfs: { oid: 'proj', size: 5 } },
  ]
  await withTree(tree, async () => {
    const { files } = await client().expandModelFiles('unsloth/gpt-oss-120b-GGUF', 'gpt-oss-120b-Q4_K_M-00001-of-00003.gguf')
    assert.deepEqual(files.map((f) => f.rfilename), [
      'gpt-oss-120b-Q4_K_M-00001-of-00003.gguf',
      'gpt-oss-120b-Q4_K_M-00002-of-00003.gguf',
      'gpt-oss-120b-Q4_K_M-00003-of-00003.gguf',
      'mmproj-F16.gguf',
    ])
  })
})

test('expandModelFiles: recovers the full repo path and reports the model dir for subfoldered GGUFs', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Q4_K_M/model-00001-of-00002.gguf', lfs: { oid: 'a', size: 10 } },
    { type: 'file', path: 'Q4_K_M/model-00002-of-00002.gguf', lfs: { oid: 'b', size: 10 } },
  ]
  await withTree(tree, async () => {
    // The UI carries only the basename of the first shard.
    const { dir, files } = await client().expandModelFiles('owner/repo', 'model-00001-of-00002.gguf')
    assert.equal(dir, 'Q4_K_M')
    assert.deepEqual(files.map((f) => f.rfilename), [
      'Q4_K_M/model-00001-of-00002.gguf',
      'Q4_K_M/model-00002-of-00002.gguf',
    ])
  })
})

test('expandModelFiles: gpt-oss-120b Q4_K_M (2-part split in a per-quant subfolder, root companions + single F16 present) expands to exactly its two shards in one dir', async () => {
  // Mirrors the real unsloth/gpt-oss-120b-GGUF layout: every quant lives in its own
  // subfolder as a 2-part split, plus root-level companion files (config.json, params,
  // template) and a single root F16. Regression guard for the "missing parts" report:
  // both shards must land under the SAME model dir so the scanner groups them into one
  // complete split. (b2ecd47 follow-up — this specific repo regressed.)
  const tree: TreeEntry[] = [
    { type: 'file', path: 'config.json', size: 100 },
    { type: 'file', path: 'params', size: 100 },
    { type: 'file', path: 'template', size: 100 },
    { type: 'file', path: 'README.md', size: 100 },
    { type: 'file', path: 'gpt-oss-120b-F16.gguf', lfs: { oid: 'f16', size: 999 } },
    { type: 'file', path: 'Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf', lfs: { oid: 'a', size: 10 } },
    { type: 'file', path: 'Q4_K_M/gpt-oss-120b-Q4_K_M-00002-of-00002.gguf', lfs: { oid: 'b', size: 10 } },
    { type: 'file', path: 'Q8_0/gpt-oss-120b-Q8_0-00001-of-00002.gguf', lfs: { oid: 'c', size: 20 } },
    { type: 'file', path: 'Q8_0/gpt-oss-120b-Q8_0-00002-of-00002.gguf', lfs: { oid: 'd', size: 20 } },
  ]
  await withTree(tree, async () => {
    // The Discover UI carries only the first shard's basename (groupFiles sets name = basename).
    const { dir, files } = await client().expandModelFiles(
      'unsloth/gpt-oss-120b-GGUF',
      'gpt-oss-120b-Q4_K_M-00001-of-00002.gguf',
    )
    assert.equal(dir, 'Q4_K_M')
    assert.deepEqual(files.map((f) => f.rfilename), [
      'Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf',
      'Q4_K_M/gpt-oss-120b-Q4_K_M-00002-of-00002.gguf',
    ])
    // No mmproj in this repo — must not fabricate one, and the root F16 / other quant / the
    // companion files must never be pulled into this quant's download set.
    assert.equal(files.length, 2)
    assert.equal(files.every((f) => !f.mmproj), true)
    // Both shards share one repo directory → they will download into one folder and the
    // scanner will see a complete 2-of-2 split (the crux of the "missing parts" fix).
    const dirs = new Set(files.map((f) => f.rfilename.slice(0, f.rfilename.lastIndexOf('/'))))
    assert.equal(dirs.size, 1)
  })
})

test('expandModelFiles: same-basename shards in two subfolders do NOT cross-match', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Q4_K_M/model-00001-of-00003.gguf', lfs: { oid: 'a1', size: 10 } },
    { type: 'file', path: 'Q4_K_M/model-00002-of-00003.gguf', lfs: { oid: 'a2', size: 10 } },
    { type: 'file', path: 'Q4_K_M/model-00003-of-00003.gguf', lfs: { oid: 'a3', size: 10 } },
    { type: 'file', path: 'Q8_0/model-00001-of-00003.gguf', lfs: { oid: 'b1', size: 20 } },
    { type: 'file', path: 'Q8_0/model-00002-of-00003.gguf', lfs: { oid: 'b2', size: 20 } },
    { type: 'file', path: 'Q8_0/model-00003-of-00003.gguf', lfs: { oid: 'b3', size: 20 } },
  ]
  await withTree(tree, async () => {
    // Chosen file's basename is ambiguous across both folders; the tree's first match is
    // Q4_K_M — only its three shards may be returned, never all six.
    const { dir, files } = await client().expandModelFiles('owner/repo', 'model-00001-of-00003.gguf')
    assert.equal(dir, 'Q4_K_M')
    assert.deepEqual(files.map((f) => f.rfilename), [
      'Q4_K_M/model-00001-of-00003.gguf',
      'Q4_K_M/model-00002-of-00003.gguf',
      'Q4_K_M/model-00003-of-00003.gguf',
    ])
  })
})

test('expandModelFiles: prefers an mmproj in the model’s own subfolder over a larger sibling', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Q4_K_M/model-Q4_K_M.gguf', lfs: { oid: 'm', size: 100 } },
    { type: 'file', path: 'Q4_K_M/mmproj-F16.gguf', lfs: { oid: 'p16', size: 10 } },
    // Larger, but in a different quant folder — must NOT be chosen.
    { type: 'file', path: 'BF16/mmproj-BF16.gguf', lfs: { oid: 'pbf', size: 40 } },
  ]
  await withTree(tree, async () => {
    const { files } = await client().expandModelFiles('owner/repo', 'model-Q4_K_M.gguf')
    const proj = files.find((f) => f.mmproj)
    assert.equal(proj?.rfilename, 'Q4_K_M/mmproj-F16.gguf')
  })
})

test('expandModelFiles: falls back to the largest repo-wide mmproj when none in the model dir', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Q4_K_M/model-Q4_K_M.gguf', lfs: { oid: 'm', size: 100 } },
    { type: 'file', path: 'mmproj/mmproj-Q8_0.gguf', lfs: { oid: 'p8', size: 10 } },
    { type: 'file', path: 'mmproj/mmproj-F16.gguf', lfs: { oid: 'p16', size: 25 } },
  ]
  await withTree(tree, async () => {
    const { files } = await client().expandModelFiles('owner/repo', 'model-Q4_K_M.gguf')
    const proj = files.find((f) => f.mmproj)
    assert.equal(proj?.rfilename, 'mmproj/mmproj-F16.gguf')
    assert.equal(files.filter((f) => f.mmproj).length, 1)
  })
})

test('expandModelFiles: threads the revision into the tree query', async () => {
  const tree: TreeEntry[] = [{ type: 'file', path: 'model.gguf', lfs: { oid: 'm', size: 100 } }]
  await withTree(tree, async (urls) => {
    await client().expandModelFiles('owner/repo', 'model.gguf', 'v2.0')
    assert.ok(
      urls.some((u) => u.includes('/tree/v2.0?')),
      `expected a tree query on v2.0, got: ${urls.join(', ')}`,
    )
    assert.ok(!urls.some((u) => u.includes('/tree/main')), 'must not query main when a revision is given')
  })
})

test('expandModelFiles: split regex only matches exactly 5+5 digits', async () => {
  // 4-digit and 6-digit "of" patterns are NOT llama.cpp splits — treated as single files.
  const tree: TreeEntry[] = [
    { type: 'file', path: 'a-0001-of-0003.gguf', lfs: { oid: 'x', size: 5 } },
    { type: 'file', path: 'a-000001-of-000003.gguf', lfs: { oid: 'y', size: 5 } },
  ]
  await withTree(tree, async () => {
    const four = await client().expandModelFiles('owner/repo', 'a-0001-of-0003.gguf')
    assert.deepEqual(four.files.map((f) => f.rfilename), ['a-0001-of-0003.gguf'])
    const six = await client().expandModelFiles('owner/repo', 'a-000001-of-000003.gguf')
    assert.deepEqual(six.files.map((f) => f.rfilename), ['a-000001-of-000003.gguf'])
  })
})

test('expandModelFiles: requested file absent from the tree falls back to the name as given', async () => {
  const tree: TreeEntry[] = [{ type: 'file', path: 'other.gguf', lfs: { oid: 'o', size: 5 } }]
  await withTree(tree, async () => {
    const { files } = await client().expandModelFiles('owner/repo', 'missing.gguf')
    assert.deepEqual(files.map((f) => [f.rfilename, f.mmproj]), [['missing.gguf', false]])
  })
})

test('expandModelFiles: downloading an mmproj directly does not pair another projector', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'm', size: 100 } },
    { type: 'file', path: 'mmproj-F16.gguf', lfs: { oid: 'p16', size: 25 } },
  ]
  await withTree(tree, async () => {
    const { files } = await client().expandModelFiles('owner/repo', 'mmproj-F16.gguf')
    assert.deepEqual(files.map((f) => [f.rfilename, f.mmproj]), [['mmproj-F16.gguf', false]])
  })
})

test('expandModelFiles: HF failure falls back to the single requested file', async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  try {
    const { files } = await client().expandModelFiles('owner/repo', 'sub/model-Q4_K_M.gguf')
    assert.deepEqual(files.map((f) => f.rfilename), ['sub/model-Q4_K_M.gguf'])
  } finally {
    globalThis.fetch = real
  }
})

test('expandModelFiles: a full repo path picks that exact folder even when its basename is shared', async () => {
  const tree: TreeEntry[] = [
    { type: 'file', path: 'Q4_K_M/model-00001-of-00002.gguf', lfs: { oid: 'a1', size: 10 } },
    { type: 'file', path: 'Q4_K_M/model-00002-of-00002.gguf', lfs: { oid: 'a2', size: 10 } },
    { type: 'file', path: 'Q8_0/model-00001-of-00002.gguf', lfs: { oid: 'b1', size: 20 } },
    { type: 'file', path: 'Q8_0/model-00002-of-00002.gguf', lfs: { oid: 'b2', size: 20 } },
  ]
  await withTree(tree, async () => {
    const { dir, files } = await client().expandModelFiles('owner/repo', 'Q8_0/model-00001-of-00002.gguf')
    assert.equal(dir, 'Q8_0')
    assert.deepEqual(files.map((f) => f.rfilename), ['Q8_0/model-00001-of-00002.gguf', 'Q8_0/model-00002-of-00002.gguf'])
  })
})

test('expandModelFiles: a split group straddling a tree page boundary still expands to every shard', async () => {
  const page1: TreeEntry[] = [
    { type: 'file', path: 'big-00001-of-00003.gguf', lfs: { oid: 's1', size: 10 } },
    { type: 'file', path: 'big-00002-of-00003.gguf', lfs: { oid: 's2', size: 10 } },
  ]
  const page2: TreeEntry[] = [{ type: 'file', path: 'big-00003-of-00003.gguf', lfs: { oid: 's3', size: 10 } }]
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    const second = new URL(String(url)).searchParams.get('cursor') === 'p2'
    return new Response(JSON.stringify(second ? page2 : page1), {
      status: 200,
      headers: second ? {} : { link: '<https://huggingface.co/api/models/owner/repo/tree/main?recursive=true&cursor=p2>; rel="next"' },
    })
  }) as typeof fetch
  try {
    const { files } = await client().expandModelFiles('owner/repo', 'big-00001-of-00003.gguf')
    assert.deepEqual(files.map((f) => f.rfilename), ['big-00001-of-00003.gguf', 'big-00002-of-00003.gguf', 'big-00003-of-00003.gguf'])
  } finally {
    globalThis.fetch = real
  }
})

/** Stub global.fetch with a repo whose `rev` names the commit `sha` (`sha` undefined: the
 *  revision lookup fails with a 500) and whose tree is `tree` at any revision. */
function withCommit(sha: string | undefined, tree: TreeEntry[], fn: (urls: string[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    urls.push(u)
    if (u.includes('/revision/')) {
      return sha ? new Response(JSON.stringify({ id: 'owner/repo', sha }), { status: 200 }) : new Response('boom', { status: 500 })
    }
    return new Response(JSON.stringify(u.includes('/tree/') ? tree : []), { status: 200 })
  }) as typeof fetch
  return fn(urls).finally(() => {
    globalThis.fetch = real
  })
}

const COMMIT = '499bc8821c6b12b4e53c5bffcb21ec206f212d81'

test('expandModelFiles: the files are read at the commit the revision names now, and that commit is returned', async () => {
  // A download fetches from this commit, so a Resume after the branch moved on still gets the
  // bytes the tree's sha256 describes.
  const tree: TreeEntry[] = [{ type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'aaa', size: 100 } }]
  await withCommit(COMMIT, tree, async (urls) => {
    const out = await client().expandModelFiles('owner/repo', 'model-Q4_K_M.gguf')
    assert.equal(out.commit, COMMIT)
    assert.deepEqual(out.files.map((f) => f.sha256), ['aaa'])
    assert.deepEqual(urls, [
      'https://huggingface.co/api/models/owner/repo/revision/main?expand%5B%5D=sha',
      `https://huggingface.co/api/models/owner/repo/tree/${COMMIT}?recursive=true`,
    ])
  })
})

test('expandModelFiles: without a commit from Hugging Face the tree is read at the revision as before', async () => {
  const tree: TreeEntry[] = [{ type: 'file', path: 'model-Q4_K_M.gguf', lfs: { oid: 'aaa', size: 100 } }]
  await withCommit(undefined, tree, async (urls) => {
    const out = await client().expandModelFiles('owner/repo', 'model-Q4_K_M.gguf', 'v2.0')
    assert.equal(out.commit, undefined)
    assert.equal(urls.at(-1), 'https://huggingface.co/api/models/owner/repo/tree/v2.0?recursive=true')
    assert.deepEqual(out.files.map((f) => f.rfilename), ['model-Q4_K_M.gguf'])
  })
  // A revision that is a commit already is not looked up.
  await withCommit('f'.repeat(40), tree, async (urls) => {
    const out = await client().expandModelFiles('owner/repo', 'model-Q4_K_M.gguf', COMMIT)
    assert.equal(out.commit, COMMIT)
    assert.deepEqual(urls, [`https://huggingface.co/api/models/owner/repo/tree/${COMMIT}?recursive=true`])
  })
})

test('expandModelFiles: a file pushed while the commit lookup is cached is read at the commit that has it', async () => {
  // The revision's commit is cached for five minutes, apart from the repo page's own listing of the
  // branch. After a push inside that window the page listed a file the cached commit did not have
  // yet, which fell back to size 0, no sha256 and the branch URL: no disk or integrity check.
  const C1 = '1'.repeat(40)
  const C2 = '2'.repeat(40)
  const old: TreeEntry = { type: 'file', path: 'old-Q4_K_M.gguf', lfs: { oid: 'old', size: 100 } }
  const pushed: TreeEntry = { type: 'file', path: 'new-Q4_K_M.gguf', lfs: { oid: 'new', size: 200 } }
  const trees: Record<string, TreeEntry[]> = { [C1]: [old], [C2]: [old, pushed] }
  let head = C1
  const real = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    urls.push(u)
    if (u.includes('/revision/main')) return new Response(JSON.stringify({ id: 'owner/repo', sha: head }), { status: 200 })
    const rev = /\/tree\/([^?]+)/.exec(u)?.[1]
    return new Response(JSON.stringify(trees[rev === 'main' ? head : (rev ?? '')] ?? []), { status: 200 })
  }) as typeof fetch
  try {
    const hf = client()
    assert.equal((await hf.expandModelFiles('owner/repo', 'old-Q4_K_M.gguf')).commit, C1)
    head = C2 // the push; the page's listing of main now has the new file
    const before = urls.length
    const out = await hf.expandModelFiles('owner/repo', 'new-Q4_K_M.gguf')
    assert.equal(out.commit, C2)
    assert.deepEqual(out.files.map((f) => [f.rfilename, f.size, f.sha256]), [['new-Q4_K_M.gguf', 200, 'new']])
    assert.deepEqual(urls.slice(before), [
      'https://huggingface.co/api/models/owner/repo/revision/main?expand%5B%5D=sha',
      `https://huggingface.co/api/models/owner/repo/tree/${C2}?recursive=true`,
    ], 'the commit asked again, uncached, and the tree at it')
  } finally {
    globalThis.fetch = real
  }
})
