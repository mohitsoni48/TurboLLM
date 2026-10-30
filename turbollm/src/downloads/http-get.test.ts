// httpGet, the node:http client model downloads stream with (in place of the global fetch, whose
// undici parser crashed the daemon on a server that closes the connection), against real local
// servers: the parts of fetch's behaviour downloads.http.test.ts does not already cover through
// DownloadManager, and where it now differs on purpose.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { httpGet } from './http-get'

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    host,
    url: (path: string) => `http://${host}${path}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

const get = (url: string, signal = new AbortController().signal) => httpGet(url, { headers: {}, signal })

/** `p`, or a rejection after `ms`: a client that never settles fails its test, whose finally then
 *  closes the servers, instead of leaving the file's process waiting on the open connection. */
function within<T>(p: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

test('a 2xx the server compressed although asked for identity is refused, not handed on as the file', async () => {
  const body = Buffer.alloc(50_000, 'model bytes ')
  let asked: string | undefined
  const server = await serve((req, res) => {
    asked = req.headers['accept-encoding']
    const gz = gzipSync(body)
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length })
    res.end(gz)
  })
  try {
    await assert.rejects(get(server.url('/m.gguf')), {
      message: `${server.host} sent the file compressed (Content-Encoding: gzip) instead of as its own bytes.`,
    })
    assert.equal(asked, 'identity')
  } finally {
    await server.close()
  }
})

test('a body cut short by the server closing the connection errors as that', async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { 'Content-Length': 100_000 })
    res.write(Buffer.alloc(1000, 1), () => req.socket.destroy())
  })
  try {
    const res = await get(server.url('/m.gguf'))
    assert.equal(res.status, 200)
    await assert.rejects(res.arrayBuffer(), { message: `${server.host} closed the connection before the whole file arrived.` })
  } finally {
    await server.close()
  }
})

test('connecting to an https host that never finishes its TLS handshake gives up after the connect timeout', async () => {
  const held: Socket[] = []
  const tcp = createTcpServer((s) => held.push(s)) // accepts, then says nothing
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
  const host = `127.0.0.1:${(tcp.address() as AddressInfo).port}`
  try {
    await assert.rejects(within(httpGet(`https://${host}/m.gguf`, { headers: {}, signal: new AbortController().signal, connectTimeout: 200 })), {
      message: `Could not connect to ${host} within 0.2 s.`,
    })
  } finally {
    for (const s of held) s.destroy()
    await new Promise<void>((r) => tcp.close(() => r()))
  }
})

test('redirects are followed 20 times, as fetch does, and the 21st is refused', async () => {
  let hops = 20
  let hits = 0
  const server = await serve((req, res) => {
    hits++
    const n = Number(req.url!.slice(1))
    if (n < hops) {
      res.writeHead(302, { Location: `/${n + 1}` })
      return res.end()
    }
    res.writeHead(200, { 'Content-Length': 2 })
    res.end('ok')
  })
  try {
    const res = await get(server.url('/0'))
    assert.equal(await res.text(), 'ok')
    assert.equal(hits, 21)
    hops = 21
    hits = 0
    await assert.rejects(get(server.url('/0')), { message: 'Too many redirects (more than 20).' })
    assert.equal(hits, 21, 'the 21st redirect is not followed')
  } finally {
    await server.close()
  }
})

test('an abort while waiting for the headers rejects with an AbortError and closes the connection; one before sends nothing', async () => {
  let requests = 0
  let closed = false
  const server = await serve((req) => {
    requests++
    req.socket.on('close', () => { closed = true })
  })
  try {
    const ac = new AbortController()
    const pending = get(server.url('/m.gguf'), ac.signal)
    while (requests === 0) await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    await assert.rejects(within(pending), { name: 'AbortError' })
    for (let i = 0; i < 200 && !closed; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(closed, true)

    await assert.rejects(within(get(server.url('/again.gguf'), ac.signal)), { name: 'AbortError' })
    assert.equal(requests, 1)
  } finally {
    await server.close()
  }
})

test('a 204 has a null body, as fetch gives it, and the headers come through', async () => {
  const server = await serve((_req, res) => {
    res.writeHead(204, { ETag: '"e1"', 'X-Thing': 'a' })
    res.end()
  })
  try {
    const res = await get(server.url('/m.gguf'))
    assert.equal(res.status, 204)
    assert.equal(res.body, null)
    assert.equal(res.headers.get('etag'), '"e1"')
    assert.equal(res.headers.get('x-thing'), 'a')
  } finally {
    await server.close()
  }
})
