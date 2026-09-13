import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { RemoteAccessManager } from './manager'
import { backoffDelay, MAX_CONSECUTIVE_FAILURES } from './backoff'
import { CONSECUTIVE_FAILURES_BEFORE_RESTART, HEALTH_INTERVAL_MS } from './health'
import type { PreflightState, RemoteProvider } from './types'

/** Poll `fn` until it returns true or `timeoutMs` elapses. Used only to wait for a real,
 *  fast, non-timer-driven async operation (an ephemeral loopback bind) to reach a known point
 *  before the test proceeds — never to paper over a race whose outcome is actually in doubt. */
async function waitFor(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Flush the microtask/macrotask queue once. Used after `t.mock.timers.tick(...)` to let the
 *  Promise continuation chain a resumed `await` triggers actually run before assertions. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

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

/** A provider whose start() hangs until manually settled — for tests that need to freeze a
 *  connection attempt mid-flight (after ingress binds, before the provider "returns" a URL)
 *  and interleave a disable()/enable() cycle around it (ADR-422 Phase 2 final review,
 *  ledgered race (a) — enable()'s catch block tearing down a different, now-current flow's
 *  live listener). */
class ControllableProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'none' as const
  starts = 0
  stops = 0
  private reject: ((e: Error) => void) | undefined
  async preflight(): Promise<PreflightState> {
    return { kind: 'off' }
  }
  start(): Promise<{ url: string }> {
    this.starts++
    return new Promise((_resolve, reject) => {
      this.reject = reject
    })
  }
  async stop(): Promise<void> {
    this.stops++
  }
  alive(): boolean {
    return true
  }
  settleReject(message: string): void {
    this.reject?.(new Error(message))
  }
}

/** A provider whose FIRST `stop()` call hangs until manually released; every later call
 *  resolves immediately. Models a slow-but-eventually-successful graceful shutdown (the real
 *  `ChildTunnel.stop()` has up to an 8s graceful-then-force window) — long enough for a
 *  concurrent `disable()` to run its OWN `stop()` call (a second, immediately-resolving call
 *  on the same instance) to completion while the first is still pending (ADR-422 final-review
 *  fix wave, New Breakage N1). */
class SlowStopProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'none' as const
  starts = 0
  stopCalls = 0
  private releaseFirstStop: (() => void) | undefined
  async preflight(): Promise<PreflightState> {
    return { kind: 'off' }
  }
  async start(): Promise<{ url: string }> {
    this.starts++
    return { url: `https://example-${this.starts}.test` }
  }
  async stop(): Promise<void> {
    this.stopCalls++
    if (this.stopCalls === 1) {
      await new Promise<void>((resolve) => {
        this.releaseFirstStop = resolve
      })
    }
  }
  alive(): boolean {
    return true
  }
  releaseHungStop(): void {
    this.releaseFirstStop?.()
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

  // Let the still-pending backoff timer see the generation bump and bail out cleanly
  // (already-correct disable-during-backoff behavior), rather than leaking a live timer
  // into later tests.
  await m.disable()
  assert.equal(m.state().kind, 'off')
})

// --- ADR-422 Phase 2 final review: the generation counter -------------------------------
// I1 + the three previously-ledgered "cosmetic" races, all one root cause: a flow that is no
// longer current still mutating shared state. These tests drive the exact interleavings the
// review traced. All of them use node:test's mock timers (scoped to 'setTimeout' only, so the
// health loop's real setInterval is untouched) rather than real waits, so a pending backoff
// never becomes a live OS timer that could outlive its test or make the suite flaky/slow.

test('manager: a no-op enable() during reconnecting does not orphan the pending restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const p = new WatchableProvider()
  const m = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => true })

  await m.enable()
  p.triggerExit(1)
  assert.equal(m.state().kind, 'reconnecting')

  // A no-op enable() arriving mid-backoff must not disturb the pending restart in any way —
  // including not bumping the generation counter, or the pending restart would (incorrectly)
  // see itself as superseded once its timer fires below.
  await m.enable()
  assert.equal(m.state().kind, 'reconnecting')
  assert.equal(p.starts, 1)

  t.mock.timers.tick(backoffDelay(0))
  await flush()
  await flush()

  assert.equal(m.state().kind, 'connected')
  assert.equal(p.starts, 2) // the pending restart reconnected normally, using the same provider

  await m.disable()
})

test('manager: disable() -> enable() -> a late-firing pending restart must not disturb the new connection (I1)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const providers: WatchableProvider[] = []
  const m = new RemoteAccessManager({
    app,
    ingressPort: 0,
    makeProvider: () => {
      const p = new WatchableProvider()
      providers.push(p)
      return p
    },
    probe: async () => true,
  })

  await m.enable() // provider #0 connects
  const p1 = providers[0]
  assert.equal(p1.starts, 1)

  p1.triggerExit(1) // watch() -> restart(): failures=1, 'reconnecting', awaits a MOCKED 1s backoff
  assert.equal(m.state().kind, 'reconnecting')

  // The exact I1 sequence: disable() while that backoff is still pending...
  await m.disable()
  assert.equal(m.state().kind, 'off')

  // ...followed by a fresh enable(), establishing a genuinely new, live connection.
  await m.enable() // provider #1
  assert.equal(m.state().kind, 'connected')
  assert.equal(providers.length, 2)
  const boundPort = m.ingressPort()
  assert.equal(typeof boundPort, 'number')

  // Now let the stale restart's backoff timer fire. Pre-fix, this would call makeProvider()
  // again (leaking a THIRD, untracked provider `disable()` can no longer reach) and race the
  // live connection for `this.provider` / `state()`.
  t.mock.timers.tick(backoffDelay(0))
  await flush()
  await flush()

  assert.equal(m.state().kind, 'connected') // untouched by the stale restart
  assert.equal(m.ingressPort(), boundPort)
  assert.equal(providers.length, 2, 'no third, stale provider was ever created')

  await m.disable()
})

test("manager: enable()'s catch does not tear down a different, now-current connection", async () => {
  let calls = 0
  const p2 = new ControllableProvider()
  const p3 = new FakeProvider()
  const m = new RemoteAccessManager({
    app,
    ingressPort: 0,
    makeProvider: () => (calls++ === 0 ? p2 : p3),
    probe: async () => true,
  })

  const enable1 = m.enable() // P2's flow: hangs inside provider.start(), after ingress has bound
  await waitFor(() => p2.starts === 1)
  assert.equal(m.state().kind, 'starting')

  // Supersede P2's in-flight attempt (ADR-422 final review, ledgered race (a)).
  await m.disable()
  assert.equal(m.state().kind, 'off')

  // A fresh, fully-resolving connection — this is now the current, live one (P3).
  await m.enable()
  assert.equal(m.state().kind, 'connected')
  const boundPort = m.ingressPort()
  assert.equal(typeof boundPort, 'number')

  // P2's original start() finally rejects, long after it was superseded.
  p2.settleReject('provider boom (stale)')
  await enable1 // let P2's enable() call run its catch block to completion

  // The catch block's generation check must have stopped it before it ever called
  // ingress.stop() — P3's connection and its bound port must be completely untouched.
  assert.equal(m.state().kind, 'connected')
  assert.equal(m.ingressPort(), boundPort)

  await m.disable()
})

test('manager: restart() gives up after MAX_CONSECUTIVE_FAILURES and settles cleanly in failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const p = new WatchableProvider()
  const m = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => true })

  await m.enable()
  assert.equal(m.state().kind, 'connected')

  // Fire MAX_CONSECUTIVE_FAILURES+1 restart() calls back-to-back without awaiting each one.
  // restart()'s `this.failures++` runs synchronously before its own first await, so firing
  // them this way reliably drives the (MAX+1)th call into the `> MAX_CONSECUTIVE_FAILURES`
  // give-up branch without needing any real backoff wait to elapse — timers are mocked above,
  // so the resulting pending backoff waits from calls 1..MAX never become live OS timers that
  // could outlive this test.
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) void m.restart(`attempt ${i}`)
  await m.restart(`attempt ${MAX_CONSECUTIVE_FAILURES}`)

  assert.equal(m.state().kind, 'failed')
  assert.equal(m.ingressPort(), undefined) // the give-up branch tore its own (uncontested) ingress down

  await m.disable()
})

// --- ADR-422 Phase 2 final-review FIX WAVE re-review: New Breakage N1 ----------------------
// The generation-counter fix above closed I1 and the three ledgered races, but restart()
// originally RE-CAPTURED `this.generation` at its own entry rather than inheriting the
// caller's — which mattered for exactly one caller: the health loop, which awaits
// `provider.stop()` between its own last generation check and its `restart()` call. A
// disable() landing in that window bumps the generation out from under a check that already
// passed, and a re-capturing restart() would silently adopt the NEW generation and proceed as
// current — resurrecting a tunnel the user just explicitly stopped. The fix threads the
// health loop's OWN already-checked `gen` into restart() as an explicit argument instead.
test('manager: a stale health-loop restart() after disable() during provider.stop() must not resurrect the tunnel (N1)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const providers: SlowStopProvider[] = []
  const m = new RemoteAccessManager({
    app,
    ingressPort: 0,
    makeProvider: () => {
      const p = new SlowStopProvider()
      providers.push(p)
      return p
    },
    probe: async () => false, // every probe fails, to reliably drive the restart path
  })

  await m.enable() // provider #0 connects
  assert.equal(providers.length, 1)
  assert.equal(m.state().kind, 'connected')

  // Drive CONSECUTIVE_FAILURES_BEFORE_RESTART failed probes. Each tick's probe() resolves on
  // a microtask (and nextHealthCheck/consecutiveProbeFailures bookkeeping runs synchronously
  // after it), so flush after each tick to let that continuation actually run before the next.
  for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_RESTART; i++) {
    t.mock.timers.tick(HEALTH_INTERVAL_MS)
    await flush()
    await flush()
  }
  // The health loop has now called provider.stop() (call #1, hung) and is parked immediately
  // before its restart(reason, gen) call.
  assert.equal(providers[0].stopCalls, 1)

  // The exact N1 window: disable() runs to completion — including ITS OWN provider.stop() call
  // (call #2 on the same instance, which resolves immediately) — WHILE call #1 is still hung.
  await m.disable()
  assert.equal(m.state().kind, 'off')
  assert.equal(m.ingressPort(), undefined)

  // Release the hung call. This lets the health loop's stale `.then()` continuation resume and
  // call restart(reason, gen) with the now-superseded generation it captured before any of the
  // above happened.
  providers[0].releaseHungStop()
  await flush()
  await flush()
  await flush()

  // Pre-fix: restart() re-captured `this.generation` (now bumped by disable()+the implicit
  // re-enable path) and proceeded as current — spawning a second provider and reconnecting to
  // a NEW public URL moments after the user explicitly stopped the first one.
  assert.equal(m.state().kind, 'off', 'a stale health-loop restart must not resurrect the tunnel after disable()')
  assert.equal(providers.length, 1, 'no second, resurrected provider was ever created')
  assert.equal(m.ingressPort(), undefined)
})
