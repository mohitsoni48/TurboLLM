// Tests for DownloadManager.enqueue fan-out + placement (spec 10 §3, §5):
//  - HF repo downloads land in a per-repo <owner>/<name>/<model-subdir> folder,
//  - a chosen GGUF expands into all shards + the mmproj (placed together),
//  - an HF resolve URL is recognised, its revision honoured, path segments decoded,
//  - files already in flight (same dest) are never enqueued twice,
//  - a degenerate repo id is rejected rather than silently mis-placed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DownloadManager, DownloadError, MAX_FOLDER_FILES, setDownloadGetForTests } from './downloads'
import type { HfModelFiles } from '../hf/hf'
import { tmpDir } from '../test-support/tmp'

// run() requests through node:http unless pointed elsewhere; these tests' doubles stub globalThis.fetch.
setDownloadGetForTests((url, init) => globalThis.fetch(url, init))

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
  const root = tmpDir('tllm-dl-')
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

test('enqueue: excludeMmproj drops the projector the expansion would otherwise pull in', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const expand = async (): Promise<HfModelFiles> => ({
      dir: '',
      files: [
        { rfilename: 'model.gguf', size: 10, sha256: 's1', mmproj: false },
        { rfilename: 'mmproj-F16.gguf', size: 5, sha256: 'p', mmproj: true },
      ],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    // Onboarding's blessed-catalog download is the real caller of this flag (ModelStep.tsx).
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf', excludeMmproj: true })

    assert.deepEqual(recs.map((r) => r.name), ['model.gguf'])
    assert.equal(dm.list().some((r) => r.name.includes('mmproj')), false)
  } finally {
    restore()
  }
})

test('enqueue: excludeMmproj is opt-in — Discover downloads (the flag omitted) still get the projector', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const expand = async (): Promise<HfModelFiles> => ({
      dir: '',
      files: [
        { rfilename: 'model.gguf', size: 10, sha256: 's1', mmproj: false },
        { rfilename: 'mmproj-F16.gguf', size: 5, sha256: 'p', mmproj: true },
      ],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })

    assert.deepEqual(recs.map((r) => r.name).sort(), ['mmproj-F16.gguf', 'model.gguf'])
  } finally {
    restore()
  }
})

test('enqueue: TURBOLLM_HF_BASE (E2E harness only) redirects the built resolve URL', async () => {
  const restoreFetch = stubFetch()
  const prevEnv = process.env.TURBOLLM_HF_BASE
  process.env.TURBOLLM_HF_BASE = 'http://127.0.0.1:8080/'
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf', size: 10 })
    assert.equal(recs.length, 1)
    // Trailing slash on the override is stripped, not doubled into the path.
    assert.equal(recs[0].url, 'http://127.0.0.1:8080/owner/repo/resolve/main/model.gguf')
  } finally {
    restoreFetch()
    if (prevEnv === undefined) delete process.env.TURBOLLM_HF_BASE
    else process.env.TURBOLLM_HF_BASE = prevEnv
  }
})

test('enqueue: absent TURBOLLM_HF_BASE builds a real huggingface.co URL', async () => {
  const restoreFetch = stubFetch()
  const prevEnv = process.env.TURBOLLM_HF_BASE
  delete process.env.TURBOLLM_HF_BASE
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const recs = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf', size: 10 })
    assert.equal(recs[0].url, 'https://huggingface.co/owner/repo/resolve/main/model.gguf')
  } finally {
    restoreFetch()
    if (prevEnv === undefined) delete process.env.TURBOLLM_HF_BASE
    else process.env.TURBOLLM_HF_BASE = prevEnv
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

/** One whole-folder download as the web queues it: a request per file, each carrying every
 *  file of the folder by where it lands (`<subdir>/<basename>`) and its size. */
function queueFolder(dm: DownloadManager, subdir: string, names: string[], size: number) {
  const folder = { files: names.map((n) => ({ path: `${subdir}/${n}`, size })) }
  return names.map((rfilename) => dm.enqueue({ repo: 'owner/big', rfilename, size, subdir, folder }))
}

const SHARDS = [1, 2, 3].map((i) => `model-0000${i}-of-00003.safetensors`)

// A whole-folder download (a safetensors repo, a checkpoint folder) is one request per file,
// each with the folder as its subdir. Checked file by file, three shards of 60% of the free
// space each passed (each needs 66%) and queued a folder that needs 198% of it: three 18 GB
// shards on a disk with 30 GB free. Sized from the real free space so the real check runs.
test('enqueue: a whole-folder download is checked against the free disk as one total, so none of its files queue when the folder does not fit', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const st = statfsSync(modelDir)
    const free = st.bavail * st.bsize
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())

    const tooBig = await Promise.allSettled(queueFolder(dm, 'big', SHARDS, Math.floor(free * 0.6)))
    for (const r of tooBig) {
      assert.equal(r.status, 'rejected', 'every file of a folder that does not fit is refused')
      assert.equal(((r as PromiseRejectedResult).reason as DownloadError).code, 'insufficient_disk')
    }
    assert.deepEqual(dm.list(), [], 'nothing of the folder is queued')

    const fits = await Promise.all(queueFolder(dm, 'big', SHARDS, Math.floor(free * 0.1)))
    assert.deepEqual(fits.map((recs) => recs.length), [1, 1, 1], 'a folder that fits queues every file')
  } finally {
    restore()
  }
})

// Clicked again while some of its files are still downloading (shard 2 of three errored, 1 and 3
// still writing), the folder was checked as if all of it were still to come, and the missing
// shard was refused although it fits on its own. Its live files are not fetched again, so, as a
// split GGUF drops its live shards before totalling, they come off the folder's total.
test('enqueue: a whole-folder download clicked again checks only what it still has to fetch', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const st = statfsSync(modelDir)
    const shard = Math.floor(st.bavail * st.bsize * 0.4)
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    await dm.enqueue({ repo: 'owner/big', rfilename: SHARDS[0], size: shard, subdir: 'big/ckpt-2' })
    await dm.enqueue({ repo: 'owner/big', rfilename: SHARDS[2], size: shard, subdir: 'big/ckpt-2' })

    const again = await Promise.all(queueFolder(dm, 'big/ckpt-2', SHARDS, shard))
    assert.deepEqual(again.map((recs) => recs.length), [0, 1, 0], 'the missing shard is queued; the live two add nothing')
  } finally {
    restore()
  }
})

// Only the folder's OWN files come off its total, never whatever is still downloading under its
// path. A root checkpoint's folder is the repo's own, so every nested checkpoint sits inside it,
// yet its files are only the root's (checkpoints.ts: non-recursive). Taken off by path, a live
// nested checkpoint of 60% of the free space let a root one of 120% queue all three files; and
// a sibling 'ckpt-2' is not inside 'ckpt', though its path starts with it.
test('enqueue: a whole-folder download takes off only its own live files, not a nested or sibling folder', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const st = statfsSync(modelDir)
    const free = st.bavail * st.bsize
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    const nested = await Promise.all(queueFolder(dm, 'big/checkpoint-500', SHARDS, Math.floor(free * 0.2)))
    assert.deepEqual(nested.map((recs) => recs.length), [1, 1, 1], 'the nested checkpoint fits and is downloading')

    for (const subdir of ['big', 'big/checkpoint-50']) {
      const results = await Promise.allSettled(queueFolder(dm, subdir, SHARDS, Math.floor(free * 0.4)))
      for (const r of results) {
        assert.equal(r.status, 'rejected', `every file of ${subdir} is refused: checkpoint-500's live files are not its own`)
        assert.equal(((r as PromiseRejectedResult).reason as DownloadError).code, 'insufficient_disk')
      }
    }
    assert.equal(dm.list().length, 3, 'only the nested checkpoint is queued')
  } finally {
    restore()
  }
})

// The caller chooses the folder's list, and checking it scanned every row for every listed file:
// one POST /api/v1/downloads of 20000 entries against 2000 errored rows held the daemon's event
// loop for nearly 3 s, stalling every chat stream and SSE tail, and nothing capped the list.
test('enqueue: a whole-folder download listing more than MAX_FOLDER_FILES files is refused; one at the cap queues', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    const listing = (n: number) => ({ files: Array.from({ length: n }, (_, i) => ({ path: `big/file-${i}.bin`, size: 1 })) })
    await assert.rejects(
      dm.enqueue({ repo: 'owner/big', rfilename: 'file-0.bin', size: 1, subdir: 'big', folder: listing(MAX_FOLDER_FILES + 1) }),
      (e: unknown) => e instanceof DownloadError && e.code === 'invalid_request',
    )
    assert.deepEqual(dm.list(), [], 'nothing is queued')
    const at = await dm.enqueue({ repo: 'owner/big', rfilename: 'file-0.bin', size: 1, subdir: 'big', folder: listing(MAX_FOLDER_FILES) })
    assert.equal(at.length, 1)
  } finally {
    restore()
  }
})

// Every listed file walked every row: thousands of rows (errored ones stay until removed, and
// each enqueue can leave one) times a folder at the cap was ~20M comparisons as macOS, seconds of
// the event loop for one request. The live dests are now read once. Counted as walks of the row
// table rather than timed, so a slow or busy machine cannot fail it and a fast one cannot pass it
// with the per-file walk back; every walk in DownloadManager goes through records.values().
test('enqueue: a whole-folder download at the cap walks the download rows a few times, not once per listed file', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    const records = (dm as unknown as { records: Map<string, object> }).records
    let walks = 0
    const values = records.values.bind(records)
    records.values = () => { walks++; return values() }
    const folder = { files: Array.from({ length: MAX_FOLDER_FILES }, (_, i) => ({ path: `big/file-${i}.bin`, size: 1 })) }
    const out = await dm.enqueue({ repo: 'owner/big', rfilename: 'file-0.bin', size: 1, subdir: 'big', folder })
    assert.equal(out.length, 1)
    assert.ok(walks < 16, `enqueue walked the download rows ${walks} times for ${MAX_FOLDER_FILES} listed files`)
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

test('enqueue: an HF repo download fetches from the commit the expander read its files at', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const commit = '499bc8821c6b12b4e53c5bffcb21ec206f212d81'
    const expand = async (_repo: string, rfilename: string): Promise<HfModelFiles> => ({
      dir: '',
      files: [{ rfilename, size: 10, sha256: 'a', mmproj: false }],
      commit,
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
    const [rec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    assert.equal(rec.url, `https://huggingface.co/owner/repo/resolve/${commit}/model.gguf`)
    assert.equal(rec.name, 'model.gguf', 'the row still shows the file name')
    assert.equal(rec.repo, 'owner/repo')
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

/** Stand in for another platform for one test (restored after it). */
function asPlatform(t: { after: (fn: () => void) => void }, platform: NodeJS.Platform) {
  const actual = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  t.after(() => Object.defineProperty(process, 'platform', { value: actual }))
}

// Hugging Face serves a repo id in any letter case, so a pasted URL in another casing names the
// same file as a live Discover download. On a case-insensitive file system (Windows, default
// macOS) the two dests open one .part, so a second row would be a second writer on it.
const CANONICAL = { repo: 'ggml-org/models', rfilename: 'x.gguf' }
const OTHER_CASE = { url: 'https://huggingface.co/GGML-ORG/MODELS/resolve/main/x.gguf' }

for (const platform of ['win32', 'darwin'] as const) {
  test(`enqueue on ${platform}: the same file under another letter case is not a second writer on its .part`, async (t) => {
    asPlatform(t, platform)
    const restore = stubFetch()
    try {
      const { modelDir, stateDir } = newDirs()
      const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
      const [a] = await dm.enqueue(CANONICAL)
      assert.ok(a)
      assert.deepEqual(await dm.enqueue(OTHER_CASE), [], 'a live row already owns that file')
      assert.equal(dm.list().length, 1)

      // A stale errored row next to a live one in another case: no second writer on resume.
      const asAny = dm as unknown as { records: Map<string, { status: string }> }
      asAny.records.get(a.id)!.status = 'error'
      const [b] = await dm.enqueue(OTHER_CASE)
      assert.ok(b, 'an errored row does not block a fresh attempt')
      assert.notEqual(a.dest, b.dest)
      assert.equal(a.dest.toLowerCase(), b.dest.toLowerCase())
      assert.throws(() => dm.resume(a.id), (e: unknown) => (e as DownloadError).code === 'download_in_progress')
      // Nor may the stale row delete the live row's .part.
      writeFileSync(`${b.dest}.part`, Buffer.alloc(16, 1))
      assert.equal(dm.remove(a.id), true)
      assert.ok(existsSync(`${b.dest}.part`))
    } finally {
      restore()
    }
  })
}

test('enqueue on linux: dests that differ only in letter case are different files', async (t) => {
  asPlatform(t, 'linux')
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    assert.equal((await dm.enqueue(CANONICAL)).length, 1)
    assert.equal((await dm.enqueue(OTHER_CASE)).length, 1, 'a case-sensitive file system holds both')
  } finally {
    restore()
  }
})

// Android's shared storage ignores letter case as well: /sdcard, /storage/emulated/0, an SD card
// under /storage, and the ~/storage links termux-setup-storage makes into them. Seeded as two rows
// a restart left paused, in two letter cases of one file, since a test cannot create /storage: the
// second Resume must not become a second writer on the first one's .part.
const termuxHome = tmpDir('tllm-termux-home-')
const ANDROID_SHARED: Array<[label: string, root: string]> = [
  ['/storage/emulated/0', '/storage/emulated/0/models'],
  ['/sdcard', '/sdcard/models'],
  ["Termux's ~/storage/shared", join(termuxHome, 'storage', 'shared', 'models')],
]
for (const [label, root] of ANDROID_SHARED) {
  // os.homedir() reads USERPROFILE on Windows, not HOME, and the Termux root is joined with
  // backslashes there, so only the /storage and /sdcard cases can stand in for Android on it.
  const skip = process.platform === 'win32' && root.startsWith(termuxHome) && 'os.homedir() ignores HOME on Windows'
  test(`resume on android: under ${label}, the same file in another letter case is not a second writer on its .part`, { skip }, async (t) => {
    asPlatform(t, 'android')
    const home = process.env.HOME
    process.env.HOME = termuxHome
    t.after(() => { process.env.HOME = home })
    const restore = stubFetch()
    try {
      const { stateDir } = newDirs()
      const row = (id: string, repo: string) => ({
        id, name: 'x.gguf', repo, url: `https://huggingface.co/${repo}/resolve/main/x.gguf`,
        dest: `${root}/${repo}/x.gguf`, total: 10, createdAt: new Date().toISOString(),
      })
      mkdirSync(join(stateDir, 'downloads'), { recursive: true })
      writeFileSync(
        join(stateDir, 'downloads', 'manifest.json'),
        JSON.stringify({ version: 1, entries: [row('a', 'ggml-org/models'), row('b', 'GGML-ORG/MODELS')] }),
      )
      const dm = new DownloadManager(fakeStore(root, stateDir), () => {}, () => ({}), echoExpand())
      assert.equal(dm.resume('a'), true)
      assert.throws(() => dm.resume('b'), (e: unknown) => (e as DownloadError).code === 'download_in_progress')
    } finally {
      restore()
    }
  })
}

test('enqueue on android: in app-private storage (Termux\'s home), two letter cases are two files', async (t) => {
  asPlatform(t, 'android')
  const home = process.env.HOME
  process.env.HOME = termuxHome
  t.after(() => { process.env.HOME = home })
  const restore = stubFetch()
  try {
    const { stateDir } = newDirs()
    const modelDir = join(termuxHome, 'models')
    mkdirSync(modelDir, { recursive: true })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    assert.equal((await dm.enqueue(CANONICAL)).length, 1)
    assert.equal((await dm.enqueue(OTHER_CASE)).length, 1, 'a case-sensitive file system holds both')
  } finally {
    restore()
  }
})

// The folder's live files are matched as sameDest matches one file: where the file system ignores
// letter case (Windows, macOS, Android's shared storage), a live row in another case holds the
// same file and comes off the total; where it does not (Linux), it is another file.
for (const [platform, folds] of [['win32', true], ['darwin', true], ['android', true], ['linux', false]] as const) {
  const skip = process.platform === 'win32' && platform === 'android' && 'os.homedir() ignores HOME on Windows'
  test(`enqueue on ${platform}: a whole-folder download takes off its live files in another letter case ${folds ? 'as the same files' : 'only when the case matches'}`, { skip }, async (t) => {
    asPlatform(t, platform)
    const home = process.env.HOME
    const termux = tmpDir('tllm-termux-home-')
    process.env.HOME = termux
    t.after(() => { process.env.HOME = home })
    const restore = stubFetch()
    try {
      const { modelDir: plain, stateDir } = newDirs()
      // On Android, in Termux's link into shared storage (a test cannot create /storage).
      const modelDir = platform === 'android' ? join(termux, 'storage', 'shared', 'models') : plain
      mkdirSync(modelDir, { recursive: true })
      const st = statfsSync(modelDir)
      const shard = Math.floor(st.bavail * st.bsize * 0.4)
      const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
      await dm.enqueue({ repo: 'owner/big', rfilename: SHARDS[0], size: shard, subdir: 'Big/Ckpt-2' })
      await dm.enqueue({ repo: 'owner/big', rfilename: SHARDS[2], size: shard, subdir: 'Big/Ckpt-2' })

      const again = await Promise.allSettled(queueFolder(dm, 'big/ckpt-2', SHARDS, shard))
      if (folds) {
        assert.deepEqual(again.map((r) => r.status === 'fulfilled' && r.value.length), [0, 1, 0], 'the missing shard is queued; the live two add nothing')
      } else {
        for (const r of again) {
          assert.equal(r.status, 'rejected', 'the live two are other files, so the folder needs all three')
          assert.equal(((r as PromiseRejectedResult).reason as DownloadError).code, 'insufficient_disk')
        }
      }
    } finally {
      restore()
    }
  })
}

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

test('run: the HF token goes only to the HF origin — never to a raw-URL import host', async () => {
  const { modelDir, stateDir } = newDirs()
  const real = globalThis.fetch
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url: String(url), headers: { ...init.headers } })
    return new Response('x', { status: 200 })
  }) as unknown as typeof fetch
  try {
    const auth = () => ({ 'User-Agent': 'TurboLLM/test', Authorization: 'Bearer hf_SECRET' })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, auth, echoExpand())
    for (const url of ['http://192.168.1.5/model.gguf', 'https://mirror.example/model.gguf', 'http://huggingface.co/x.gguf']) {
      const [rec] = await dm.enqueue({ url })
      await waitTerminal(dm, rec.id)
    }
    const [hfRec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    await waitTerminal(dm, hfRec.id)

    const raw = seen.filter((s) => !s.url.startsWith('https://huggingface.co/'))
    assert.equal(raw.length, 3)
    for (const s of raw) {
      assert.equal(s.headers.Authorization, undefined, `no token for ${s.url}`)
      assert.equal(s.headers['User-Agent'], 'TurboLLM/test', 'other headers are kept')
    }
    const hf = seen.find((s) => s.url === 'https://huggingface.co/owner/repo/resolve/main/model.gguf')
    assert.equal(hf?.headers.Authorization, 'Bearer hf_SECRET', 'an HF download still authenticates (gated repos)')
  } finally {
    globalThis.fetch = real
  }
})

test('enqueue: a ".." segment in the file path is rejected (decoded resolve URL or raw rfilename)', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    // The expander's fallback (tree 404 / file not in the tree) echoes the caller's own path.
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), echoExpand())
    await assert.rejects(
      () => dm.enqueue({ url: 'https://huggingface.co/x/y/resolve/main/..%2F..%2F..%2F..%2Fescaped%2Fevil.gguf' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'invalid_request',
    )
    for (const rfilename of ['../../escaped/evil.gguf', 'sub/../../evil.gguf', '..\\..\\evil.gguf']) {
      await assert.rejects(
        () => dm.enqueue({ repo: 'owner/repo', rfilename }),
        (e: unknown) => e instanceof DownloadError && e.code === 'invalid_request',
        rfilename,
      )
    }
    assert.equal(dm.list().length, 0)
  } finally {
    restore()
  }
})

test("enqueue: the expander's dir is sanitised, so it can never place files outside the model dir", async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const hostile = async (): Promise<HfModelFiles> => ({
      dir: '../../escaped',
      files: [{ rfilename: 'evil.gguf', size: 10, mmproj: false }],
    })
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), hostile)
    const [rec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'evil.gguf' })
    assert.equal(rec.dest, join(modelDir, 'owner', 'repo', 'escaped', 'evil.gguf'))
  } finally {
    restore()
  }
})
