// Tests for DownloadManager.resume (spec 10 §5): a job interrupted by a daemon
// restart comes back from restore() as 'paused' with the .part file's real byte
// offset — resume() is the only way to get it moving again (there is no
// auto-resume; pump() only starts 'queued' jobs). Regression coverage for a real
// bug: this trigger didn't exist at all before, so a restart-interrupted download
// had no way back — the UI only offered Cancel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DownloadManager } from './downloads'
import { tmpDir } from '../test-support/tmp'

function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

function newDirs() {
  const root = tmpDir('tllm-dl-resume-')
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(join(stateDir, 'downloads'), { recursive: true })
  return { modelDir, stateDir }
}

/** Never-resolving fetch — freezes run() right after it flips status to
 *  'downloading', so the test can observe the transition without real network I/O
 *  or an OS handle left open after the process exits. */
function stubFetch(): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

/** Seed a manifest + partial file exactly as a real interrupted download leaves
 *  them on disk, then construct a DownloadManager over that state dir — exercising
 *  the real restore() path, not a hand-built record. */
function seedInterruptedDownload(modelDir: string, stateDir: string) {
  const dest = join(modelDir, 'model.gguf')
  writeFileSync(`${dest}.part`, Buffer.alloc(1024, 1))
  writeFileSync(
    join(stateDir, 'downloads', 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'dl-restored-1',
          name: 'model.gguf',
          repo: 'owner/repo',
          url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf',
          dest,
          total: 4096,
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  )
  return dest
}

test('resume: a restart-restored (paused) job flips to downloading and picks up from the .part offset', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    seedInterruptedDownload(modelDir, stateDir)

    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const restored = dm.list().find((r) => r.id === 'dl-restored-1')
    assert.ok(restored, 'the interrupted job should be restored from the manifest')
    assert.equal(restored!.status, 'paused', 'restore() never auto-resumes — it comes back paused')
    assert.equal(restored!.received, 1024, 'received bytes reflect the real .part file size on disk')

    const ok = dm.resume('dl-restored-1')
    assert.equal(ok, true)
    const after = dm.list().find((r) => r.id === 'dl-restored-1')
    assert.equal(after!.status, 'downloading', 'resume() re-queues and pump() starts it immediately')
  } finally {
    restore()
  }
})

test('resume: an errored job can also be resumed (a network hiccup, not just a restart)', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), async () => ({
      dir: '',
      files: [{ rfilename: 'model.gguf', size: 10, mmproj: false }],
    }))
    const [rec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    // Simulate a failed attempt without waiting on the frozen fetch.
    const asAny = dm as unknown as { records: Map<string, { status: string; error: string | null }> }
    asAny.records.get(rec.id)!.status = 'error'
    asAny.records.get(rec.id)!.error = 'network blip'

    const ok = dm.resume(rec.id)
    assert.equal(ok, true)
    const after = dm.list().find((r) => r.id === rec.id)
    assert.equal(after!.status, 'downloading')
    assert.equal(after!.error, null, 'resume clears the stale error message')
  } finally {
    restore()
  }
})

test('resume: returns false for an unknown id, or one that is not paused/errored', async () => {
  const restore = stubFetch()
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), async () => ({
      dir: '',
      files: [{ rfilename: 'model.gguf', size: 10, mmproj: false }],
    }))
    assert.equal(dm.resume('does-not-exist'), false)

    const [rec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf' })
    // Freshly enqueued -> already 'downloading' (frozen by the stub fetch) -> not resumable.
    assert.equal(dm.resume(rec.id), false)
  } finally {
    restore()
  }
})

/** Two rows for one file: an old failed attempt (A, flipped to 'error' by hand — the frozen
 *  fetch never fails on its own) and the fresh re-download the user started after it (B, live). */
async function staleAndLive() {
  const { modelDir, stateDir } = newDirs()
  const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  const [a] = await dm.enqueue({ url: 'https://example.com/m.gguf' })
  const asAny = dm as unknown as { records: Map<string, { status: string; error: string | null }> }
  asAny.records.get(a.id)!.status = 'error'
  asAny.records.get(a.id)!.error = 'network blip'
  const [b] = await dm.enqueue({ url: 'https://example.com/m.gguf' })
  assert.ok(b, 'hasLiveDest lets a fresh attempt through while the old row is only errored')
  assert.equal(a.dest, b.dest)
  writeFileSync(`${b.dest}.part`, Buffer.alloc(64, 7)) // B's bytes so far
  return { dm, a, b }
}

test('a stale errored row never deletes the .part a live re-download of the same file is writing', async () => {
  const restore = stubFetch()
  try {
    const { dm, a, b } = await staleAndLive()
    assert.equal(dm.remove(a.id), true)
    assert.ok(existsSync(`${b.dest}.part`), 'Remove on the old row must leave the live .part alone')

    const second = await staleAndLive()
    assert.equal(second.dm.cancel(second.a.id), true)
    assert.ok(existsSync(`${second.b.dest}.part`), 'Cancel on the old row must leave the live .part alone')

    // Control: with no other owner, removing a row still cleans up its own .part.
    assert.equal(second.dm.cancel(second.b.id), true)
    assert.equal(existsSync(`${second.b.dest}.part`), false)
  } finally {
    restore()
  }
})

test('resume: an errored row cannot start a second writer while another row is downloading the same file', async () => {
  const restore = stubFetch()
  try {
    const { dm, a, b } = await staleAndLive()
    assert.equal(dm.list().find((r) => r.id === b.id)!.status, 'downloading')
    assert.equal(dm.resume(a.id), false)
    assert.equal(dm.list().find((r) => r.id === a.id)!.status, 'error', 'the stale row stays put')
  } finally {
    restore()
  }
})

/** Seed a restart-interrupted download whose manifest knows the file's sha256, with `prefix`
 *  already in the .part, and serve the rest of `full` as a 206 for the Range request. */
async function resumeAgainst(prefix: Buffer, full: Buffer) {
  const { modelDir, stateDir } = newDirs()
  const dest = join(modelDir, 'model.gguf')
  writeFileSync(`${dest}.part`, prefix)
  writeFileSync(
    join(stateDir, 'downloads', 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: [{
        id: 'dl-hash-1', name: 'model.gguf', repo: 'owner/repo',
        url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf', dest, total: full.length,
        sha256: createHash('sha256').update(full).digest('hex'), createdAt: new Date().toISOString(),
      }],
    }),
  )
  const real = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    const from = Number(/bytes=(\d+)-/.exec(init.headers.Range ?? '')?.[1] ?? 0)
    const rest = full.subarray(from)
    return new Response(rest, { status: from > 0 ? 206 : 200, headers: { 'content-length': String(rest.length) } })
  }) as unknown as typeof fetch
  try {
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    assert.equal(dm.resume('dl-hash-1'), true)
    for (let i = 0; i < 200; i++) {
      const r = dm.list().find((x) => x.id === 'dl-hash-1')!
      if (r.status === 'done' || r.status === 'error') return { rec: r, dest }
      await new Promise((res) => setTimeout(res, 5))
    }
    throw new Error('timed out waiting for the resumed download')
  } finally {
    globalThis.fetch = real
  }
}

test('resume: a stale/corrupt .part prefix fails the sha256 check instead of landing as done', async () => {
  const full = Buffer.from('NEW-UPLOAD:'.repeat(20))
  const stalePrefix = Buffer.from('OLD-UPLOAD:'.repeat(5)) // same length as the real prefix
  const { rec, dest } = await resumeAgainst(stalePrefix, full)
  assert.equal(rec.status, 'error')
  assert.match(rec.error ?? '', /Checksum failed/)
  assert.equal(existsSync(dest), false, 'the spliced file never reaches the library')
  assert.equal(existsSync(`${dest}.part`), false, 'the bad .part is dropped so the next try starts clean')
})

test('resume: a good .part prefix plus the ranged remainder verifies and completes', async () => {
  const full = Buffer.from('NEW-UPLOAD:'.repeat(20))
  const { rec, dest } = await resumeAgainst(full.subarray(0, 55), full)
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(dest), full)
})
