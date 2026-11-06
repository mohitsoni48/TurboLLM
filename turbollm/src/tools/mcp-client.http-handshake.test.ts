import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SseMcpClient } from './mcp-client'

async function fixture(failNotification = false) {
  let initializes = 0
  let initialized = false
  let notifications = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = JSON.parse(body)
    const reply = (result: unknown) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    }
    if (msg.method === 'initialize') {
      initializes++
      await new Promise(r => setTimeout(r, 30))
      res.setHeader('Mcp-Session-Id', 'session')
      reply({ protocolVersion: '2024-11-05', capabilities: {} })
    } else if (msg.method === 'notifications/initialized') {
      notifications++
      await new Promise(r => setTimeout(r, 50))
      if (failNotification && notifications === 1) { res.writeHead(503).end('not ready'); return }
      initialized = true
      res.writeHead(202).end()
    } else if (!initialized) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'request before initialized' } }))
    } else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo' }] })
    else reply({ content: [{ type: 'text', text: 'pong' }] })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new SseMcpClient({ id: 'http', name: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  return { client, counts: () => ({ initializes, notifications }), close: async () => {
    client.disconnect()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

test('HTTP concurrent first calls share one completed initialize/initialized handshake', async () => {
  const f = await fixture()
  try {
    const [tools, a, b] = await Promise.all([f.client.listTools(), f.client.callTool('echo', {}), f.client.callTool('echo', {})])
    assert.deepEqual(tools.map(t => t.name), ['echo'])
    assert.equal(a, 'pong')
    assert.equal(b, 'pong')
    assert.deepEqual(f.counts(), { initializes: 1, notifications: 1 })
  } finally { await f.close() }
})

test('HTTP initialized notification failure rejects connect and permits a clean retry', async () => {
  const f = await fixture(true)
  try {
    await assert.rejects(f.client.connect(), /503/)
    assert.equal(await f.client.callTool('echo', {}), 'pong')
    assert.deepEqual(f.counts(), { initializes: 2, notifications: 2 })
  } finally { await f.close() }
})


test('disconnect during HTTP initialize cannot revive the old connection', async () => {
  const f = await fixture()
  try {
    const connecting = f.client.connect()
    const rejection = assert.rejects(connecting, /disconnected/)
    while (f.counts().initializes === 0) await new Promise(r => setTimeout(r, 1))
    f.client.disconnect()
    await rejection
    assert.equal(f.counts().notifications, 0)
    assert.equal(await f.client.callTool('echo', {}), 'pong')
    assert.deepEqual(f.counts(), { initializes: 2, notifications: 1 })
  } finally { await f.close() }
})

test('disconnect during HTTP initialized notification cannot mark it connected', async () => {
  const f = await fixture()
  try {
    const connecting = f.client.connect()
    const rejection = assert.rejects(connecting, /disconnected/)
    while (f.counts().notifications === 0) await new Promise(r => setTimeout(r, 1))
    f.client.disconnect()
    await rejection
    assert.equal(await f.client.callTool('echo', {}), 'pong')
    assert.deepEqual(f.counts(), { initializes: 2, notifications: 2 })
  } finally { await f.close() }
})
