// Tests for DownloadManager.enqueue fan-out + placement (spec 10 §3, §5):
//  - HF repo downloads land in a per-repo <owner>/<name>/<model-subdir> folder,
//  - a chosen GGUF expands into all shards + the mmproj (placed together),
//  - an HF resolve URL is recognised, its revision honoured, path segments decoded,
//  - files already in flight (same dest) are never enqueued twice,
//  - a degenerate repo id is rejected rather than silently mis-placed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DownloadManager, DownloadError } from './downloads'
import type { HfModelFiles } from '../hf/hf'

/** Minimal ConfigStore stand-in: only the two members DownloadManager touches. */
function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

/** Freeze the background run(): fetch never resolves, so records stay 'downloading'
 *  (deterministic for the dedup test) and no network I/O happens. enqueue() returns its
 *  records before run() ever awaits fetch. A never-resolving promise keeps no OS handle,
 *  so the test process still exits. */
function stubFetch(): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

function newDirs() {
  const root = mkdtempSync(join(tmpdir(), 'tllm-dl-'))
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return { modelDir, stateDir }
}

/** Poll until a record reaches a terminal status (the background run() finished). */
async function waitTerminal(dm: DownloadManager, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = dm.list().find((x) => x.id === id)
    if (r && (r.status === 'done' || r.status === 'error' || r.status === 'cancelled')) return r
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error('timed out waiting for a terminal download status')
}

/** An expander that echoes the model's dir from the chosen rfilename (mirrors the real
 *  one's placement contract) and appends any provided mmproj. */
function echoExpand(extra: HfModelFiles['files'] = []) {
  return async (_repo: string, rfilename: string): Promise<HfModelFiles> => ({
    dir: dirname(rfilename) === '.' ? '' : dirname(rfilename),
    files: [{ rfilename, size: 10, sha256: 'a', mmproj: false }, ...extra],
  })
}

test('enqueue: HF repo file expands into shards + mmproj under <owner>/<name>', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const expand = async (): Promise<HfModelFiles> => ({
      dir: '',
      files: [
        { rfilename: 'model-00001-of-00002.gguf', size: 10, sha256: 's1', mmproj: false },
        { rfilename: 'model-00002-of-00002.gguf', size: 10, sha256: 's2', mmproj: false },
        { rfilename: 'mmproj-F16.gguf', size: 5, sha256: 'p', mmproj: true },
      ],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({ repo: 'unsloth/Qwen3-VL-GGUF', rfilename: 'model-00001-of-00002.gguf' })

    assert.equal(recs.length, 3)
    for (const r of recs) {
      assert.equal(r.repo, 'unsloth/Qwen3-VL-GGUF')
      assert.equal(r.dest, join(modelDir, 'unsloth', 'Qwen3-VL-GGUF', r.name))
    }
    assert.deepEqual(recs.map((r) => r.name).sort(), [
      'mmproj-F16.gguf',
      'model-00001-of-00002.gguf',
      'model-00002-of-00002.gguf',
    ])
  } finally {
    restore()
  }
})

test('enqueue: a per-quant subfolder is preserved under <owner>/<name>/<dir>', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const expand = async (): Promise<HfModelFiles> => ({
      dir: 'Q4_K_M',
      files: [
        { rfilename: 'Q4_K_M/model-00001-of-00002.gguf', size: 10, mmproj: false },
        { rfilename: 'Q4_K_M/model-00002-of-00002.gguf', size: 10, mmproj: false },
        { rfilename: 'Q4_K_M/mmproj-F16.gguf', size: 5, mmproj: true },
      ],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model-00001-of-00002.gguf' })

    for (const r of recs) {
      assert.equal(r.dest, join(modelDir, 'owner', 'repo', 'Q4_K_M', r.name))
    }
    // All in the same folder so the scanner groups shards + mmproj together.
    const dirs = new Set(recs.map((r) => dirname(r.dest)))
    assert.equal(dirs.size, 1)
  } finally {
    restore()
  }
})

test('enqueue: an HF resolve URL honours the linked revision (not main) + decodes path', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    let seen: { repo: string; rfilename: string; rev?: string } | null = null
    const expand = async (repo: string, rfilename: string, rev?: string): Promise<HfModelFiles> => {
      seen = { repo, rfilename, rev }
      return { dir: dirname(rfilename), files: [{ rfilename, size: 10, mmproj: false }] }
    }
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({
      url: 'https://huggingface.co/owner/repo/resolve/v2.0/sub%20dir/model.gguf',
    })

    assert.deepEqual(seen, { repo: 'owner/repo', rfilename: 'sub dir/model.gguf', rev: 'v2.0' })
    assert.equal(recs.length, 1)
    // Revision threaded into the download URL; space re-encoded per segment.
    assert.equal(recs[0].url, 'https://huggingface.co/owner/repo/resolve/v2.0/sub%20dir/model.gguf')
    assert.equal(recs[0].dest, join(modelDir, 'owner', 'repo', 'sub dir', 'model.gguf'))
  } finally {
    restore()
  }
})

test('enqueue: a /blob/ HF URL normalizes to resolve and gets the repo-download path', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    let called = false
    const expand = async (repo: string, rfilename: string, rev?: string): Promise<HfModelFiles> => {
      called = true
      assert.equal(rev, 'main')
      return echoExpand()(repo, rfilename)
    }
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({ url: 'https://huggingface.co/owner/repo/blob/main/model.gguf' })

    assert.ok(called, 'expansion should run for an HF blob URL')
    assert.equal(recs[0].dest, join(modelDir, 'owner', 'repo', 'model.gguf'))
  } finally {
    restore()
  }
})

test('enqueue: a concurrent duplicate (same dest) is not enqueued twice', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    const first = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    assert.equal(first.length, 1)
    // Second enqueue while the first is still in flight ('downloading') → skipped.
    const second = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    assert.equal(second.length, 0)
    // No two live records share a dest.
    const dests = dm.list().map((r) => r.dest)
    assert.equal(new Set(dests).size, dests.length)
  } finally {
    restore()
  }
})

test('enqueue: two quants sharing one mmproj do not double-enqueue the projector', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const mmproj = { rfilename: 'mmproj-F16.gguf', size: 5, mmproj: true as const }
    const expand = async (_r: string, rfilename: string): Promise<HfModelFiles> => ({
      dir: '',
      files: [{ rfilename, size: 10, mmproj: false }, mmproj],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    await dm.enqueue({ repo: 'owner/repo', rfilename: 'model-Q4_K_M.gguf' })
    const second = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model-Q8_0.gguf' })

    // The projector is already in flight from the first download → not re-added.
    assert.deepEqual(second.map((r) => r.name), ['model-Q8_0.gguf'])
    const mmprojRecs = dm.list().filter((r) => r.name === 'mmproj-F16.gguf')
    assert.equal(mmprojRecs.length, 1)
  } finally {
    restore()
  }
})

test('enqueue: an already-present, size-matching mmproj is skipped; a mismatched one re-downloads', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const repoDir = join(modelDir, 'owner', 'repo')
    mkdirSync(repoDir, { recursive: true })
    // Complete projector on disk (size 5 matches the tree's size).
    writeFileSync(join(repoDir, 'mmproj-F16.gguf'), 'xxxxx')

    const expand = async (_r: string, rfilename: string): Promise<HfModelFiles> => ({
      dir: '',
      files: [
        { rfilename, size: 10, mmproj: false },
        { rfilename: 'mmproj-F16.gguf', size: 5, mmproj: true },
      ],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model-Q4_K_M.gguf' })
    assert.deepEqual(recs.map((r) => r.name), ['model-Q4_K_M.gguf'])
  } finally {
    restore()
  }
})

test('enqueue: a stale/truncated mmproj (wrong size) is re-downloaded', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const repoDir = join(modelDir, 'owner', 'repo')
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, 'mmproj-F16.gguf'), 'xxx') // 3 bytes, tree says 5

    const expand = async (_r: string, rfilename: string): Promise<HfModelFiles> => ({
      dir: '',
      files: [
        { rfilename, size: 10, mmproj: false },
        { rfilename: 'mmproj-F16.gguf', size: 5, mmproj: true },
      ],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model-Q4_K_M.gguf' })
    assert.deepEqual(recs.map((r) => r.name).sort(), ['mmproj-F16.gguf', 'model-Q4_K_M.gguf'])
  } finally {
    restore()
  }
})

test('enqueue: a repo id that is not owner/name is rejected', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    await assert.rejects(() => dm.enqueue({ repo: 'noslash', rfilename: 'x.gguf' }), /repo and rfilename are required/)
  } finally {
    restore()
  }
})

test('enqueue: a traversal-y repo id is sanitised, never escapes the model dir', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    const recs = await dm.enqueue({ repo: '../../etc', rfilename: 'x.gguf' })
    // '..' segments are stripped by repoSubdir → lands flat under the model dir, no escape.
    assert.equal(recs.length, 1)
    assert.equal(recs[0].dest, join(modelDir, 'etc', 'x.gguf'))
    assert.ok(recs[0].dest.startsWith(modelDir), 'dest must stay under the model dir')
  } finally {
    restore()
  }
})

test('run: enforces the disk guard using content-length when the enqueue size was unknown', async () => {
  const { modelDir, stateDir } = newDirs()
  const real = globalThis.fetch
  // Resolving fetch (not frozen): a 200 with a huge content-length and a tiny body.
  globalThis.fetch = (async () =>
    new Response('x', { status: 200, headers: { 'content-length': '999999999999' } })) as unknown as typeof fetch
  try {
    // Unknown size at enqueue (degraded HF metadata) → the enqueue-time sum check is
    // skipped; the guard must still fire at download time from content-length.
    const expand = async (_r: string, rfilename: string): Promise<HfModelFiles> => ({
      dir: '',
      files: [{ rfilename, size: 0, mmproj: false }],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    let checkedSize = -1
    ;(dm as unknown as { assertDisk: (d: string, s: number) => void }).assertDisk = (_d, s) => {
      checkedSize = s
      throw new DownloadError('insufficient_disk', 'Not enough free disk space (test).')
    }
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    const rec = await waitTerminal(dm, recs[0].id)
    assert.equal(checkedSize, 999999999999) // consulted with the real content-length
    assert.equal(rec.status, 'error')
    assert.match(rec.error ?? '', /disk/i)
  } finally {
    globalThis.fetch = real
  }
})

test('enqueue: a non-HF raw URL stays a single flat file', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), async () => {
      throw new Error('expand should not run for a raw URL')
    })
    const recs = await dm.enqueue({ url: 'https://example.com/some/model.Q4_K_M.gguf' })

    assert.equal(recs.length, 1)
    assert.equal(recs[0].repo, '')
    assert.equal(recs[0].dest, join(modelDir, 'model.Q4_K_M.gguf'))
  } finally {
    restore()
  }
})
