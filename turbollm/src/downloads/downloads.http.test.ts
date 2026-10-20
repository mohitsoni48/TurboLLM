// DownloadManager against real local node:http servers, through the client run() streams model
// files with (http-get.ts), not a fetch double: a server that closes the connection after the
// body (which crashed the daemon through undici), redirects that change origin, a resume through
// a redirect, a cancel mid-body and a server that stops sending.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DownloadManager, setDownloadGetForTests, type DownloadRecord } from './downloads'
import { httpGet } from './http-get'
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
