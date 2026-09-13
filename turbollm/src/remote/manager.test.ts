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

/** A provider that also implements the duck-typed `onExit` convention `watch()` relies on, so
 *  a test can simulate an unexpected crash (via `triggerExit`) and drive the manager into
 *  `restart()`'s backoff cycle exactly as a real child-process provider dying would. */
class WatchableProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'child-process' as const
  starts = 0
  stops = 0
  private exitCb: ((code: number | null) => void) | undefined
  async preflight(): Promise<PreflightState> {
    return { kind: 'off' }
  }
  async start(): Promise<{ url: string }> {
    this.starts++
    return { url: 'https://example.test' }
  }
  async stop(): Promise<void> {
    this.stops++
  }
  alive(): boolean {
    return true
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb
  }
  triggerExit(code: number | null = 1): void {
    this.exitCb?.(code)
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

test('manager: a preflight refusal clears the provider, so disable() never stops an unstarted one', async () => {
  // Regression test for the Important finding: enable() used to leave `this.provider` set to
  // an instance whose start() was never called after a preflight refusal, so a later disable()
  // called .stop() on a never-started provider. Assert on the `stops` counter, since that is
  // the only way to observe this given the class's current public API.
  const p = new FakeProvider('ok', { kind: 'needs-setup', reason: 'ngrok needs an authtoken' })
  const m = mgr(p)
  await m.enable()
  assert.equal(m.state().kind, 'needs-setup')
  assert.equal(p.starts, 0)

  await m.disable()
  assert.equal(p.stops, 0)
})

test('manager: enable() during reconnecting is a no-op, not a second competing connect', async () => {
  // Regression test for the Critical finding: enable()'s idempotency guard used to omit
  // 'reconnecting', so calling enable() while a restart() cycle was mid-backoff started a
  // second, competing provider instead of being blocked like the connected/starting cases.
  const p = new WatchableProvider()
  const m = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => true })

  await m.enable()
  assert.equal(m.state().kind, 'connected')
  assert.equal(p.starts, 1)

  // Simulate an unexpected crash. watch()'s onExit callback calls restart(), which is async but
  // runs synchronously up to its own first await (the backoff timer) — so by the time this call
  // returns, `this.current.kind` is already 'reconnecting' and the backoff timer is pending.
  p.triggerExit(1)
  assert.equal(m.state().kind, 'reconnecting')

  // A fresh enable() call arriving here (e.g. the user clicking "enable" while a
  // "reconnecting…" indicator is showing) must be a pure no-op: no second makeProvider()/
  // preflight()/start() cycle, and the reconnecting state must be left untouched.
  await m.enable()
  assert.equal(m.state().kind, 'reconnecting')
  assert.equal(p.starts, 1)

  // Let the still-pending backoff timer see `stopping` and bail out cleanly (already-correct
  // disable-during-backoff behavior), rather than leaking a live timer into later tests.
  await m.disable()
  assert.equal(m.state().kind, 'off')
})
