import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { RemoteAccessManager } from './manager'
import type { PreflightState, RemoteProvider } from './types'

const app = new Hono()
app.get('/healthz', (c) => c.json({ ok: true }))

class FakeProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'none' as const
  starts = 0
  stops = 0
  constructor(
    private outcome: 'ok' | 'throw' = 'ok',
    private pre: PreflightState = { kind: 'off' },
  ) {}
  async preflight(): Promise<PreflightState> {
    return this.pre
  }
  async start(): Promise<{ url: string }> {
    this.starts++
    if (this.outcome === 'throw') throw new Error('provider boom')
    return { url: 'https://example.test' }
  }
  async stop(): Promise<void> {
    this.stops++
  }
  alive(): boolean {
    return true
  }
}

const mgr = (p: RemoteProvider) =>
  new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => true })

test('manager: starts off', () => {
  assert.equal(mgr(new FakeProvider()).state().kind, 'off')
})

test('manager: enable binds ingress and reaches connected with the URL', async () => {
  const m = mgr(new FakeProvider())
  await m.enable()
  const s = m.state()
  assert.equal(s.kind, 'connected')
  assert.equal(s.kind === 'connected' && s.url, 'https://example.test')
  assert.equal(typeof m.ingressPort(), 'number')
  await m.disable()
})

test('manager: disable stops the provider, releases ingress, returns to off', async () => {
  const p = new FakeProvider()
  const m = mgr(p)
  await m.enable()
  await m.disable()
  assert.equal(m.state().kind, 'off')
  assert.equal(m.ingressPort(), undefined)
  assert.equal(p.stops >= 1, true)
})

test('manager: a preflight refusal surfaces verbatim and never starts the provider', async () => {
  const p = new FakeProvider('ok', { kind: 'needs-setup', reason: 'ngrok needs an authtoken' })
  const m = mgr(p)
  await m.enable()
  const s = m.state()
  assert.equal(s.kind, 'needs-setup')
  assert.equal(s.kind === 'needs-setup' && s.reason, 'ngrok needs an authtoken')
  assert.equal(p.starts, 0)
  await m.disable()
})

test('manager: a start that throws lands in failed carrying the real error', async () => {
  const m = mgr(new FakeProvider('throw'))
  await m.enable()
  const s = m.state()
  assert.equal(s.kind, 'failed')
  assert.equal(s.kind === 'failed' && s.reason.includes('provider boom'), true)
  await m.disable()
})

test('manager: ingressPort is undefined while off, satisfying the RemoteIngress seam', () => {
  assert.equal(mgr(new FakeProvider()).ingressPort(), undefined)
})
