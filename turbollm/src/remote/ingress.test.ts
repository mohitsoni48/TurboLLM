import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { IngressListener } from './ingress'

// `ws` ships no bundled types and @types/ws isn't a project dependency; terminal-routes.ts
// already loads it the same way (createRequire) for the same reason.
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const app = new Hono()
app.get('/healthz', (c) => c.json({ ok: true }))

test('IngressListener: reports no port before start', () => {
  const l = new IngressListener()
  assert.equal(l.ingressPort(), undefined)
})

test('IngressListener: binds loopback, serves the app, then releases the port', async () => {
  const l = new IngressListener()
  // Port 0 asks the OS for a free ephemeral port. Used ONLY here, in-process, with no
  // provider attached — AGENTS.md §2's 6996/6997 rule governs the running daemon, and a
  // fixed port would make this test fail whenever the real daemon is up.
  const port = await l.start(app, 0)
  assert.equal(l.ingressPort(), port)
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(res.status, 200)
  await l.stop()
  assert.equal(l.ingressPort(), undefined)
})

test('IngressListener: start is idempotent — a second start replaces the first', async () => {
  const l = new IngressListener()
  const a = await l.start(app, 0)
  const b = await l.start(app, 0)
  assert.notEqual(a, b)
  assert.equal(l.ingressPort(), b)
  await l.stop()
})

test('IngressListener: a failed bind rejects and leaves no port reported', async () => {
  const blocker = new IngressListener()
  const taken = await blocker.start(app, 0)
  const l = new IngressListener()
  await assert.rejects(() => l.start(app, taken))
  assert.equal(l.ingressPort(), undefined)
  await blocker.stop()
})

test('IngressListener: exposes the underlying server once bound, and releases it on stop', async () => {
  const l = new IngressListener()
  // Each observation below reads `l.server` into its own local (rather than asserting on
  // the getter expression directly more than once) — the getter's underlying value changes
  // over the test, and repeated assertions on the same dotted expression can otherwise
  // confuse TypeScript's narrowing into treating it as permanently fixed.
  const before = l.server
  assert.equal(before, null)

  await l.start(app, 0)
  const bound = l.server
  assert.ok(bound, 'server should be exposed once start() resolves')
  // It really is the bound Node server, not a placeholder: it must accept raw socket
  // events like 'upgrade', which is exactly what registerTerminalWs needs from it.
  assert.equal(typeof bound.on, 'function')

  await l.stop()
  const after = l.server
  assert.equal(after, null)
})

test('IngressListener: a WebSocket upgrade on the exposed server reaches a handler registered on it', async () => {
  // Proves the actual gap this fixes: before exposing `server`, nothing could attach an
  // 'upgrade' listener to the ingress listener's Node server, so a WS handshake arriving
  // on the ingress port (i.e. via a tunnel provider pointed at it, per ADR-422) would hit
  // a server with zero 'upgrade' listeners and have its socket destroyed. This registers a
  // bare 'upgrade' listener directly on `l.server` — the same seam `registerTerminalWs`
  // uses in cli.ts — and confirms a real WS client handshake actually reaches it.
  const l = new IngressListener()
  const port = await l.start(app, 0)
  assert.ok(l.server)

  const upgradeReceived = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upgrade listener never fired')), 5_000)
    l.server?.on('upgrade', (_req: unknown, socket: import('net').Socket) => {
      clearTimeout(timer)
      // The point of this test is that the listener fires at all — completing a real WS
      // handshake is registerTerminalWs's job, already covered by its own tests. Destroying
      // the socket here is enough proof and keeps this test independent of that machinery.
      socket.destroy()
      resolve()
    })
  })

  const client = new WebSocket(`ws://127.0.0.1:${port}/anything`)
  client.on('error', () => {
    /* expected: the socket above is destroyed instead of completing the handshake */
  })

  await upgradeReceived
  client.terminate?.()
  await l.stop()
})
