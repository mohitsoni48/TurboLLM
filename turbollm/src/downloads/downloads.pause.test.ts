// Pause (POST /api/v1/downloads/:id/pause): a download stopped on purpose keeps its .part and its
// validator, stays paused across a daemon restart, and Resume continues it with Range + If-Range.
// Against real local node:http servers through the client run() streams with (http-get.ts), as a
// pause has to end a real socket mid-body and leave the bytes already written on disk. Until Pause
// existed, Cancel (which deletes the .part) was the only way to stop a download.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DownloadManager, setDownloadGetForTests, type DownloadRecord } from './downloads'
import { httpGet } from './http-get'
import { registerApi } from '../api/routes'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

setDownloadGetForTests(httpGet)

function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

function newDirs() {
  const root = tmpDir('tllm-dl-pause-')
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(join(stateDir, 'downloads'), { recursive: true })
  return { modelDir, stateDir }
}

/** Deterministic bytes, so a splice or a short file shows in the comparison. */
function file(size: number): Buffer {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + (i >> 9)) & 0xff
  return b
}

const FULL = file(400_000)
const SHA = createHash('sha256').update(FULL).digest('hex')
const ETAG = '"v1"'

/** A server holding FULL under ETAG that implements Range and If-Range. The requests `stall`
 *  picks (by number, from 1; the first one by default) get 64 KiB of what they ask for and then
 *  nothing more until the client goes away (the download is running when the test pauses it);
 *  the others get the rest at once, a Range request as a 206. `seen` records each request's Range and If-Range; `state.open` counts the
 *  responses still open, `state.maxOpen` the most ever open at once. */
async function serveFile(stall: (n: number) => boolean = (n) => n === 1) {
  const seen: Array<{ range?: string; ifRange?: string }> = []
  const state = { open: 0, maxOpen: 0 }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined })
    state.open++
    state.maxOpen = Math.max(state.maxOpen, state.open)
    res.on('close', () => { state.open-- })
    const from = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
    const ranged = from > 0 && req.headers['if-range'] === ETAG
    if (ranged) {
      res.writeHead(206, { 'Content-Length': FULL.length - from, 'Content-Range': `bytes ${from}-${FULL.length - 1}/${FULL.length}`, ETag: ETAG })
    } else {
      res.writeHead(200, { 'Content-Length': FULL.length, ETag: ETAG })
    }
    const start = ranged ? from : 0
    if (!stall(seen.length)) return res.end(FULL.subarray(start))
    res.write(FULL.subarray(start, start + 65_536)) // and then nothing: the pause has to end it
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.gguf`,
    seen,
    state,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = probe()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const row = (dm: DownloadManager, id: string) => dm.list().find((r) => r.id === id)!

function settled(dm: DownloadManager, id: string): Promise<DownloadRecord> {
  return waitFor('the download to settle', () => {
    const r = row(dm, id)
    return ['done', 'error', 'cancelled'].includes(r.status) ? r : undefined
  })
}

/** Enqueue FULL from `srv` (with its sha256), wait for the first bytes to reach the .part, pause. */
async function pausedMidBody(srv: Awaited<ReturnType<typeof serveFile>>) {
  const { modelDir, stateDir } = newDirs()
  const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  const outcomes: string[] = []
  dm.onSettled = (o) => outcomes.push(o)
  const [rec] = await dm.enqueue({ url: srv.url, sha256: SHA })
  const part = `${rec.dest}.part`
  await waitFor('the first bytes on disk', () => (statSync(part, { throwIfNoEntry: false })?.size === 65_536 ? true : undefined))
  assert.equal(dm.pause(rec.id), true)
  assert.equal(row(dm, rec.id).status, 'paused')
  await waitFor('the paused request to close', () => (srv.state.open === 0 ? true : undefined))
  return { dm, rec, part, modelDir, stateDir, outcomes }
}

test('a paused download keeps its .part and its bytes, and Resume continues it with a 206 to the same sha256', async () => {
  const srv = await serveFile()
  try {
    const { dm, rec, part, outcomes } = await pausedMidBody(srv)
    // Let the aborted run end: it must neither cancel the row nor delete its bytes.
    await new Promise((r) => setTimeout(r, 50))
    const paused = row(dm, rec.id)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.error, null)
    assert.equal(paused.bytesPerSec, 0)
    assert.equal(existsSync(part), true, 'Pause keeps the partial file')
    assert.equal(statSync(part).size, 65_536)
    assert.equal(paused.received, 65_536, 'the row shows what the .part holds')
    assert.deepEqual(readFileSync(part), FULL.subarray(0, 65_536))
    assert.deepEqual(outcomes, [], 'a pause is not an outcome: no model_downloaded event')

    assert.equal(dm.resume(rec.id), true)
    const done = await settled(dm, rec.id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.deepEqual(srv.seen.at(-1), { range: 'bytes=65536-', ifRange: ETAG }, 'Resume asks only for the rest of the same file')
    assert.equal(createHash('sha256').update(readFileSync(rec.dest)).digest('hex'), SHA)
    assert.deepEqual(outcomes, ['ok'])
  } finally {
    await srv.close()
  }
})

test('a paused download stays paused across a daemon restart and resumes from its .part', async () => {
  const srv = await serveFile()
  try {
    const { rec, modelDir, stateDir } = await pausedMidBody(srv)
    await new Promise((r) => setTimeout(r, 50))
    // The daemon restarts: a second manager over the same state dir, as cli.ts builds it.
    const after = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const back = row(after, rec.id)
    assert.equal(back.status, 'paused')
    assert.equal(back.received, 65_536)
    assert.equal(after.resume(rec.id), true)
    const done = await settled(after, rec.id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.deepEqual(srv.seen.at(-1), { range: 'bytes=65536-', ifRange: ETAG }, 'the validator survived the restart')
    assert.deepEqual(readFileSync(rec.dest), FULL)
  } finally {
    await srv.close()
  }
})

test('a queued download pauses without starting, and stays paused when a slot frees', async () => {
  const srv = await serveFile(() => true)
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const rows: DownloadRecord[] = []
    for (const n of ['a', 'b', 'c']) rows.push(...(await dm.enqueue({ url: srv.url.replace('model', n) })))
    await waitFor('two requests', () => (srv.seen.length === 2 ? true : undefined))
    assert.equal(row(dm, rows[2].id).status, 'queued', 'two at a time: the third waits')
    assert.equal(dm.pause(rows[2].id), true)
    assert.equal(row(dm, rows[2].id).status, 'paused')
    assert.equal(dm.cancel(rows[0].id), true) // a slot frees
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(row(dm, rows[2].id).status, 'paused')
    assert.equal(srv.seen.length, 2, 'the paused row never sent a request')
    assert.equal(existsSync(`${rows[2].dest}.part`), false)
  } finally {
    await srv.close()
  }
})

test('POST /pause answers ok for a running download, and the resume error shape for one that is done or unknown', async () => {
  const srv = await serveFile((n) => n !== 2)
  try {
    const { dm, rec } = await pausedMidBody(srv)
    const app = new Hono()
    registerApi(app, { downloads: dm } as unknown as Deps)
    const post = (id: string, verb: string) => app.request(`/api/v1/downloads/${id}/${verb}`, { method: 'POST', body: '{}' })

    // Already paused: nothing to pause.
    const again = await post(rec.id, 'pause')
    assert.equal(again.status, 404)
    assert.deepEqual(await again.json(), { error: { code: 'no_such_download', message: 'No downloading or queued download with that id.' } })

    assert.equal((await post(rec.id, 'resume')).status, 200)
    await settled(dm, rec.id)
    assert.equal(row(dm, rec.id).status, 'done')
    const done = await post(rec.id, 'pause')
    assert.equal(done.status, 404, 'a finished download cannot be paused')
    assert.equal(((await done.json()) as { error: { code: string } }).error.code, 'no_such_download')
    assert.equal((await post('no-such-id', 'pause')).status, 404)

    // And through the route, a running one pauses.
    const [next] = await dm.enqueue({ url: srv.url.replace('model', 'next') })
    await waitFor('the first bytes', () => (row(dm, next.id).received > 0 ? true : undefined))
    const ok = await post(next.id, 'pause')
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { ok: true })
    assert.equal(row(dm, next.id).status, 'paused')
  } finally {
    await srv.close()
  }
})

test('Pause and Resume from two clients at once leave one writer, and the file is whole', async () => {
  const srv = await serveFile((n) => n <= 4)
  try {
    const { dm, rec } = await pausedMidBody(srv)
    assert.equal(dm.resume(rec.id), true)
    const app = new Hono()
    registerApi(app, { downloads: dm } as unknown as Deps)
    const post = (verb: string) => app.request(`/api/v1/downloads/${rec.id}/${verb}`, { method: 'POST', body: '{}' })
    // Each Resume lands while the run the Pause before it stopped is still closing the .part.
    for (let i = 0; i < 3; i++) {
      await waitFor('the resumed request', () => (srv.seen.length === 2 + i && row(dm, rec.id).status === 'downloading' ? true : undefined))
      const [pause, resumeA, resumeB] = await Promise.all([post('pause'), post('resume'), post('resume')])
      assert.equal(pause.status, 200)
      assert.deepEqual([resumeA.status, resumeB.status].sort(), [200, 404], 'one Resume is taken, the other has nothing to resume')
    }
    const done = await settled(dm, rec.id)
    assert.equal(done.status, 'done', done.error ?? '')
    assert.equal(srv.state.maxOpen, 1, 'never two requests for the file at once')
    assert.equal(createHash('sha256').update(readFileSync(rec.dest)).digest('hex'), SHA)
  } finally {
    await srv.close()
  }
})

// What the Downloads panel's words rest on: "Dismiss" (a done or cancelled row, and "Dismiss all")
// only forgets the row, while "Discard" (a paused or errored row) deletes its partial file too.
test('DELETE of a done row keeps the model file; of a paused row it deletes the partial', async () => {
  const srv = await serveFile((n) => n === 1 || n === 3)
  try {
    const { dm, rec, part } = await pausedMidBody(srv)
    const app = new Hono()
    registerApi(app, { downloads: dm } as unknown as Deps)
    const del = (id: string) => app.request(`/api/v1/downloads/${id}`, { method: 'DELETE' })

    assert.equal(dm.resume(rec.id), true)
    assert.equal((await settled(dm, rec.id)).status, 'done')
    assert.equal((await del(rec.id)).status, 200)
    assert.deepEqual(readFileSync(rec.dest), FULL, 'Dismiss leaves the finished model in the library')
    assert.equal(dm.list().some((r) => r.id === rec.id), false)

    const [other] = await dm.enqueue({ url: srv.url.replace('model', 'other') })
    await waitFor('the first bytes', () => (statSync(`${other.dest}.part`, { throwIfNoEntry: false })?.size === 65_536 ? true : undefined))
    assert.equal(dm.pause(other.id), true)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal((await del(other.id)).status, 200)
    assert.equal(existsSync(`${other.dest}.part`), false, 'Discard deletes the partial')
    assert.equal(dm.list().some((r) => r.id === other.id), false)
    assert.equal(existsSync(part), false)
  } finally {
    await srv.close()
  }
})
