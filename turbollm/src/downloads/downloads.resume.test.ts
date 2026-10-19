// Tests for DownloadManager.resume (spec 10 §5): a job interrupted by a daemon
// restart comes back from restore() as 'paused' with the .part file's real byte
// offset — resume() is the only way to get it moving again (there is no
// auto-resume; pump() only starts 'queued' jobs). Regression coverage for a real
// bug: this trigger didn't exist at all before, so a restart-interrupted download
// had no way back — the UI only offered Cancel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DownloadManager, type DownloadError } from './downloads'
import { registerApi } from '../api/routes'
import type { Deps } from '../deps'
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
    // A distinct refusal, not `false`: the row exists, so "no such download" would be wrong.
    assert.throws(() => dm.resume(a.id), (e: unknown) => (e as DownloadError).code === 'download_in_progress')
    assert.equal(dm.list().find((r) => r.id === a.id)!.status, 'error', 'the stale row stays put')

    // Over HTTP that is a 409 the UI can show, not the 404 'No paused or errored download'.
    const app = new Hono()
    registerApi(app, { downloads: dm } as unknown as Deps)
    const res = await app.request(`/api/v1/downloads/${a.id}/resume`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'download_in_progress')
    assert.match(body.error.message, /Another download is already writing this file/)
    const missing = await app.request('/api/v1/downloads/no-such-id/resume', { method: 'POST', body: '{}' })
    assert.equal(missing.status, 404, 'an unknown id is still a 404')
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

/** A raw-URL import (no sha256, enqueued with total 0) whose first attempt got `prefix` of
 *  `oldFile` (served with `etag`, or with these validator headers), followed by a daemon
 *  restart: the second DownloadManager restores the row from the manifest exactly as a real
 *  restart does. `how` is how the first attempt ended: 'error' (the connection dropped, so
 *  run()'s catch path wrote the manifest) or 'killed' (the daemon died mid-body: no error path
 *  ran, the manifest holds only what run() persisted on its way). */
async function interruptedRawDownload(
  oldFile: Buffer,
  prefixLen: number,
  etag: string | Record<string, string>,
  how: 'error' | 'killed' = 'error',
) {
  const validatorHeaders = typeof etag === 'string' ? { etag } : etag
  const { modelDir, stateDir } = newDirs()
  let partPath = '' // the row's .part, known once enqueue returns
  const real = globalThis.fetch
  globalThis.fetch = (async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (pulls++ === 0) return c.enqueue(new Uint8Array(oldFile.subarray(0, prefixLen)))
        if (how === 'killed') return new Promise<void>(() => {}) // the process is gone: nothing more happens
        await untilPartHolds(() => partPath, prefixLen) // the drop comes after the prefix is on disk
        c.error(new Error('ECONNRESET'))
      },
    })
    return new Response(body, { status: 200, headers: { 'content-length': String(oldFile.length), ...validatorHeaders } })
  }) as unknown as typeof fetch
  try {
    const first = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const [rec] = await first.enqueue({ url: 'https://mirror.example/model.gguf' })
    const part = `${rec.dest}.part`
    partPath = part
    if (how === 'error') {
      await waitSettled(first, rec.id)
      assert.equal(first.list()[0].status, 'error')
    } else {
      for (let i = 0; i < 400 && (!existsSync(part) || readFileSync(part).length < prefixLen); i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert.equal(first.list()[0].status, 'downloading', 'killed mid-body, before any error path')
    }
    assert.equal(readFileSync(part).length, prefixLen, 'the first attempt left its prefix in the .part')
    return { modelDir, stateDir, id: rec.id, dest: rec.dest, dm: first }
  } finally {
    globalThis.fetch = real
  }
}

/** Waits, for about 2 s at most, until the file at `path()` holds exactly `size` bytes. A fake body
 *  that drops its connection waits for this first: a fixed 30 ms sleep raced the DownloadManager's
 *  open of the .part (createWriteStream opens it on the threadpool). On a loaded machine the drop
 *  came before that open finished, the pipeline destroyed the stream with the bytes still buffered,
 *  and the .part was left empty ("the first attempt left its prefix in the .part", 0 !== 60). */
async function untilPartHolds(path: () => string, size: number) {
  for (let i = 0; i < 400; i++) {
    const p = path()
    if (p && statSync(p, { throwIfNoEntry: false })?.size === size) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function waitSettled(dm: DownloadManager, id: string) {
  for (let i = 0; i < 400; i++) {
    const r = dm.list().find((x) => x.id === id)!
    if (r.status === 'done' || r.status === 'error') return r
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error('timed out waiting for the download to settle')
}

/** A server holding `file` under `etag` that implements Range and If-Range like a real one
 *  (a stale If-Range gets the whole file as a 200), unless `ignoreIfRange` (Hugging Face's
 *  CDN answers a stale If-Range with a 206 of the current file). A range starting at or past
 *  the end of the file gets a 416 whatever the If-Range, as on that CDN. `etagOn206: false`
 *  leaves the ETag off its 206 responses; `lastModified` is sent on every response; `rangeCap`
 *  caps an open-ended range at that many bytes (the 206 then ends before the end of the file). */
function serve(
  file: Buffer,
  etag: string,
  seen: Array<Record<string, string>>,
  {
    ignoreIfRange = false,
    etagOn206 = true,
    lastModified,
    rangeCap,
    shortBody,
  }: { ignoreIfRange?: boolean; etagOn206?: boolean; lastModified?: string; rangeCap?: number; shortBody?: number } = {},
) {
  const lm: Record<string, string> = lastModified ? { 'last-modified': lastModified } : {}
  return (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push({ ...init.headers })
    const from = Number(/bytes=(\d+)-/.exec(init.headers.Range ?? '')?.[1] ?? 0)
    const ifRange = init.headers['If-Range']
    if (from > 0 && from >= file.length) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.length}`, etag, ...lm } })
    }
    if (from > 0 && (ignoreIfRange || !ifRange || ifRange === etag)) {
      const end = rangeCap ? Math.min(file.length, from + rangeCap) : file.length
      // shortBody: a malformed reply whose body (and Content-Length) is shorter than its own range.
      const rest = file.subarray(from, end - (shortBody ?? 0))
      return new Response(rest, {
        status: 206,
        headers: {
          'content-length': String(rest.length),
          'content-range': `bytes ${from}-${end - 1}/${file.length}`,
          ...(etagOn206 ? { etag } : {}),
          ...lm,
        },
      })
    }
    return new Response(file, { status: 200, headers: { 'content-length': String(file.length), etag, ...lm } })
  }) as unknown as typeof fetch
}

async function resumeAfterRestart(stateDir: string, modelDir: string, id: string, fetchImpl: typeof fetch) {
  const real = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    assert.equal(dm.list().find((r) => r.id === id)?.status, 'paused')
    assert.equal(dm.resume(id), true)
    return await waitSettled(dm, id)
  } finally {
    globalThis.fetch = real
  }
}

const OLD_FILE = Buffer.from('GGUF-OLD-UPLOAD:'.repeat(8)) // 128 bytes
const NEW_FILE = Buffer.from('GGUF-NEW-REQUANT:'.repeat(10)) // 170 bytes

test('resume without a sha256: the upstream file changed, so If-Range gets the whole new file instead of a spliced one', async () => {
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(NEW_FILE, '"new"', seen))
  assert.equal(seen[0]['If-Range'], '"old"', 'the validator of the first attempt survived the restart')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(dest), NEW_FILE, 'the library gets the new file, not old prefix + new tail')
})

test('resume without a sha256: the same file still resumes from the .part offset', async () => {
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, '"old"', seen))
  assert.equal(seen[0].Range, 'bytes=60-')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(dest), OLD_FILE)
})

test('resume without a sha256: a server that ignores If-Range and sends another file\'s tail is refused, not spliced', async () => {
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(NEW_FILE, '"new"', [], { ignoreIfRange: true }))
  assert.equal(rec.status, 'error')
  assert.match(rec.error ?? '', /changed on the server/)
  assert.equal(existsSync(dest), false, 'the spliced file never reaches the library')
  assert.equal(existsSync(`${dest}.part`), false, 'the stale .part is dropped so the next try starts clean')
})

// The restart case: the daemon dies mid-download (no error path writes the manifest),
// the file changes upstream, then Resume, against a server that ignores If-Range.
const NEW_SAME_SIZE = Buffer.from('GGUF-NEW-UPLOAD:'.repeat(8)) // 128 bytes, like OLD_FILE

test('resume after the daemon was killed mid-download: the validator and the full length were already persisted', async () => {
  const { stateDir } = await interruptedRawDownload(OLD_FILE, 60, '"old"', 'killed')
  const manifest = JSON.parse(readFileSync(join(stateDir, 'downloads', 'manifest.json'), 'utf8')) as {
    entries: Array<{ total: number; validator?: string }>
  }
  assert.deepEqual(
    manifest.entries.map((e) => ({ total: e.total, validator: e.validator })),
    [{ total: OLD_FILE.length, validator: '"old"' }],
  )
})

test('resume after the daemon was killed mid-download: a same-size new file whose 206 names another ETag is refused, not spliced', async () => {
  // Same size, Content-Range right: only the 206's own validator tells the files apart.
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"', 'killed')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(NEW_SAME_SIZE, '"new"', seen, { ignoreIfRange: true }))
  assert.equal(seen[0]['If-Range'], '"old"')
  assert.equal(rec.status, 'error', 'not done with old prefix + new tail')
  assert.match(rec.error ?? '', /changed on the server/)
  assert.equal(existsSync(dest), false)
  assert.equal(existsSync(`${dest}.part`), false)
})

test('resume after the daemon was killed mid-download: a 206 with no validator but another full length is refused, not spliced', async () => {
  // No ETag on the 206: only the full length persisted before the kill tells the files apart.
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"', 'killed')
  const rec = await resumeAfterRestart(
    stateDir,
    modelDir,
    id,
    serve(NEW_FILE, '"new"', [], { ignoreIfRange: true, etagOn206: false }),
  )
  assert.equal(rec.status, 'error', 'not done with old prefix + new tail')
  assert.match(rec.error ?? '', /changed on the server/)
  assert.equal(existsSync(dest), false)
  assert.equal(existsSync(`${dest}.part`), false)
})

test('resume after the daemon was killed mid-download: the same file resumes from the .part offset', async () => {
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"', 'killed')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, '"old"', seen, { ignoreIfRange: true }))
  assert.equal(seen[0].Range, 'bytes=60-')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(dest), OLD_FILE)
})

test('resume: a 206 that stops short of the end of the file is refused, not marked done truncated', async () => {
  // A server capping open-ended ranges answers `bytes=60-` with `bytes 60-99/128`: right start,
  // right full length, but taking the total as offset + content-length would pass the size
  // check on a 100-byte file.
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, '"old"', seen, { rangeCap: 40 }))
  assert.equal(seen[0].Range, 'bytes=60-')
  assert.equal(rec.status, 'error', 'not done with 100 of 128 bytes')
  assert.match(rec.error ?? '', /does not continue the partial file/)
  assert.equal(existsSync(dest), false, 'the truncated file never reaches the library')
  assert.equal(existsSync(`${dest}.part`), false, 'the next try starts clean (a 200 of the whole file)')
})

test('resume: a 206 whose body is shorter than its own Content-Range is refused, not marked done truncated', async () => {
  // `bytes 60-127/128` with a 40-byte body and Content-Length: offset + content-length (100)
  // would pass the size check; the range's own full length (128) does not.
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, '"old"', seen, { shortBody: 28 }))
  assert.equal(rec.status, 'error', 'not done with 100 of 128 bytes')
  assert.match(rec.error ?? '', /size did not match/)
  assert.equal(existsSync(dest), false, 'the truncated file never reaches the library')
  assert.equal(existsSync(`${dest}.part`), false, 'the next try starts clean')
})

const LM_OLD = 'Wed, 21 Oct 2015 07:28:00 GMT'
const LM_NEW = 'Thu, 22 Oct 2015 07:28:00 GMT'

test('resume: a 206 with only a Last-Modified still continues a .part written under an ETag (like is compared with like)', async () => {
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, { etag: '"old"', 'last-modified': LM_OLD })
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(
    stateDir,
    modelDir,
    id,
    serve(OLD_FILE, '"old"', seen, { etagOn206: false, lastModified: LM_OLD }),
  )
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(seen.length, 1, 'resumed from the .part, not restarted')
  assert.deepEqual(readFileSync(dest), OLD_FILE)
})

test('resume: a 206 that adds an ETag still continues a .part written under a Last-Modified; another Last-Modified is refused', async () => {
  const first = await interruptedRawDownload(OLD_FILE, 60, { 'last-modified': LM_OLD })
  const seen: Array<Record<string, string>> = []
  const same = await resumeAfterRestart(
    first.stateDir,
    first.modelDir,
    first.id,
    serve(OLD_FILE, '"etag-on-206"', seen, { ignoreIfRange: true, lastModified: LM_OLD }),
  )
  assert.equal(seen[0]['If-Range'], LM_OLD)
  assert.equal(same.status, 'done', same.error ?? '')
  assert.equal(seen.length, 1, 'resumed from the .part, not restarted')
  assert.deepEqual(readFileSync(first.dest), OLD_FILE)

  const changed = await interruptedRawDownload(OLD_FILE, 60, { 'last-modified': LM_OLD })
  const rec = await resumeAfterRestart(
    changed.stateDir,
    changed.modelDir,
    changed.id,
    serve(NEW_SAME_SIZE, '"etag-on-206"', [], { ignoreIfRange: true, lastModified: LM_NEW }),
  )
  assert.equal(rec.status, 'error', 'not done with old prefix + new tail')
  assert.equal(existsSync(changed.dest), false)
})

/** A row restored from the manifest exactly as a restart leaves it, with `part` already in its
 *  .part and these manifest fields (a raw-URL import unless the entry says otherwise). */
function seedRestored(
  part: Buffer,
  entry: { total: number; sha256?: string; validator?: string; repo?: string; url?: string },
) {
  const { modelDir, stateDir } = newDirs()
  const dest = join(modelDir, 'model.gguf')
  writeFileSync(`${dest}.part`, part)
  writeFileSync(
    join(stateDir, 'downloads', 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: [{
        id: 'dl-416', name: 'model.gguf', repo: '', url: 'https://mirror.example/model.gguf', dest,
        createdAt: new Date().toISOString(), ...entry,
      }],
    }),
  )
  return { modelDir, stateDir, id: 'dl-416', dest }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

test('resume: a .part longer than a file that shrank on the server gets a 416, then downloads the file again', async () => {
  // Paused at 170 bytes of a former upload; the server now holds a 128-byte file, so
  // `bytes=170-` is unsatisfiable. Before the fix every Resume failed with "HTTP 416".
  const { modelDir, stateDir, id, dest } = seedRestored(NEW_FILE, { total: NEW_FILE.length, validator: '"new"' })
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, '"old"', seen))
  assert.equal(seen[0].Range, `bytes=${NEW_FILE.length}-`)
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(seen.length, 2, 'one fresh request after the 416')
  assert.equal(seen[1].Range, undefined, 'the fresh request asks for the whole file')
  assert.equal(seen[1]['If-Range'], undefined)
  assert.deepEqual(readFileSync(dest), OLD_FILE)
  assert.equal(existsSync(`${dest}.part`), false)
})

test('resume: a complete .part (the daemon died before the rename) is verified by its sha256 and finished on a 416', async () => {
  const { modelDir, stateDir, id, dest } = seedRestored(OLD_FILE, { total: OLD_FILE.length, sha256: sha(OLD_FILE), validator: '"old"' })
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, '"old"', seen))
  assert.equal(seen[0].Range, `bytes=${OLD_FILE.length}-`)
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(seen.length, 1, 'nothing downloaded again: the .part already was the file')
  assert.equal(rec.received, OLD_FILE.length)
  assert.deepEqual(readFileSync(dest), OLD_FILE)
  assert.equal(existsSync(`${dest}.part`), false)

  // Same length, wrong bytes: the sha256 rules it out, so it is dropped and fetched again.
  const bad = seedRestored(NEW_SAME_SIZE, { total: OLD_FILE.length, sha256: sha(OLD_FILE), validator: '"old"' })
  const seen2: Array<Record<string, string>> = []
  const again = await resumeAfterRestart(bad.stateDir, bad.modelDir, bad.id, serve(OLD_FILE, '"old"', seen2))
  assert.equal(again.status, 'done', again.error ?? '')
  assert.equal(seen2.length, 2)
  assert.deepEqual(readFileSync(bad.dest), OLD_FILE)
})

test('resume: a server that answers 416 even to the plain request restarts once, then fails with no .part left', async () => {
  const { modelDir, stateDir, id, dest } = seedRestored(OLD_FILE, { total: OLD_FILE.length, validator: '"old"' })
  const seen: Array<Record<string, string>> = []
  const always416 = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push({ ...init.headers })
    return new Response(null, { status: 416 })
  }) as unknown as typeof fetch
  const rec = await resumeAfterRestart(stateDir, modelDir, id, always416)
  assert.equal(rec.status, 'error')
  assert.match(rec.error ?? '', /HTTP 416/)
  assert.equal(seen.length, 2, 'one retry from byte 0, not a loop')
  assert.equal(seen[1].Range, undefined)
  assert.equal(existsSync(`${dest}.part`), false, 'the next Resume starts from byte 0, not the same 416 range')
})

/** A server holding `file` that answers a Range request with a 416 (naming the file's length as
 *  `bytes *\/N` unless `bare`) and the plain request with a 200 of `file` sent without a
 *  Content-Length (a chunked reply) or any validator. `hangAfter` stops the 200 after that many
 *  bytes with the connection left open: the daemon is killed during it. */
function shrunkNoLength(
  file: Buffer,
  seen: Array<Record<string, string>>,
  { bare = false, hangAfter }: { bare?: boolean; hangAfter?: number } = {},
) {
  return (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push({ ...init.headers })
    if (init.headers.Range) {
      return new Response(null, { status: 416, headers: bare ? {} : { 'content-range': `bytes */${file.length}` } })
    }
    if (hangAfter === undefined) return new Response(file, { status: 200 })
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) return c.enqueue(new Uint8Array(file.subarray(0, hangAfter)))
        return new Promise<void>(() => {}) // the process is gone: nothing more happens
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
}

test('resume: after a 416, a restart whose 200 has no Content-Length is checked against the length the 416 names', async () => {
  // Paused at 170 bytes of a former upload; the server now holds 128 and streams it chunked.
  // Before the fix the restart kept the old total of 170, failed "size did not match" and
  // removed the .part, and every later Resume did the same.
  const { modelDir, stateDir, id, dest } = seedRestored(NEW_FILE, { total: NEW_FILE.length, validator: '"new"' })
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, shrunkNoLength(OLD_FILE, seen))
  assert.equal(seen.length, 2, 'the 416, then the plain request')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(rec.total, OLD_FILE.length, 'the length from the 416, not the old total')
  assert.deepEqual(readFileSync(dest), OLD_FILE)

  // A 416 that names no length: the old total is dropped and the length is unknown, as for a
  // raw URL enqueued with no size.
  const bare = seedRestored(NEW_FILE, { total: NEW_FILE.length, validator: '"new"' })
  const again = await resumeAfterRestart(bare.stateDir, bare.modelDir, bare.id, shrunkNoLength(OLD_FILE, [], { bare: true }))
  assert.equal(again.status, 'done', again.error ?? '')
  assert.deepEqual(readFileSync(bare.dest), OLD_FILE)
})

test('resume: the length a 416 names is persisted before the restart\'s body arrives', async () => {
  // A daemon killed during the restart must not come back with the old total: a 200 without a
  // Content-Length on the next Resume would be checked against it. No validator on either side,
  // so nothing else in run() writes the manifest before the body ends.
  const { modelDir, stateDir, id, dest } = seedRestored(NEW_FILE, { total: NEW_FILE.length })
  const real = globalThis.fetch
  globalThis.fetch = shrunkNoLength(OLD_FILE, [], { hangAfter: 50 })
  try {
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    assert.equal(dm.resume(id), true)
    const part = `${dest}.part`
    // The seeded .part holds 170 bytes: wait for the restart's 50 to replace them.
    for (let i = 0; i < 400 && (!existsSync(part) || readFileSync(part).length !== 50); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(readFileSync(part).length, 50, 'killed mid-body of the restart')
    assert.equal(dm.list()[0].status, 'downloading')
    assert.deepEqual(manifestEntries(stateDir).map((e) => e.total), [OLD_FILE.length])
  } finally {
    globalThis.fetch = real
  }
})

const FILE_4K = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 251))

test('resume: a server that ignores Range sends the whole file as a 200, and the sha256 covers that file alone', async () => {
  // run() hashes the 1 KiB .part prefix before the request; the 200 then replaces that prefix,
  // so the hash must start over with it. Kept, the file's own bytes hashed after the old prefix
  // failed the checksum and the good download was deleted.
  const { modelDir, stateDir, id, dest } = seedRestored(FILE_4K.subarray(0, 1024), {
    total: FILE_4K.length,
    sha256: sha(FILE_4K),
    repo: 'owner/repo',
    url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf',
  })
  const seen: Array<Record<string, string>> = []
  const ignoresRange = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push({ ...init.headers })
    return new Response(FILE_4K, { status: 200, headers: { 'content-length': String(FILE_4K.length) } })
  }) as unknown as typeof fetch
  const rec = await resumeAfterRestart(stateDir, modelDir, id, ignoresRange)
  assert.equal(seen[0].Range, 'bytes=1024-', 'a resume, so the prefix was hashed first')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(seen.length, 1)
  assert.deepEqual(readFileSync(dest), FILE_4K)
})

/** The manifest's entries as the last persist() wrote them. */
function manifestEntries(stateDir: string) {
  return (
    JSON.parse(readFileSync(join(stateDir, 'downloads', 'manifest.json'), 'utf8')) as {
      entries: Array<{ total: number; validator?: string }>
    }
  ).entries
}

test('resume: a weak ETag is never stored as the validator, so a resume sends no If-Range', async () => {
  // RFC 9110 §13.1.5: If-Range takes only a strong validator, and with a weak ETag present a
  // Last-Modified may not stand in for it. A server must not honour a weak one there, so a
  // stored W/ ETag made every resume from such a host start again from byte 0.
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, { etag: 'W/"weak1"', 'last-modified': LM_OLD })
  assert.deepEqual(manifestEntries(stateDir).map((e) => e.validator), [undefined])
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, 'W/"weak1"', seen, { lastModified: LM_OLD }))
  assert.equal(seen[0].Range, 'bytes=60-')
  assert.equal(seen[0]['If-Range'], undefined)
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(dest), OLD_FILE)
})

test('resume: a 206 with a weak ETag still continues a .part written under the strong one', async () => {
  // A weak ETag on the 206 says nothing about which bytes it holds; only a strong one may
  // refuse the reply. The Content-Range is right, so the resume completes.
  const { modelDir, stateDir, id, dest } = await interruptedRawDownload(OLD_FILE, 60, '"strong1"')
  const seen: Array<Record<string, string>> = []
  const rec = await resumeAfterRestart(stateDir, modelDir, id, serve(OLD_FILE, 'W/"strong1"', seen, { ignoreIfRange: true }))
  assert.equal(seen[0]['If-Range'], '"strong1"')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(seen.length, 1, 'resumed from the .part, not refused and restarted')
  assert.deepEqual(readFileSync(dest), OLD_FILE)
})

/** A server whose replies carry no ETag or Last-Modified: it answers `status` (a 206 of the rest
 *  of `file` from the Range offset, or a 200 of all of it), sends `n` bytes of that and then
 *  drops the connection, once they are in `part` (the row's .part: the offset plus `n` after a
 *  206, `n` alone after a 200). */
function noValidatorThenDrops(file: Buffer, status: 200 | 206, n: number, part: string) {
  return (async (_url: string, init: { headers: Record<string, string> }) => {
    const from = status === 206 ? Number(/bytes=(\d+)-/.exec(init.headers.Range ?? '')?.[1] ?? 0) : 0
    const rest = file.subarray(from)
    const sent = rest.subarray(0, n)
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (pulls++ === 0) return c.enqueue(new Uint8Array(sent))
        await untilPartHolds(() => part, from + sent.length) // the drop comes after the bytes are on disk
        c.error(new Error('ECONNRESET'))
      },
    })
    const range: Record<string, string> = status === 206 ? { 'content-range': `bytes ${from}-${file.length - 1}/${file.length}` } : {}
    return new Response(body, { status, headers: { 'content-length': String(rest.length), ...range } })
  }) as unknown as typeof fetch
}

test('resume: a reply with no validator keeps the stored one on a 206 and drops it on a 200', async () => {
  // A 206 continues the bytes the stored validator names, so the next resume must still send
  // it. A 200 replaces the .part with a version nothing names: keeping the old validator would
  // vouch for bytes it never described.
  const ranged = await interruptedRawDownload(OLD_FILE, 60, '"strong1"')
  const partial = await resumeAfterRestart(
    ranged.stateDir, ranged.modelDir, ranged.id, noValidatorThenDrops(OLD_FILE, 206, 20, `${ranged.dest}.part`),
  )
  assert.equal(partial.status, 'error')
  assert.equal(readFileSync(`${ranged.dest}.part`).length, 80, 'the 206 continued the .part')
  assert.deepEqual(manifestEntries(ranged.stateDir).map((e) => e.validator), ['"strong1"'])

  const whole = await interruptedRawDownload(OLD_FILE, 60, '"strong1"')
  const restarted = await resumeAfterRestart(
    whole.stateDir, whole.modelDir, whole.id, noValidatorThenDrops(OLD_FILE, 200, 20, `${whole.dest}.part`),
  )
  assert.equal(restarted.status, 'error')
  assert.equal(readFileSync(`${whole.dest}.part`).length, 20, 'the 200 started the .part again')
  assert.deepEqual(manifestEntries(whole.stateDir).map((e) => e.validator), [undefined])
})

/** The URL imported again (a new row, not Resume) while the first attempt's row is still errored
 *  with its prefix in the .part, against `fetchImpl`: the new row as it settles. */
async function importAgain(dm: DownloadManager, url: string, fetchImpl: typeof fetch) {
  const real = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const [rec] = await dm.enqueue({ url })
    assert.ok(rec, 'an errored row does not block a new import of the same file')
    return await waitSettled(dm, rec.id)
  } finally {
    globalThis.fetch = real
  }
}

test('a new import over an errored row\'s .part resumes only under that row\'s validator: a changed file comes whole, not spliced', async () => {
  // The first attempt dropped at 60 bytes of the old file; the file then changed upstream and
  // the user imported the URL again instead of pressing Resume. The new row had no validator,
  // so its bare Range got the new file's tail as a 206 and the old prefix + new tail was done.
  const changed = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen: Array<Record<string, string>> = []
  const rec = await importAgain(changed.dm, 'https://mirror.example/model.gguf', serve(NEW_FILE, '"new"', seen))
  assert.equal(seen[0]['If-Range'], '"old"', 'the errored row\'s validator goes with the .part')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(changed.dest), NEW_FILE, 'the library gets the new file, not old prefix + new tail')

  // A server that ignores If-Range is refused as on Resume, not spliced.
  const ignored = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const refused = await importAgain(ignored.dm, 'https://mirror.example/model.gguf', serve(NEW_FILE, '"new"', [], { ignoreIfRange: true }))
  assert.equal(refused.status, 'error')
  assert.match(refused.error ?? '', /changed on the server/)
  assert.equal(existsSync(ignored.dest), false, 'the spliced file never reaches the library')
})

test('a new import over an errored row\'s .part still resumes the same file from the .part offset', async () => {
  const { dm, dest } = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen: Array<Record<string, string>> = []
  const rec = await importAgain(dm, 'https://mirror.example/model.gguf', serve(OLD_FILE, '"old"', seen, { ignoreIfRange: true }))
  assert.equal(seen[0].Range, 'bytes=60-')
  assert.equal(seen[0]['If-Range'], '"old"')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.equal(seen.length, 1, 'resumed from the .part, not restarted')
  assert.deepEqual(readFileSync(dest), OLD_FILE)
})

test('a new import with no validator of the same URL for the .part starts from byte 0', async () => {
  // The first attempt's server sent no ETag or Last-Modified: nothing tells which version the
  // .part holds, so the new row must not resume it. A server that answers any Range with a 206
  // of the current file then spliced it onto the old prefix.
  const bare = await interruptedRawDownload(OLD_FILE, 60, {})
  const seen: Array<Record<string, string>> = []
  const rec = await importAgain(bare.dm, 'https://mirror.example/model.gguf', serve(NEW_FILE, '"new"', seen, { ignoreIfRange: true }))
  assert.equal(seen[0].Range, undefined, 'the whole file, not the rest of the .part')
  assert.equal(rec.status, 'done', rec.error ?? '')
  assert.deepEqual(readFileSync(bare.dest), NEW_FILE)

  // The .part came from another URL (a second mirror's file of the same name): that row's
  // validator says nothing about this URL's file.
  const other = await interruptedRawDownload(OLD_FILE, 60, '"old"')
  const seen2: Array<Record<string, string>> = []
  const fromOther = await importAgain(other.dm, 'https://other.example/model.gguf', serve(NEW_FILE, '"old"', seen2, { ignoreIfRange: true }))
  assert.equal(seen2[0].Range, undefined)
  assert.equal(fromOther.status, 'done', fromOther.error ?? '')
  assert.deepEqual(readFileSync(other.dest), NEW_FILE)
})

test('a finished download carries finishedAt, already set when the rescan is requested', async () => {
  // The web's models poll stops waiting for a row once the list's lastScanAt is later than this
  // (models-poll.ts), so it must exist before onComplete() asks for that scan.
  const { modelDir, stateDir } = newDirs()
  const real = globalThis.fetch
  globalThis.fetch = serve(OLD_FILE, '"old"', [])
  try {
    let atRescan: string | undefined
    const dm: DownloadManager = new DownloadManager(fakeStore(modelDir, stateDir), () => { atRescan = dm.list()[0].finishedAt }, () => ({}))
    const [rec] = await dm.enqueue({ url: 'https://mirror.example/model.gguf' })
    const done = await waitSettled(dm, rec.id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.ok(atRescan && !Number.isNaN(Date.parse(atRescan)), 'finishedAt is an ISO time set before onComplete')
    assert.equal(done.finishedAt, atRescan)
  } finally {
    globalThis.fetch = real
  }
})
