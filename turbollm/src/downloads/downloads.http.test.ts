// DownloadManager against real local node:http servers, through the client run() streams model
// files with (http-get.ts), not a fetch double: a server that closes the connection after the
// body (which crashed the daemon through undici), redirects that change origin, a resume through
// a redirect, a cancel mid-body and a server that stops sending.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DownloadManager, setDownloadGetForTests, type DownloadRecord } from './downloads'
import type { HfModelFiles } from '../hf/hf'
import { httpGet } from './http-get'
import { ggufFile, ggufVocabOnly } from '../test-support/gguf-file'
import { tmpDir } from '../test-support/tmp'

function fakeStore(modelDir: string, stateDir: string) {
  return {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
}

function newDirs() {
  const root = tmpDir('tllm-dl-http-')
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  mkdirSync(join(stateDir, 'downloads'), { recursive: true })
  return { root, modelDir, stateDir }
}

/** A real HTTP server on a free loopback port. close() also drops connections still open. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
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

function settled(dm: DownloadManager, id: string): Promise<DownloadRecord> {
  return waitFor('the download to settle', () => {
    const r = dm.list().find((x) => x.id === id)
    return r && ['done', 'error', 'cancelled'].includes(r.status) ? r : undefined
  })
}

/** Deterministic bytes, so a splice or a short file shows in the comparison. */
function file(size: number): Buffer {
  const b = Buffer.alloc(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + (i >> 9)) & 0xff
  return b
}

// Runs in a child process, as the daemon does: the daemon's own dispatcher (server.ts's undici
// Agent) is the global one, the .part's writes are slow (2 ms each, a phone's SD card or a busy
// disk behind a LAN), and a server that closes the connection after the body (`Connection:
// close`, as `python3 -m http.server` answers) serves the file. Through the global fetch, undici
// paused its parser for the slow reader and asserted `!this.paused` when that socket ended: an
// uncaught AssertionError that killed the process on the first import.
const CRASH_PROBE = `
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import undici from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('undici')).href)}
import { DownloadManager } from ${JSON.stringify(new URL('./downloads.ts', import.meta.url).href)}

undici.setGlobalDispatcher(new undici.Agent({ keepAliveMaxTimeout: 60_000, connections: 10 }))
const write = fs.write, writev = fs.writev
fs.write = (...a) => { const cb = a.pop(); setTimeout(() => write(...a, cb), 2) }
fs.writev = (...a) => { const cb = a.pop(); setTimeout(() => writev(...a, cb), 2) }

const body = Buffer.alloc(4 * 1024 * 1024)
for (let i = 0; i < body.length; i++) body[i] = (i * 7 + (i >> 12)) & 0xff
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Length': body.length, Connection: 'close' })
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { modelDir, stateDir } = JSON.parse(process.env.PROBE_DIRS)
const store = { dir: () => stateDir, snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }) }
const dm = new DownloadManager(store, () => {}, () => ({}))
const results = []
for (let i = 0; i < 3; i++) {
  const outcome = new Promise((r) => { dm.onSettled = r })
  const [rec] = await dm.enqueue({ url: 'http://127.0.0.1:' + server.address().port + '/model-' + i + '.gguf' })
  await outcome
  const row = dm.list().find((x) => x.id === rec.id)
  const sha = fs.existsSync(row.dest) ? createHash('sha256').update(fs.readFileSync(row.dest)).digest('hex') : null
  results.push({ status: row.status, error: row.error, sha })
}
fs.writeFileSync(process.env.PROBE_REPORT, JSON.stringify({ expected: createHash('sha256').update(body).digest('hex'), results }))
server.close()
`

test('a server that closes the connection after the body, read by a slow disk, completes every import and does not crash the daemon', () => {
  const { root, modelDir, stateDir } = newDirs()
  const script = join(root, 'crash-probe.mjs')
  const report = join(root, 'report.json')
  writeFileSync(script, CRASH_PROBE)
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, PROBE_DIRS: JSON.stringify({ modelDir, stateDir }), PROBE_REPORT: report },
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(result.status, 0, `the probe process died (signal ${result.signal}):\n${result.stderr.slice(-2000)}`)
  const { expected, results } = JSON.parse(readFileSync(report, 'utf8')) as {
    expected: string
    results: Array<{ status: string; error: string | null; sha: string | null }>
  }
  assert.deepEqual(results, Array.from({ length: 3 }, () => ({ status: 'done', error: null, sha: expected })))
})

test('a relative redirect and then one to another origin deliver the file, and the HF token never leaves the HF origin', async () => {
  const full = file(300_000)
  const seen: Array<{ host: string; path: string; authorization?: string; acceptEncoding?: string }> = []
  const cdn = await serve((req, res) => {
    seen.push({ host: 'cdn', path: req.url!, authorization: req.headers.authorization, acceptEncoding: req.headers['accept-encoding'] })
    res.writeHead(200, { 'Content-Length': full.length, ETag: '"x1"' })
    res.end(full)
  })
  // Hugging Face answers a renamed repo with a relative 307 to the new name, then a 302 to its CDN.
  const hf = await serve((req, res) => {
    seen.push({ host: 'hf', path: req.url!, authorization: req.headers.authorization })
    if (req.url === '/owner/old-name/resolve/main/m.gguf') res.writeHead(307, { Location: '/owner/new-name/resolve/main/m.gguf' })
    else res.writeHead(302, { Location: `${cdn.origin}/xet/m.gguf?X-Amz-Signature=abc` })
    res.end()
  })
  const before = process.env.TURBOLLM_HF_BASE
  process.env.TURBOLLM_HF_BASE = hf.origin
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({ Authorization: 'Bearer hf_secret' }))
    const [rec] = await dm.enqueue({ url: `${hf.origin}/owner/old-name/resolve/main/m.gguf` })
    const row = await settled(dm, rec.id)
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(readFileSync(row.dest), full)
    assert.deepEqual(seen, [
      { host: 'hf', path: '/owner/old-name/resolve/main/m.gguf', authorization: 'Bearer hf_secret' },
      { host: 'hf', path: '/owner/new-name/resolve/main/m.gguf', authorization: 'Bearer hf_secret' },
      { host: 'cdn', path: '/xet/m.gguf?X-Amz-Signature=abc', authorization: undefined, acceptEncoding: 'identity' },
    ])
  } finally {
    if (before === undefined) delete process.env.TURBOLLM_HF_BASE
    else process.env.TURBOLLM_HF_BASE = before
    await hf.close()
    await cdn.close()
  }
})

test('a resume keeps Range and If-Range through a redirect and finishes from the 206', async () => {
  const full = file(200_000)
  const prefix = 70_000
  const seen: Array<{ host: string; range?: string; ifRange?: string; status: number }> = []
  const store = await serve((req, res) => {
    const ok = req.headers.range === `bytes=${prefix}-` && req.headers['if-range'] === '"v1"'
    seen.push({ host: 'store', range: req.headers.range, ifRange: req.headers['if-range'] as string, status: ok ? 206 : 200 })
    if (!ok) {
      res.writeHead(200, { 'Content-Length': full.length, ETag: '"v1"' })
      return res.end(full)
    }
    res.writeHead(206, { 'Content-Length': full.length - prefix, 'Content-Range': `bytes ${prefix}-${full.length - 1}/${full.length}`, ETag: '"v1"' })
    res.end(full.subarray(prefix))
  })
  const mirror = await serve((req, res) => {
    seen.push({ host: 'mirror', range: req.headers.range, ifRange: req.headers['if-range'] as string, status: 302 })
    res.writeHead(302, { Location: `${store.origin}/files/m.gguf` })
    res.end()
  })
  try {
    const { modelDir, stateDir } = newDirs()
    const dest = join(modelDir, 'm.gguf')
    writeFileSync(`${dest}.part`, full.subarray(0, prefix))
    writeFileSync(
      join(stateDir, 'downloads', 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: [{ id: 'dl-redirected', name: 'm.gguf', repo: '', url: `${mirror.origin}/m.gguf`, dest, total: full.length, validator: '"v1"', createdAt: new Date().toISOString() }],
      }),
    )
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    assert.equal(dm.resume('dl-redirected'), true)
    const row = await settled(dm, 'dl-redirected')
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(readFileSync(dest), full)
    assert.deepEqual(seen, [
      { host: 'mirror', range: `bytes=${prefix}-`, ifRange: '"v1"', status: 302 },
      { host: 'store', range: `bytes=${prefix}-`, ifRange: '"v1"', status: 206 },
    ])
  } finally {
    await mirror.close()
    await store.close()
  }
})

test('a cancel mid-body ends the row as cancelled and closes the connection', async () => {
  let connectionClosed = false
  const server = await serve((req, res) => {
    res.writeHead(200, { 'Content-Length': 10_000_000 })
    res.write(file(65_536)) // then nothing more: the cancel has to end it
    req.socket.on('close', () => { connectionClosed = true })
  })
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const outcomes: string[] = []
    dm.onSettled = (o) => outcomes.push(o)
    const [rec] = await dm.enqueue({ url: `${server.origin}/big.gguf` })
    await waitFor('the first bytes', () => (dm.list()[0].received >= 65_536 ? true : undefined))
    assert.equal(dm.cancel(rec.id), true)
    await waitFor('run() to settle', () => (outcomes.length > 0 ? true : undefined))
    await waitFor('the connection to close', () => (connectionClosed ? true : undefined))
    assert.deepEqual(outcomes, ['cancelled'])
    assert.equal(dm.list()[0].status, 'cancelled')
    assert.equal(existsSync(`${rec.dest}.part`), false)
  } finally {
    await server.close()
  }
})

test('a server that stops sending, mid-body or before its headers, ends the row as an error after the stall time', { timeout: 20_000 }, async () => {
  setDownloadGetForTests((url, init) => httpGet(url, { ...init, stallTimeout: 300 }))
  const server = await serve((req, res) => {
    if (req.url === '/no-answer.gguf') return // never answers
    res.writeHead(200, { 'Content-Length': 1_000_000 })
    res.write(file(1000)) // and then nothing
  })
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const [midBody] = await dm.enqueue({ url: `${server.origin}/mid-body.gguf` })
    const [noAnswer] = await dm.enqueue({ url: `${server.origin}/no-answer.gguf` })
    const host = server.origin.slice('http://'.length)
    const a = await settled(dm, midBody.id)
    assert.equal(a.status, 'error')
    assert.equal(a.error, `The download stalled: ${host} sent nothing for 0.3 s.`)
    const b = await settled(dm, noAnswer.id)
    assert.equal(b.status, 'error')
    assert.equal(b.error, `${host} did not answer within 0.3 s.`)
  } finally {
    setDownloadGetForTests(httpGet)
    await server.close()
  }
})

/** A test server's cut of one reply's connection mid-body. */
interface Drop {
  /** Destroy the connection after this many body bytes of the next reply (once), as soon as the
   *  client's .part at `part` holds them. */
  dropAfter?: number
  /** That .part, set by the test when enqueue returns (its request may have arrived already). */
  part?: string
}

/** Destroys `req`'s connection once the .part `drop.part` names holds `bytes` bytes, all the reply
 *  sent of its body: the attempt then fails with exactly that prefix on disk, and the Resume after
 *  it asks for the rest. Not a fixed delay after the write: on a loaded machine (the daemon's test
 *  files run in parallel) the client may not have written what it got by then, and a .part left
 *  empty makes the Resume send no Range, which fails the assertions on its exact request. */
function dropOnceWritten(req: IncomingMessage, drop: Drop, bytes: number): void {
  const written = () =>
    drop.part !== undefined && statSync(drop.part, { throwIfNoEntry: false })?.size === bytes ? true : undefined
  // After a timeout the connection is cut all the same, and the test's own assertions fail.
  const cut = () => req.socket.destroy()
  waitFor('the client to write the prefix to its .part', written).then(cut, cut)
}

/** What {@link fileServer} holds and how it answers; changed between requests by the tests. */
interface FileState extends Drop {
  body: Buffer
  /** Sent as is (`"v1"`, `W/"v1"`), or not at all. */
  etag?: string
  lastModified?: string
  /** Answer a ranged request with a 206 of the current file whatever its If-Range says. */
  ignoreIfRange?: boolean
  /** Leave the ETag off a 206 (it still has Last-Modified when the file has one). */
  etagOn206?: boolean
}

/** A real static-file server for one file at a time: Range honoured, If-Range compared with the
 *  current ETag or Last-Modified (a stale one gets the whole file as a 200), as Express and nginx
 *  answer. `seen` records each request's Range and If-Range with the status it got. */
async function fileServer(state: FileState) {
  const seen: Array<{ range?: string; ifRange?: string; status: number }> = []
  const server = await serve((req, res) => {
    const { body, etag, lastModified } = state
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const ifRange = req.headers['if-range'] as string | undefined
    const ranged = !!range && (state.ignoreIfRange || !ifRange || ifRange === etag || ifRange === lastModified)
    const from = ranged ? Number(range![1]) : 0
    const status = ranged ? 206 : 200
    seen.push({ range: req.headers.range, ifRange, status })
    const headers: Record<string, string | number> = { 'Content-Length': body.length - from }
    if (etag && (status === 200 || state.etagOn206 !== false)) headers.ETag = etag
    if (lastModified) headers['Last-Modified'] = lastModified
    if (ranged) headers['Content-Range'] = `bytes ${from}-${body.length - 1}/${body.length}`
    res.writeHead(status, headers)
    const drop = state.dropAfter
    state.dropAfter = undefined
    if (drop === undefined) return res.end(body.subarray(from))
    res.write(body.subarray(from, from + drop))
    dropOnceWritten(req, state, from + drop)
  })
  return { ...server, seen }
}

/** A raw-URL import whose first attempt got `prefix` bytes of `state`'s file and then lost the
 *  connection, followed by a daemon restart (a second DownloadManager over the same state, which
 *  restores the row from the manifest as paused): returns the restored manager and the row. */
async function interruptedThenRestarted(state: FileState, origin: string, prefix: number) {
  const { modelDir, stateDir } = newDirs()
  state.dropAfter = prefix
  const first = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  const [rec] = await first.enqueue({ url: `${origin}/model.gguf` })
  state.part = `${rec.dest}.part`
  const failed = await settled(first, rec.id)
  assert.equal(failed.status, 'error', 'the first attempt lost its connection')
  assert.equal(statSync(`${rec.dest}.part`).size, prefix, 'and left its .part with the prefix')
  const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  assert.equal(dm.list()[0].status, 'paused')
  return { dm, id: rec.id, dest: rec.dest, stateDir }
}

const LM_A = 'Tue, 01 Sep 2026 10:00:00 GMT'
const LM_B = 'Wed, 02 Sep 2026 11:00:00 GMT'

test('resume: a same-length file replaced on a server that sends a weak ETag and a date is refused, not spliced', async () => {
  // Express and serve-static send W/"<size>-<mtime>" and Last-Modified. A weak ETag may not go in
  // If-Range, so the resume sends a bare Range, and the 206 of the new file was appended to the old
  // prefix: same length, so the size check passed and the corrupt file was marked done.
  const A = file(300_000)
  const B = Buffer.from(A.map((x) => x ^ 0x5a))
  const state: FileState = { body: A, etag: 'W/"493e0-a"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { dm, id, dest } = await interruptedThenRestarted(state, server.origin, 100_000)
    Object.assign(state, { body: B, etag: 'W/"493e0-b"', lastModified: LM_B })
    assert.equal(dm.resume(id), true)
    const row = await settled(dm, id)
    assert.equal(server.seen.at(-1)?.ifRange, undefined, 'no If-Range: the ETag is weak')
    assert.equal(server.seen.at(-1)?.status, 206)
    assert.equal(row.status, 'error', 'not done with the old prefix and the new tail')
    assert.match(row.error ?? '', /does not continue the partial file/)
    assert.equal(existsSync(dest), false, 'the spliced file never reaches the library')
    assert.equal(existsSync(`${dest}.part`), false, 'the next Resume starts the new file from byte 0')
  } finally {
    await server.close()
  }
})

test('resume: a 206 that carries only a Last-Modified, another than the first reply named, is refused', async () => {
  // The first reply had a strong ETag and a date; the server ignores If-Range and answers the
  // resume with a 206 of the changed file that carries only its date. The If-Range validator (the
  // ETag) has nothing to compare with, so this was spliced and marked done.
  const A = file(300_000)
  const B = Buffer.from(A.map((x) => x ^ 0x5a))
  const state: FileState = { body: A, etag: '"a1"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { dm, id, dest } = await interruptedThenRestarted(state, server.origin, 100_000)
    Object.assign(state, { body: B, etag: '"b1"', lastModified: LM_B, ignoreIfRange: true, etagOn206: false })
    assert.equal(dm.resume(id), true)
    const row = await settled(dm, id)
    assert.equal(server.seen.at(-1)?.ifRange, '"a1"')
    assert.equal(server.seen.at(-1)?.status, 206)
    assert.equal(row.status, 'error', 'not done with the old prefix and the new tail')
    assert.match(row.error ?? '', /does not continue the partial file/)
    assert.equal(existsSync(dest), false)
  } finally {
    await server.close()
  }
})

/** A raw-URL import of `state`'s file (with `sha256` when given) whose first attempt got `prefix`
 *  bytes and then lost the connection, with no restart, so the row stays errored and a new import
 *  of the URL is let through to take over its .part: the manager and that row. */
async function interruptedImport(state: FileState, origin: string, prefix: number, sha256?: string) {
  const { modelDir, stateDir } = newDirs()
  state.dropAfter = prefix
  const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  const [rec] = await dm.enqueue({ url: `${origin}/model.gguf`, sha256 })
  state.part = `${rec.dest}.part`
  const failed = await settled(dm, rec.id)
  assert.equal(failed.status, 'error', 'the first attempt lost its connection')
  assert.equal(statSync(`${rec.dest}.part`).size, prefix, 'and left its .part with the prefix')
  return { dm, rec }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

test('a new import over an errored row\'s .part refuses a 206 that carries only another Last-Modified', async () => {
  // As on Resume above, but the user imported the URL again: the new row took over the errored
  // row's validator (its ETag) and not its date, so the 206 of the changed file said nothing to
  // it and was spliced.
  const A = file(300_000)
  const B = Buffer.from(A.map((x) => x ^ 0x5a))
  const state: FileState = { body: A, etag: '"a1"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { dm, rec } = await interruptedImport(state, server.origin, 100_000)
    Object.assign(state, { body: B, etag: '"b1"', lastModified: LM_B, ignoreIfRange: true, etagOn206: false })
    const [again] = await dm.enqueue({ url: `${server.origin}/model.gguf` })
    const row = await settled(dm, again.id)
    assert.deepEqual(server.seen.at(-1), { range: 'bytes=100000-', ifRange: '"a1"', status: 206 }, 'it took over the .part')
    assert.equal(row.status, 'error', 'not done with the old prefix and the new tail')
    assert.match(row.error ?? '', /does not continue the partial file/)
    assert.equal(existsSync(rec.dest), false, 'the spliced file never reaches the library')
  } finally {
    await server.close()
  }
})

test('a new import with another sha256 than the errored row\'s does not take over its .part', async () => {
  // The .part holds the file the errored row's hash names, and the new row asks for another one.
  // Taken over, its If-Range of the old ETag got a 206 of the new file from a server that ignores
  // it, which was refused as "does not continue", and only the Resume after that downloaded it.
  const A = file(300_000)
  const B = Buffer.from(A.map((x) => x ^ 0x5a))
  const state: FileState = { body: A, etag: '"a1"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { dm, rec } = await interruptedImport(state, server.origin, 100_000, sha256(A))
    Object.assign(state, { body: B, etag: '"b1"', lastModified: LM_B, ignoreIfRange: true })
    const [again] = await dm.enqueue({ url: `${server.origin}/model.gguf`, sha256: sha256(B) })
    const row = await settled(dm, again.id)
    assert.deepEqual(server.seen.at(-1), { range: undefined, ifRange: undefined, status: 200 }, 'the whole file, not the rest of the .part')
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(readFileSync(rec.dest), B)
  } finally {
    await server.close()
  }
})

test('resume: the same file under the same weak ETag and date still resumes from the .part', async () => {
  const A = file(300_000)
  const state: FileState = { body: A, etag: 'W/"493e0-a"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { dm, id, dest, stateDir } = await interruptedThenRestarted(state, server.origin, 100_000)
    const manifest = JSON.parse(readFileSync(join(stateDir, 'downloads', 'manifest.json'), 'utf8')) as {
      entries: Array<{ validator?: string; fileVersion?: unknown }>
    }
    assert.deepEqual(
      manifest.entries.map((e) => [e.validator, e.fileVersion]),
      [[undefined, { etag: 'W/"493e0-a"', lastModified: LM_A }]],
      'the first reply\'s ETag and date are in the manifest, not only a strong validator',
    )
    assert.equal(dm.resume(id), true)
    const row = await settled(dm, id)
    assert.equal(row.status, 'done', row.error ?? '')
    assert.equal(server.seen.at(-1)?.status, 206, 'resumed, not restarted')
    assert.deepEqual(readFileSync(dest), A)
  } finally {
    await server.close()
  }
})

test('resume: a new date under the same strong ETag still resumes from the .part', async () => {
  // A strong ETag changes with every change of the bytes, so it alone says the file is the same.
  // A server that dates every reply anew (Last-Modified: now) under one strong ETag was refused
  // "does not continue" on every Resume, the date taken for a change.
  const A = file(300_000)
  const state: FileState = { body: A, etag: '"a1"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { dm, id, dest } = await interruptedThenRestarted(state, server.origin, 100_000)
    state.lastModified = LM_B
    assert.equal(dm.resume(id), true)
    const row = await settled(dm, id)
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(server.seen.at(-1), { range: 'bytes=100000-', ifRange: '"a1"', status: 206 }, 'resumed, not restarted')
    assert.deepEqual(readFileSync(dest), A)
  } finally {
    await server.close()
  }
})

test('resume: a row from a manifest written before the change detector resumes as it did', async () => {
  // An older daemon's manifest has no fileVersion: nothing to compare, so its 206 is checked as
  // before (strong validator, Content-Range) and the resume completes.
  const A = file(300_000)
  const state: FileState = { body: A, etag: 'W/"493e0-a"', lastModified: LM_A }
  const server = await fileServer(state)
  try {
    const { modelDir, stateDir } = newDirs()
    const dest = join(modelDir, 'model.gguf')
    writeFileSync(`${dest}.part`, A.subarray(0, 100_000))
    writeFileSync(
      join(stateDir, 'downloads', 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: [{ id: 'dl-old', name: 'model.gguf', repo: '', url: `${server.origin}/model.gguf`, dest, total: A.length, createdAt: new Date().toISOString() }],
      }),
    )
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    assert.equal(dm.resume('dl-old'), true)
    const row = await settled(dm, 'dl-old')
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(server.seen, [{ range: 'bytes=100000-', ifRange: undefined, status: 206 }])
    assert.deepEqual(readFileSync(dest), A)
  } finally {
    await server.close()
  }
})

/** A server that answers a plain GET as `python3 -m http.server` behind a proxy that timed out
 *  would: a 200 with no Content-Length and no chunked encoding (the body ends when the connection
 *  closes), and only the first `sent` bytes of `body` before a clean close. A ranged request gets a
 *  206 of the rest. */
async function closeDelimited(body: Buffer, sent: number) {
  const seen: string[] = []
  const server = await serve((req, res) => {
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    seen.push(req.headers.range ?? 'whole')
    if (range) {
      const from = Number(range[1])
      res.writeHead(206, { 'Content-Length': body.length - from, 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` })
      return res.end(body.subarray(from))
    }
    req.socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n')
    req.socket.end(body.subarray(0, sent))
  })
  return { ...server, seen }
}

const WEIGHTS = ggufFile([{ name: 'token_embd.weight', dims: [100_000], type: 0 }], [['general.architecture', 'llama']])

test('a GGUF of unknown length that the server cut off is not marked done, and Resume fetches the rest', async () => {
  // The early close looks like the end of the body, and with total 0 there was no size check:
  // the 150 kB of a 400 kB model were marked done and listed, and failed only at load.
  const server = await closeDelimited(WEIGHTS, 150_000)
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const [rec] = await dm.enqueue({ url: `${server.origin}/model.gguf` })
    const row = await settled(dm, rec.id)
    assert.equal(row.status, 'error', 'not done with 150000 of its bytes')
    assert.equal(row.error, 'The server closed the connection before the whole file arrived. Resume to download the rest.')
    assert.equal(existsSync(rec.dest), false, 'the cut-off file never reaches the library')
    assert.equal(readFileSync(`${rec.dest}.part`).length, 150_000, 'the good prefix is kept')

    assert.equal(dm.resume(rec.id), true)
    const resumed = await settled(dm, rec.id)
    assert.equal(resumed.status, 'done', resumed.error ?? '')
    assert.deepEqual(server.seen, ['whole', 'bytes=150000-'])
    assert.deepEqual(readFileSync(rec.dest), WEIGHTS)
  } finally {
    await server.close()
  }
})

test('a whole GGUF of unknown length is finished as before', async () => {
  const server = await closeDelimited(WEIGHTS, WEIGHTS.length)
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const [rec] = await dm.enqueue({ url: `${server.origin}/model.gguf` })
    const row = await settled(dm, rec.id)
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(readFileSync(rec.dest), WEIGHTS)
  } finally {
    await server.close()
  }
})

test('a whole vocab-only GGUF of unknown length is finished, not taken for cut short', async () => {
  // No tensors and no padding after the header, as llama.cpp's ggml-vocab-*.gguf: its padded data
  // offset lies past its end, which failed the download "closed the connection before the whole
  // file arrived" on every Resume.
  const vocab = ggufVocabOnly([['general.architecture', 'llama'], ['tokenizer.ggml.model', 'gpt2']])
  const server = await closeDelimited(vocab, vocab.length)
  try {
    const { modelDir, stateDir } = newDirs()
    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const [rec] = await dm.enqueue({ url: `${server.origin}/ggml-vocab-llama.gguf` })
    const row = await settled(dm, rec.id)
    assert.equal(row.status, 'done', row.error ?? '')
    assert.deepEqual(readFileSync(rec.dest), vocab)
  } finally {
    await server.close()
  }
})

/** A stand-in for Hugging Face holding one file of owner/repo, `m.gguf`: `/owner/repo/resolve/<rev>/m.gguf`
 *  serves the bytes `revs[rev]` names (a test moves `main` on by replacing its entry). Every reply has a strong
 *  ETag of those bytes, as the CDN's content hash is (after `etagPrefix`, which stands for the CDN's own tag
 *  changing over the same bytes). Like that CDN (checked with curl), a Range gets a 206 of the current bytes
 *  whatever If-Range says, unless `honourIfRange`. `dropAfter` cuts the next reply's connection after that many
 *  body bytes, once they are in `part` ({@link Drop}). */
async function hfStub(revs: Record<string, Buffer>, opts: { honourIfRange?: boolean; etagPrefix?: string } & Drop = {}) {
  const seen: Array<{ path: string; range?: string; ifRange?: string; status: number }> = []
  const server = await serve((req, res) => {
    const rev = /^\/owner\/repo\/resolve\/([^/]+)\/m\.gguf$/.exec(req.url ?? '')?.[1]
    const body = rev === undefined ? undefined : revs[rev]
    if (!body) {
      res.writeHead(404)
      return res.end()
    }
    const etag = `"${opts.etagPrefix ?? ''}${sha256(body).slice(0, 32)}"`
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const ifRange = req.headers['if-range'] as string | undefined
    const ranged = !!range && (!opts.honourIfRange || !ifRange || ifRange === etag)
    const from = ranged ? Number(range![1]) : 0
    seen.push({ path: req.url!, range: req.headers.range, ifRange, status: ranged ? 206 : 200 })
    res.writeHead(ranged ? 206 : 200, {
      'Content-Length': body.length - from,
      ETag: etag,
      ...(ranged ? { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}),
    })
    const drop = opts.dropAfter
    opts.dropAfter = undefined
    if (drop === undefined) return res.end(body.subarray(from))
    res.write(body.subarray(from, from + drop))
    dropOnceWritten(req, opts, from + drop)
  })
  return { ...server, seen }
}

/** Runs `fn` with run()'s HF origin pointed at `origin`. */
async function withHfBase<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.TURBOLLM_HF_BASE
  process.env.TURBOLLM_HF_BASE = origin
  try {
    return await fn()
  } finally {
    if (before === undefined) delete process.env.TURBOLLM_HF_BASE
    else process.env.TURBOLLM_HF_BASE = before
  }
}

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const OLD_GGUF = file(300_000)
const NEW_GGUF = Buffer.from(OLD_GGUF.map((x) => x ^ 0x5a))

test('a paused Hugging Face download resumes the commit it started from after the repo moved on', async () => {
  // The tree said sha256(OLD) at COMMIT_A; while the download was paused, main moved to a new
  // upload. Fetched from main, the Resume got the new file: refused, or downloaded whole and
  // failed the checksum. Fetched from the commit, it finishes the file it started.
  const revs: Record<string, Buffer> = { main: OLD_GGUF, [COMMIT_A]: OLD_GGUF }
  const drop: Drop = { dropAfter: 100_000 }
  const hf = await hfStub(revs, drop)
  try {
    await withHfBase(hf.origin, async () => {
      const { modelDir, stateDir } = newDirs()
      const expand = async (): Promise<HfModelFiles> => ({
        dir: '',
        files: [{ rfilename: 'm.gguf', size: OLD_GGUF.length, sha256: sha256(OLD_GGUF), mmproj: false }],
        commit: COMMIT_A,
      })
      const first = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
      const [rec] = await first.enqueue({ repo: 'owner/repo', rfilename: 'm.gguf' })
      drop.part = `${rec.dest}.part`
      assert.equal((await settled(first, rec.id)).status, 'error', 'the first attempt lost its connection')
      Object.assign(revs, { main: NEW_GGUF, [COMMIT_B]: NEW_GGUF })

      const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
      assert.equal(dm.resume(rec.id), true)
      const row = await settled(dm, rec.id)
      assert.equal(row.status, 'done', row.error ?? '')
      assert.equal(hf.seen.at(-1)?.path, `/owner/repo/resolve/${COMMIT_A}/m.gguf`)
      assert.equal(hf.seen.at(-1)?.status, 206, 'resumed from the .part')
      assert.deepEqual(readFileSync(rec.dest), OLD_GGUF)
    })
  } finally {
    await hf.close()
  }
})

/** A sha256 row of `m.gguf` on main (a folder file, or a download whose commit could not be read)
 *  whose first attempt got 100 kB of OLD_GGUF from the stub `opts` drives, then main moved to
 *  NEW_GGUF and the daemon restarted: the restored manager, the first one, and the row. */
async function shaRowThenMoved(revs: Record<string, Buffer>, opts: { honourIfRange?: boolean } & Drop) {
  const { modelDir, stateDir } = newDirs()
  opts.dropAfter = 100_000
  const first = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  const [rec] = await first.enqueue({ repo: 'owner/repo', rfilename: 'm.gguf', size: OLD_GGUF.length, sha256: sha256(OLD_GGUF) })
  opts.part = `${rec.dest}.part`
  assert.equal((await settled(first, rec.id)).status, 'error', 'the first attempt lost its connection')
  revs.main = NEW_GGUF
  const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
  return { dm, first, rec, modelDir, stateDir }
}

const CHANGED = 'The file changed on the server since this download started. Download it again from Discover.'

test('a sha256 row whose file changed on the server stops with a clear message, without downloading it again', async () => {
  // A server that honours If-Range answers the Resume with a 200 of the new file. Taken as a restart,
  // every Resume downloaded all of it and then failed "Checksum failed — the downloaded file was
  // corrupt.", blaming the transfer.
  const revs: Record<string, Buffer> = { main: OLD_GGUF }
  const opts = { honourIfRange: true }
  const hf = await hfStub(revs, opts)
  try {
    await withHfBase(hf.origin, async () => {
      const { dm, rec } = await shaRowThenMoved(revs, opts)
      assert.equal(dm.resume(rec.id), true)
      const row = await settled(dm, rec.id)
      assert.equal(hf.seen.at(-1)?.status, 200, 'the If-Range missed')
      assert.equal(row.status, 'error')
      assert.equal(row.error, CHANGED)
      assert.equal(row.received, 0, 'its body was not read')
      assert.equal(existsSync(`${rec.dest}.part`), false)

      // The next Resume asks for the whole file and is refused at once again.
      assert.equal(dm.resume(rec.id), true)
      const again = await settled(dm, rec.id)
      assert.equal(again.error, CHANGED)
      assert.equal(again.received, 0)
      assert.deepEqual(hf.seen.map((r) => [r.range, r.status]), [[undefined, 200], ['bytes=100000-', 200], [undefined, 200]])
      assert.equal(existsSync(rec.dest), false)
    })
  } finally {
    await hf.close()
  }
})

test('a sha256 row whose file changed on a server that ignores If-Range stops with the same message', async () => {
  // Hugging Face's CDN answers the Resume with a 206 of the new file under its own ETag: refused as
  // "does not continue the partial file ... resume to download it again", and that Resume then
  // downloaded the whole new file and failed the checksum.
  const revs: Record<string, Buffer> = { main: OLD_GGUF }
  const opts: Drop = {}
  const hf = await hfStub(revs, opts)
  try {
    await withHfBase(hf.origin, async () => {
      const { dm, rec } = await shaRowThenMoved(revs, opts)
      assert.equal(dm.resume(rec.id), true)
      const row = await settled(dm, rec.id)
      assert.equal(hf.seen.at(-1)?.status, 206)
      assert.equal(row.error, CHANGED)
      assert.equal(dm.resume(rec.id), true)
      const again = await settled(dm, rec.id)
      assert.equal(again.error, CHANGED, 'and the Resume after it is refused too, not downloaded whole')
      assert.equal(again.received, 0)
    })
  } finally {
    await hf.close()
  }
})

test('a new download of a changed file over an errored row\'s .part still finishes the new file', async () => {
  // The new row's sha256 is the new file's (a fresh listing): it does not take over the .part of
  // the old version, and its own first reply is not taken for a change.
  const revs: Record<string, Buffer> = { main: OLD_GGUF }
  const opts = { honourIfRange: true }
  const hf = await hfStub(revs, opts)
  try {
    await withHfBase(hf.origin, async () => {
      const { first, rec } = await shaRowThenMoved(revs, opts)
      const [fresh] = await first.enqueue({ repo: 'owner/repo', rfilename: 'm.gguf', size: NEW_GGUF.length, sha256: sha256(NEW_GGUF) })
      const row = await settled(first, fresh.id)
      assert.equal(hf.seen.at(-1)?.range, undefined, 'the whole new file')
      assert.equal(row.status, 'done', row.error ?? '')
      assert.deepEqual(readFileSync(rec.dest), NEW_GGUF)
    })
  } finally {
    await hf.close()
  }
})

test('a Hugging Face file downloaded again after the repo got a new commit continues the errored row\'s .part', async () => {
  // A repo row names the commit its branch was at when it was queued. After any new commit to the
  // repo (a README edit, another quant), the same file downloaded again from Discover named another
  // URL, did not take over the errored row's .part, deleted it and fetched the file from byte 0.
  // Its sha256 is the errored row's, so the bytes are the same: it continues the .part from the
  // errored row's commit, as that row's Resume would.
  const revs: Record<string, Buffer> = { main: OLD_GGUF, [COMMIT_A]: OLD_GGUF, [COMMIT_B]: OLD_GGUF }
  const drop: Drop = { dropAfter: 100_000 }
  const hf = await hfStub(revs, drop)
  try {
    await withHfBase(hf.origin, async () => {
      const { modelDir, stateDir } = newDirs()
      let commit = COMMIT_A
      const expand = async (): Promise<HfModelFiles> => ({
        dir: '',
        files: [{ rfilename: 'm.gguf', size: OLD_GGUF.length, sha256: sha256(OLD_GGUF), mmproj: false }],
        commit,
      })
      const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
      const [rec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'm.gguf' })
      drop.part = `${rec.dest}.part`
      assert.equal((await settled(dm, rec.id)).status, 'error', 'the first attempt lost its connection')
      commit = COMMIT_B

      const [again] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'm.gguf' })
      assert.equal(again.url, rec.url, 'it fetches from the errored row\'s commit')
      const row = await settled(dm, again.id)
      assert.equal(row.status, 'done', row.error ?? '')
      assert.deepEqual(
        hf.seen.map((r) => [r.path, r.range, r.status]),
        [
          [`/owner/repo/resolve/${COMMIT_A}/m.gguf`, undefined, 200],
          [`/owner/repo/resolve/${COMMIT_A}/m.gguf`, 'bytes=100000-', 206],
        ],
        'resumed from the .part',
      )
      assert.deepEqual(readFileSync(rec.dest), OLD_GGUF)
    })
  } finally {
    await hf.close()
  }
})

test('a download from a Hugging Face commit whose CDN tag changed over the same bytes still finishes', async () => {
  // A commit's bytes never change, but the CDN's ETag for them can (the file moved to another
  // storage backend). Taken for a changed file, the row was refused "The file changed on the
  // server" on every Resume and could never finish. Refused as "does not continue" once (the 206
  // names another ETag than the .part was written under), the next Resume downloads it again from
  // byte 0 and the sha256 passes it.
  const revs: Record<string, Buffer> = { main: OLD_GGUF, [COMMIT_A]: OLD_GGUF }
  const opts: { etagPrefix?: string } & Drop = { dropAfter: 100_000 }
  const hf = await hfStub(revs, opts)
  try {
    await withHfBase(hf.origin, async () => {
      const { modelDir, stateDir } = newDirs()
      const expand = async (): Promise<HfModelFiles> => ({
        dir: '',
        files: [{ rfilename: 'm.gguf', size: OLD_GGUF.length, sha256: sha256(OLD_GGUF), mmproj: false }],
        commit: COMMIT_A,
      })
      const first = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
      const [rec] = await first.enqueue({ repo: 'owner/repo', rfilename: 'm.gguf' })
      opts.part = `${rec.dest}.part`
      assert.equal((await settled(first, rec.id)).status, 'error', 'the first attempt lost its connection')
      opts.etagPrefix = 'xet-'

      const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}), expand)
      assert.equal(dm.resume(rec.id), true)
      const refused = await settled(dm, rec.id)
      assert.equal(hf.seen.at(-1)?.status, 206)
      assert.match(refused.error ?? '', /does not continue the partial file/)
      assert.equal(dm.resume(rec.id), true)
      const row = await settled(dm, rec.id)
      assert.equal(row.status, 'done', row.error ?? '')
      assert.equal(hf.seen.at(-1)?.path, `/owner/repo/resolve/${COMMIT_A}/m.gguf`)
      assert.deepEqual(readFileSync(rec.dest), OLD_GGUF)
    })
  } finally {
    await hf.close()
  }
})

test('a full disk mid-download says so, keeps the .part, and Resume continues once space is freed', async (t) => {
  // The row showed Node's own "ENOSPC: no space left on device, write".
  const full = file(2_000_000)
  const state: FileState = { body: full, etag: '"v1"' }
  const server = await fileServer(state)
  try {
    const { modelDir, stateDir } = newDirs()
    // The .part's writes fail with ENOSPC once 100 kB or more are on disk, as a phone's full
    // storage does.
    const partFds = new Set<number>()
    let room = 100_000
    const realOpen = fs.open
    t.mock.method(fs, 'open', (path: string, ...rest: unknown[]) => {
      const cb = rest.pop() as (err: Error | null, fd: number) => void
      return (realOpen as (...a: unknown[]) => void)(path, ...rest, (err: Error | null, fd: number) => {
        if (!err && String(path).endsWith('.part')) partFds.add(fd)
        cb(err, fd)
      })
    })
    const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' })
    const realWrite = fs.write
    t.mock.method(fs, 'write', (fd: number, buf: Buffer, ...rest: unknown[]) => {
      const cb = rest.at(-1) as (err: Error | null) => void
      if (partFds.has(fd) && room <= 0) return void setImmediate(() => cb(enospc()))
      if (partFds.has(fd)) room -= buf.length
      return (realWrite as (...a: unknown[]) => void)(fd, buf, ...rest)
    })
    const realWritev = fs.writev
    t.mock.method(fs, 'writev', (fd: number, bufs: Buffer[], ...rest: unknown[]) => {
      const cb = rest.at(-1) as (err: Error | null) => void
      if (partFds.has(fd) && room <= 0) return void setImmediate(() => cb(enospc()))
      if (partFds.has(fd)) room -= bufs.reduce((n, b) => n + b.length, 0)
      return (realWritev as (...a: unknown[]) => void)(fd, bufs, ...rest)
    })

    const dm = new DownloadManager(fakeStore(modelDir, stateDir), () => {}, () => ({}))
    const [rec] = await dm.enqueue({ url: `${server.origin}/model.gguf` })
    const row = await settled(dm, rec.id)
    assert.equal(row.status, 'error')
    assert.equal(row.error, 'Storage is full. Free some space, then Resume.')
    const kept = readFileSync(`${rec.dest}.part`).length
    assert.ok(kept >= 100_000 && kept < full.length, `the bytes that fit are kept (${kept})`)

    room = Infinity // space freed
    assert.equal(dm.resume(rec.id), true)
    const resumed = await settled(dm, rec.id)
    assert.equal(resumed.status, 'done', resumed.error ?? '')
    assert.equal(server.seen.at(-1)?.range, `bytes=${kept}-`)
    assert.deepEqual(readFileSync(rec.dest), full)
  } finally {
    await server.close()
  }
})
