// util/daemon-dispatcher.ts: the global fetch dispatcher must not cap in-flight requests per origin, and must not
// time out an engine that is still generating.
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createDaemonDispatcher } from './daemon-dispatcher'

test('more than 10 streams to one origin are in flight at once', async () => {
  const held: ServerResponse[] = []
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': open\n\n')
    held.push(res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const dispatcher = createDaemonDispatcher()
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  try {
    // fetch resolves on headers; with a 10-socket cap, request 11 would never resolve while the first 10 stay open.
    const responses = await Promise.race([
      Promise.all(Array.from({ length: 16 }, () => fetch(url, { dispatcher } as unknown as RequestInit))),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('requests queued behind a socket cap')), 3000)),
    ])
    assert.equal(responses.length, 16)
    assert.equal(held.length, 16)
    for (const r of responses) await r.body?.cancel()
  } finally {
    for (const res of held) res.destroy()
    await dispatcher.close()
    server.close()
  }
})

test('header and body timeouts are disabled so a long non-streaming generation is not cut at 300 s', () => {
  const opts = createDaemonDispatcher.options
  assert.equal(opts.headersTimeout, 0)
  assert.equal(opts.bodyTimeout, 0)
  assert.equal(opts.keepAliveMaxTimeout, 60_000)
})
