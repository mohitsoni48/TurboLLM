import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { IngressListener } from './ingress'

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
