import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { RemoteAccessManager } from './manager'
import { backoffDelay, MAX_CONSECUTIVE_FAILURES } from './backoff'
import { CONSECUTIVE_FAILURES_BEFORE_RESTART, HEALTH_INTERVAL_MS } from './health'
import { TailscaleServeProvider, type RunTailscale } from './providers/tailscale'
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
 *  fix wave, New Breakage N1). MUST be `child-process`: since the Phase 3 final-review fix for
 *  finding I2, the health loop's failure path only calls `provider.stop()` for that lifecycle
 *  (see manager.ts) — this class exists specifically to make the health loop's own stop() call
 *  hang, so it must declare the one lifecycle that still triggers it. */
class SlowStopProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'child-process' as const
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

/** A 'system-state' provider whose start() ALWAYS trivially succeeds regardless of whether
 *  the tunnel is actually reachable — exactly like the real TailscaleProvider, whose start()
 *  just re-issues `serve`/`funnel` and proves nothing about reachability (ADR-422 Phase 3
 *  final review, Important finding I2). Deliberately implements no `onExit` — a real
 *  system-state provider has no process to report an exit for at all. */
class FakeSystemStateProvider implements RemoteProvider {
  readonly id = 'tailscale-serve' as const
  readonly lifecycle = 'system-state' as const
  starts = 0
  stops = 0
  async preflight(): Promise<PreflightState> {
    return { kind: 'off' }
  }
  async start(): Promise<{ url: string }> {
    this.starts++
    return { url: 'https://box.tail1234.ts.net' }
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

// --- ADR-422 Phase 3 final review, Important finding I2 ------------------------------------
// "Zero tests pair RemoteAccessManager with a non-child-process provider... I2 would have
// been caught by one such test." A probe-driven restart succeeding proves nothing about
// reachability for a 'system-state' provider (Tailscale's start() just re-issues
// `serve`/`funnel`, regardless of whether the tailnet is actually reachable) — so resetting
// the failure streak on such a "success" made `failed` structurally unreachable, and tearing
// the provider down via stop() purely because an end-to-end probe failed would issue a REAL
// `tailscale ... off` against a tunnel that may still be genuinely working (a false-negative
// probe, not evidence of an actual outage — see health.ts's tailnet-reachability notes).

// --- ADR-422 Phase 3 final-review fix-wave re-review, Important finding --------------------
// The fix wave above closed I2's stop()-on-probe-failure half but left the SAME probe signal
// able to drive a system-state provider all the way to the terminal `failed` teardown — in a
// userspace-networking Tailscale deployment (RunPod/Kaggle) the daemon's own probe of its OWN
// tailnet URL fails 100% of the time while the tunnel serves every other tailnet device fine,
// so this walked a working tunnel into `failed` (ingress torn down, tailnet serve left
// dangling, no auto-recovery) after ~35 minutes. The re-review's fix: gate the give-up branch
// itself by the same lifecycle check already used for the stop() call right above it.
test('manager: I2 follow-up — a system-state provider never reaches failed no matter how many probe-driven restarts occur', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const p = new FakeSystemStateProvider()
  const m = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => false })

  await m.enable()
  assert.equal(m.state().kind, 'connected')
  assert.equal(p.stops, 0)

  // Drive well PAST MAX_CONSECUTIVE_FAILURES consecutive probe-driven restarts with a probe
  // that NEVER succeeds — exactly the pathological deployment above, where a successful probe
  // (which would also reset the streak — see the test below) never happens at all, so the
  // give-up gate is the only thing standing between this loop and a false `failed`.
  const cycles = MAX_CONSECUTIVE_FAILURES + 3
  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_RESTART; i++) {
      t.mock.timers.tick(HEALTH_INTERVAL_MS)
      await flush()
      await flush()
    }
    // (a) The health loop's failure-handling path must NEVER call stop() on a system-state
    // provider purely because the end-to-end probe failed — only an explicit disable() may.
    assert.equal(p.stops, 0, `cycle ${cycle}: a probe-driven restart must not call stop()`)
    assert.equal(m.state().kind, 'reconnecting', `cycle ${cycle} should be reconnecting`)
    // backoffDelay caps at 60s well before this many cycles — tick the cap directly rather
    // than recomputing an ever-growing 2**attempt for the later cycles.
    t.mock.timers.tick(60_000)
    await flush()
    await flush()
    assert.equal(m.state().kind, 'connected', `cycle ${cycle} should reconnect — the fake's start() always succeeds`)
  }

  // (b) Even well past MAX_CONSECUTIVE_FAILURES consecutive probe-driven restarts, a
  // system-state provider must still be alive and retrying at the 60s-capped cadence — the
  // terminal `failed` teardown is reserved for 'child-process', where a probe failure is real
  // evidence of an actual dead tunnel rather than a structurally-unreachable self-probe.
  assert.notEqual(m.state().kind, 'failed')
  assert.equal(p.stops, 0, 'must never have gone through a health-probe-driven stop() either')

  await m.disable()
  assert.equal(p.stops, 1, 'only the explicit, user-initiated disable() ever issues the real stop()')
})

// Note: a child-process provider whose start() keeps SUCCEEDING can never be driven to
// 'failed' by probe failures alone, health-loop or otherwise — restart()'s success branch
// resets `this.failures` to 0 on every successful reconnect for that lifecycle (correctly:
// a real child printing real evidence it started IS reachability evidence). The existing
// 'restart() gives up after MAX_CONSECUTIVE_FAILURES...' test above already proves child-
// process still reaches `failed` (by calling restart() directly, faster than a real backoff
// wait, so the streak accumulates before any reconnect can reset it) — that coverage is
// unaffected by the lifecycle gate this fix adds, since WatchableProvider satisfies it.

// --- ADR-422 Phase 3 final-review fix-wave re-review, Minor finding ------------------------
// `this.failures` was a LIFETIME count for non-child-process lifecycles (nothing reset it
// while connected), so a genuinely healthy Tailscale tunnel that hit ten separate,
// widely-spaced three-minute blips over a long uptime would eventually report "gave up after
// 10 attempts" for an outage that never happened. A real passing probe — unlike start()
// succeeding, which the I2 fix already correctly refuses to trust for these lifecycles — IS
// genuine end-to-end evidence, so it must reset the streak.
test('manager: a successful probe resets the give-up counter, so widely-spaced blips never accumulate for a system-state provider', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const p = new FakeSystemStateProvider()
  let healthy = false
  const m = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => healthy })

  await m.enable()
  assert.equal(m.state().kind, 'connected')

  // First blip: drive one full failed-probe -> restart -> reconnect cycle. `this.failures`
  // is now 1 (observable via the next 'reconnecting' state's `attempt` field).
  for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_RESTART; i++) {
    t.mock.timers.tick(HEALTH_INTERVAL_MS)
    await flush()
    await flush()
  }
  const first = m.state()
  assert.equal(first.kind, 'reconnecting')
  assert.equal(first.kind === 'reconnecting' && first.attempt, 1)
  t.mock.timers.tick(60_000)
  await flush()
  await flush()
  assert.equal(m.state().kind, 'connected')

  // Let ONE probe succeed — a single passing health check, not a full reconnect — which must
  // reset the streak even though nothing about the connection itself changed.
  healthy = true
  t.mock.timers.tick(HEALTH_INTERVAL_MS)
  await flush()
  await flush()
  assert.equal(m.state().kind, 'connected', 'a passing probe must not itself disturb a connected state')
  healthy = false

  // Second blip, identical shape to the first. If the streak were a lifetime counter this
  // would report attempt 2; since the intervening success reset it, it must report attempt 1
  // again.
  for (let i = 0; i < CONSECUTIVE_FAILURES_BEFORE_RESTART; i++) {
    t.mock.timers.tick(HEALTH_INTERVAL_MS)
    await flush()
    await flush()
  }
  const second = m.state()
  assert.equal(second.kind, 'reconnecting')
  assert.equal(second.kind === 'reconnecting' && second.attempt, 1, 'the earlier successful probe must have reset the streak to 0')

  t.mock.timers.tick(60_000)
  await flush()
  await flush()
  await m.disable()
})

// --- ADR-422 Phase 3 final review, Important finding I3 (integration check) ----------------
// I3's unit tests (tailscale.test.ts) prove TailscaleProvider.start() throws on a non-zero
// exit code. This test proves the OTHER half: driven through the real supervisor (not a fake
// provider), that throw actually lands in a real `failed` state carrying the real reason —
// not a fabricated `connected` — which is the concrete failure I2/I3 together used to allow.
test('manager: I3 — a real TailscaleServeProvider CLI failure surfaces as failed with the real reason, not a fabricated connect', async () => {
  const RUNNING = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' } })
  const run: RunTailscale = async (args) => {
    if (args[0] === 'status') return { code: 0, stdout: RUNNING, stderr: '' }
    return { code: 1, stdout: '', stderr: 'tailscale: Funnel is not enabled for this tailnet' }
  }
  const p = new TailscaleServeProvider({ port: 443 }, run)
  const m = new RemoteAccessManager({ app, ingressPort: 0, makeProvider: () => p, probe: async () => true })

  await m.enable()
  const s = m.state()
  assert.equal(s.kind, 'failed')
  assert.equal(s.kind === 'failed' && s.reason.includes('Funnel is not enabled for this tailnet'), true)

  await m.disable()
})
