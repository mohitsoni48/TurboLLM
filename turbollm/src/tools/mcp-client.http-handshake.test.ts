import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SseMcpClient } from './mcp-client'

// Spin-wait with a hard deadline: a regression must fail fast, not hang the suite.
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 1))
  }
}

async function fixture(failNotification = false) {
  let initializes = 0
  let notifications = 0
  let notificationsWithSession = 0
  let lastNotificationAccept = ''
  let currentSession: string | null = null
  // Readiness is per SESSION, not per server: a fresh initialize must not inherit the
  // previous session's initialized state, and post-initialize calls must present the
  // Mcp-Session-Id the server handed out.
  const readySessions = new Set<string>()
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = JSON.parse(body)
    const reply = (result: unknown) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    }
    // Streamable HTTP: EVERY POST must Accept both types; official-SDK servers answer 406.
    const accept = String(req.headers['accept'] ?? '')
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      res.writeHead(406).end('Not Acceptable: Accept must list application/json and text/event-stream')
      return
    }
    if (msg.method === 'initialize') {
      initializes++
      currentSession = `session-${initializes}`
      await new Promise(r => setTimeout(r, 30))
      res.setHeader('Mcp-Session-Id', currentSession)
      reply({ protocolVersion: '2024-11-05', capabilities: {} })
      return
    }
    if (req.headers['mcp-session-id'] !== currentSession) {
      res.writeHead(400).end('missing or wrong Mcp-Session-Id')
      return
    }
    if (msg.method === 'notifications/initialized') {
      notifications++
      notificationsWithSession++
      lastNotificationAccept = accept
      await new Promise(r => setTimeout(r, 50))
      if (failNotification && notifications === 1) { res.writeHead(503).end('not ready'); return }
      readySessions.add(currentSession)
      res.writeHead(202).end()
    } else if (!readySessions.has(String(req.headers['mcp-session-id']))) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'request before initialized' } }))
    } else if (msg.method === 'tools/list') reply({ tools: [{ name: 'echo' }] })
    else reply({ content: [{ type: 'text', text: 'pong' }] })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new SseMcpClient({ id: 'http', name: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  return { client, counts: () => ({ initializes, notifications, notificationsWithSession }), notificationAccept: () => lastNotificationAccept, close: async () => {
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
    assert.deepEqual(f.counts(), { initializes: 1, notifications: 1, notificationsWithSession: 1 })
    // The spec Accept header rode on the notification POST (fixture 406s without it).
    assert.ok(f.notificationAccept().includes('application/json'))
    assert.ok(f.notificationAccept().includes('text/event-stream'))
  } finally { await f.close() }
})

test('HTTP initialized notification failure rejects connect and permits a clean retry', async () => {
  const f = await fixture(true)
  try {
    // The rejection carries status AND the server's response body, so the cause is visible.
    await assert.rejects(f.client.connect(), /503: not ready/)
    assert.equal(await f.client.callTool('echo', {}), 'pong')
    assert.deepEqual(f.counts(), { initializes: 2, notifications: 2, notificationsWithSession: 2 })
  } finally { await f.close() }
})


test('disconnect during HTTP initialize cannot revive the old connection', async () => {
  const f = await fixture()
  try {
    const connecting = f.client.connect()
    const rejection = assert.rejects(connecting, /disconnected/)
    await waitFor(() => f.counts().initializes > 0, 'initialize to reach the fixture')
    f.client.disconnect()
    await rejection
    assert.equal(f.counts().notifications, 0)
    assert.equal(await f.client.callTool('echo', {}), 'pong')
    assert.deepEqual(f.counts(), { initializes: 2, notifications: 1, notificationsWithSession: 1 })
  } finally { await f.close() }
})

test('disconnect during HTTP initialized notification cannot mark it connected', async () => {
  const f = await fixture()
  try {
    const connecting = f.client.connect()
    const rejection = assert.rejects(connecting, /disconnected/)
    await waitFor(() => f.counts().notifications > 0, 'notification to reach the fixture')
    f.client.disconnect()
    await rejection
    assert.equal(await f.client.callTool('echo', {}), 'pong')
    assert.deepEqual(f.counts(), { initializes: 2, notifications: 2, notificationsWithSession: 2 })
  } finally { await f.close() }
})
