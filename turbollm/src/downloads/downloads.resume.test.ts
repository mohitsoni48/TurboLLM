// Tests for DownloadManager.resume (spec 10 §5): a job interrupted by a daemon
// restart comes back from restore() as 'paused' with the .part file's real byte
// offset — resume() is the only way to get it moving again (there is no
// auto-resume; pump() only starts 'queued' jobs). Regression coverage for a real
// bug: this trigger didn't exist at all before, so a restart-interrupted download
// had no way back — the UI only offered Cancel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadManager } from './downloads'

function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

function newDirs() {
  const root = mkdtempSync(join(tmpdir(), 'tllm-dl-resume-'))
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
