// Scalability review tier 4 (items 4.1, 4.9, 4.10): the disk guard counts what the other downloads still
// have to write, the concurrent-file count is a config field (default 2), a resume prefix hash runs
// outside the slot budget, and a multi-file download rescans the library once, not once per file.
// Temp directories only; fetch is a double, so nothing leaves the machine and no port is touched.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DownloadManager, DownloadError, setDownloadGetForTests } from './downloads'
import { tmpDir } from '../test-support/tmp'

setDownloadGetForTests((url, init) => globalThis.fetch(url, init))

function newDirs() {
  const root = tmpDir('tllm-dl-scale-')
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return { modelDir, stateDir }
}

function storeOf(modelDir: string, stateDir: string, downloadConcurrency?: number) {
  const cfg = { primaryModelDir: modelDir, modelDirs: [modelDir], downloadConcurrency }
  return { dir: () => stateDir, snapshot: () => cfg, read: () => cfg } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

/** Replace fetch for one test; returns the restore. */
function withFetch(impl: (url: string) => Promise<Response>): () => void {
  const real = globalThis.fetch
  globalThis.fetch = ((url: string) => impl(String(url))) as unknown as typeof fetch
  return () => { globalThis.fetch = real }
}
const never = () => new Promise<Response>(() => {})
/** Replace fetch with one that hangs until its request is aborted, as a real one does: a paused row's run() ends. */
function withAbortableFetch(): () => void {
  const real = globalThis.fetch
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
  return () => { globalThis.fetch = real }
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await settle(5)
  assert.ok(cond(), 'timed out')
}

test('4.1: a second large file is refused when the first one\'s unwritten bytes already claim the disk', async () => {
  const restore = withFetch(never)
  try {
    const { modelDir, stateDir } = newDirs()
    const st = statfsSync(modelDir)
    const half = Math.floor(st.bavail * st.bsize * 0.5) // each fits alone (x1.1), both together do not
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    const first = await dm.enqueue({ repo: 'owner/a', rfilename: 'a.safetensors', size: half, subdir: 'a' })
    assert.equal(first.length, 1)
    await assert.rejects(
      () => dm.enqueue({ repo: 'owner/b', rfilename: 'b.safetensors', size: half, subdir: 'b' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'insufficient_disk',
    )
    assert.equal(dm.list().length, 1, 'the refused file queued nothing')
  } finally {
    restore()
  }
})

test('4.1: bytes already written no longer count against the disk, and a paused row claims nothing', async () => {
  const restore = withFetch(never)
  try {
    const { modelDir, stateDir } = newDirs()
    const st = statfsSync(modelDir)
    const half = Math.floor(st.bavail * st.bsize * 0.5)
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    const [a] = await dm.enqueue({ repo: 'owner/a', rfilename: 'a.safetensors', size: half, subdir: 'a' })
    dm.pause(a.id)
    const [b] = await dm.enqueue({ repo: 'owner/b', rfilename: 'b.safetensors', size: half, subdir: 'b' })
    assert.ok(b, 'a paused download is not writing, so the second one fits')
  } finally {
    restore()
  }
})

test('4.9: the number of files downloading at once is config.downloadConcurrency, 2 when unset', async () => {
  const restore = withFetch(never)
  try {
    for (const [configured, expected] of [[undefined, 2], [4, 4], [1, 1]] as const) {
      const { modelDir, stateDir } = newDirs()
      const dm = new DownloadManager(storeOf(modelDir, stateDir, configured), () => {}, () => ({}))
      for (let i = 0; i < 6; i++) await dm.enqueue({ repo: 'owner/c', rfilename: `f${i}.safetensors`, size: 5, subdir: 'c' })
      assert.equal(dm.activeCount(), expected, `configured ${String(configured)}`)
    }
  } finally {
    restore()
  }
})

test('4.9: a resume prefix hash runs before the row takes a slot, and the checksum is still enforced', async () => {
  const body = Buffer.from('0123456789')
  const sha = createHash('sha256').update(body).digest('hex')
  let respond: () => Promise<Response> = never
  const restore = withFetch(() => respond())
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    // A row paused with a prefix on disk, as Resume finds it. (A NEW row removes a stray .part, so only Resume resumes one.)
    const paused = async (name: string, prefix: Buffer) => {
      const [rec] = await dm.enqueue({ repo: 'owner/r', rfilename: name, size: 10, sha256: sha, subdir: 'r' })
      dm.pause(rec.id)
      await until(() => dm.activeCount() === 0)
      await settle()
      writeFileSync(`${rec.dest}.part`, prefix)
      return rec
    }
    respond = async () => new Response(body.subarray(4), { status: 206, headers: { 'content-length': '6', 'content-range': 'bytes 4-9/10' } })

    const rec = await paused('m.gguf', body.subarray(0, 4))
    assert.equal(dm.resume(rec.id), true)
    assert.equal(rec.status, 'queued', 'hashing the prefix does not hold a download slot')
    assert.equal(dm.activeCount(), 0)
    await until(() => rec.status === 'done')

    // A corrupt prefix is still caught: the same bytes with another first byte fail the checksum.
    const bad = Buffer.from(body)
    bad[0] ^= 0xff
    const rec2 = await paused('n.gguf', bad.subarray(0, 4))
    dm.resume(rec2.id)
    await until(() => rec2.status === 'error')
  } finally {
    restore()
  }
})

test('4.10: a 10-file folder download rescans once, a single file rescans at once', async () => {
  const restore = withFetch(async () => new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
  try {
    const { modelDir, stateDir } = newDirs()
    let rescans = 0
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => { rescans++ }, () => ({}))
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.safetensors`)
    const folder = { files: names.map((n) => ({ path: `ckpt/${n}`, size: 5 })) }
    await Promise.all(names.map((rfilename) => dm.enqueue({ repo: 'owner/c', rfilename, size: 5, subdir: 'ckpt', folder })))
    await until(() => dm.list().every((r) => r.status === 'done'))
    assert.equal(rescans, 1)

    await dm.enqueue({ repo: 'owner/d', rfilename: 'one.safetensors', size: 5, subdir: 'd' })
    await until(() => dm.list().every((r) => r.status === 'done'))
    assert.equal(rescans, 2)
  } finally {
    restore()
  }
})

test('4.1: a row whose folder does not exist any more still counts against the same volume', async () => {
  const restore = withFetch(never)
  try {
    const { modelDir, stateDir } = newDirs()
    const half = Math.floor(statfsSync(modelDir).bavail * statfsSync(modelDir).bsize * 0.5)
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    const [a] = await dm.enqueue({ repo: 'owner/a', rfilename: 'a.safetensors', size: half, subdir: 'a' })
    rmSync(dirname(a.dest), { recursive: true, force: true }) // a restored row's folder can be gone
    await assert.rejects(
      () => dm.enqueue({ repo: 'owner/b', rfilename: 'b.safetensors', size: half, subdir: 'b' }),
      (e: unknown) => e instanceof DownloadError && e.code === 'insufficient_disk',
    )
  } finally {
    restore()
  }
})

test('4.1: resuming a paused row that no longer fits beside the live rows is refused and it stays paused', async () => {
  const restore = withFetch(never)
  try {
    const { modelDir, stateDir } = newDirs()
    const half = Math.floor(statfsSync(modelDir).bavail * statfsSync(modelDir).bsize * 0.5)
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    const [a] = await dm.enqueue({ repo: 'owner/a', rfilename: 'a.safetensors', size: half, subdir: 'a' })
    dm.pause(a.id)
    await dm.enqueue({ repo: 'owner/b', rfilename: 'b.safetensors', size: half, subdir: 'b' })
    assert.throws(() => dm.resume(a.id), (e: unknown) => e instanceof DownloadError && e.code === 'insufficient_disk')
    assert.equal(a.status, 'paused')
  } finally {
    restore()
  }
})

test('4.9: resuming ten rows hashes at most two prefixes at a time', async () => {
  const body = Buffer.from('0123456789')
  const sha = createHash('sha256').update(body).digest('hex')
  const restore = withAbortableFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const [rec] = await dm.enqueue({ repo: 'owner/r', rfilename: `m${i}.gguf`, size: 10, sha256: sha, subdir: 'r' })
      dm.pause(rec.id)
      ids.push(rec.id)
    }
    await until(() => dm.activeCount() === 0)
    await settle()
    for (const id of ids) writeFileSync(`${dm.list().find((r) => r.id === id)!.dest}.part`, body.subarray(0, 4))
    for (const id of ids) dm.resume(id)
    const hashing = [...(dm as unknown as { prefixHashes: Map<string, { done: boolean }> }).prefixHashes.values()].filter((h) => !h.done)
    assert.ok(hashing.length > 0 && hashing.length <= 2, `hashing ${hashing.length}`)
  } finally {
    restore()
  }
})

test('4.9: cancelling a row while its prefix hash is pending drops the hash entry', async () => {
  const body = Buffer.from('0123456789')
  const sha = createHash('sha256').update(body).digest('hex')
  const restore = withAbortableFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(storeOf(modelDir, stateDir), () => {}, () => ({}))
    const [rec] = await dm.enqueue({ repo: 'owner/r', rfilename: 'm.gguf', size: 10, sha256: sha, subdir: 'r' })
    dm.pause(rec.id)
    await until(() => dm.activeCount() === 0)
    await settle()
    writeFileSync(`${rec.dest}.part`, body.subarray(0, 4))
    dm.resume(rec.id)
    const hashes = (dm as unknown as { prefixHashes: Map<string, unknown> }).prefixHashes
    assert.ok(hashes.has(rec.id))
    dm.cancel(rec.id)
    assert.equal(hashes.has(rec.id), false)
  } finally {
    restore()
  }
})
