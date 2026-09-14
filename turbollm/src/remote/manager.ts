// The remote-access supervisor (ADR-422, spec 30 §2.4). Owns the state machine, the ingress
// listener, the backoff loop and the health probe.
//
// Replaces tunnel/manager.ts's TunnelManager, which never restarted cloudflared at all: on
// child exit it nulled its handle and went silent, which is the direct cause of the
// "cloudflare sessions end after some time" report this feature exists to answer.
import type { Hono } from 'hono'
import { IngressListener } from './ingress'
import type { RemoteIngress } from './ingress-types'
import { backoffDelay, MAX_CONSECUTIVE_FAILURES } from './backoff'
import { HEALTH_INTERVAL_MS, nextHealthCheck } from './health'
import type { RemoteProvider, RemoteState } from './types'

export interface RemoteAccessOptions {
  app: Hono
  /** The loopback port to bind. 0 asks the OS for an ephemeral one (tests only). */
  ingressPort: number
  makeProvider: () => RemoteProvider
  /** End-to-end reachability check against the live public URL. Injected so tests never
   *  make a real network call; production passes the probe from Task 8. */
  probe: (url: string) => Promise<boolean>
  /** Called whenever the state changes, so the API/UI can observe transitions. cli.ts wires
   *  this to log the URL and persist it to config.json on every 'connected' transition — the
   *  very first connect AND every automatic reconnect (ADR-422 Phase 2 final review, findings
   *  C2 and I4). */
  onState?: (s: RemoteState) => void
}

export class RemoteAccessManager implements RemoteIngress {
  private ingress = new IngressListener()
  private provider: RemoteProvider | null = null
  private current: RemoteState = { kind: 'off' }
  private failures = 0
  private healthTimer: NodeJS.Timeout | undefined
  private consecutiveProbeFailures = 0

  /** Bumped by `enable()` (once it commits to doing real work — see the comment on `enable()`
   *  for why that is AFTER its idempotency check, not before) and by `disable()` (always,
   *  unconditionally, before any await). Every flow that awaits anything before touching
   *  shared state (`this.provider`, the ingress, or `set()`) captures the generation in force
   *  when IT started and re-checks it after each await; a mismatch means a newer
   *  disable()/enable() has superseded this flow, which must then do nothing further rather
   *  than mutate state it no longer owns.
   *
   *  This closes four interleavings the Phase 2 final review traced, all sharing one root
   *  cause — a flow that is no longer current still mutating shared state (ADR-422 final
   *  review, Important finding I1 plus the three previously-ledgered "cosmetic" races, two of
   *  which turned out NOT to be cosmetic: see the comments on `enable()`'s catch and
   *  `restart()`'s give-up branch below, both of which can tear a LIVE listener down into an
   *  unrecoverable `failed` state, not just mis-paint a status field).
   *
   *  This single counter supersedes the narrower `this.stopping` flag and (mostly) the
   *  `this.provider !== provider` identity checks the Task 7 fix round added for the same
   *  purpose. `watch()` keeps an ADDITIONAL identity check alongside the generation check,
   *  because it must also detect a same-generation provider replacement (a crash-restart
   *  within one connection's lifetime, which `restart()` deliberately does NOT bump the
   *  generation for) — something a generation number alone cannot distinguish. */
  private generation = 0

  constructor(private opts: RemoteAccessOptions) {}

  state(): RemoteState {
    return this.current
  }

  url(): string | null {
    return this.current.kind === 'connected' ? this.current.url : null
  }

  ingressPort(): number | undefined {
    return this.ingress.ingressPort()
  }

  /** The ingress listener's underlying http.Server once bound, or null (mirrors
   *  IngressListener.server). Exposed so cli.ts can wire the Code terminal's WebSocket
   *  upgrade handler onto it exactly as it already does for the main listener (ADR-422,
   *  Phase 1 Task 3's fix round) — cloudflared's local leg targets THIS server, not the
   *  main one, so without this a terminal session over the tunnel silently breaks. */
  get server() {
    return this.ingress.server
  }

  private set(s: RemoteState): void {
    this.current = s
    this.opts.onState?.(s)
  }

  /** Bring remote access up. Idempotent — a second call while connected, starting, OR
   *  reconnecting is a no-op, so the settings route can call it without tracking whether it is
   *  already running. `reconnecting` matters as much as the other two: it is the state
   *  `restart()` holds for its *entire* in-flight window — through its backoff wait and its own
   *  connect attempt — until it resolves to `connected` or `failed`. Without excluding it here,
   *  an `enable()` call arriving mid-backoff (e.g. the user clicking "enable" while a
   *  "reconnecting…" indicator is showing) would run a second, competing connect attempt
   *  concurrently with the pending restart (ADR-422 Task 7 fix round, Critical finding).
   *
   *  The generation counter is bumped AFTER this idempotency check, not before it, even though
   *  disable() bumps unconditionally at its very top. A genuinely no-op enable() call (state
   *  already connected/starting/reconnecting) must have ZERO side effects, including on the
   *  generation number: bumping it unconditionally here would invalidate whatever flow is
   *  currently in flight for no reason at all — concretely, a stray `enable()` call arriving
   *  during a pending restart()'s backoff wait would make that restart() see a generation
   *  mismatch once its timer fires and abandon a perfectly legitimate reconnection attempt,
   *  permanently stranding the manager in `reconnecting` with nothing left to retry it. */
  async enable(): Promise<void> {
    if (
      this.current.kind === 'connected' ||
      this.current.kind === 'starting' ||
      this.current.kind === 'reconnecting'
    ) {
      return
    }
    const gen = ++this.generation
    this.failures = 0
    this.set({ kind: 'starting' })

    const provider = this.opts.makeProvider()
    this.provider = provider

    // Preflight BEFORE binding anything: a provider that cannot run must report why in the
    // user's own terms, not fail halfway through with a stack trace (spec 30 §7.5).
    const pre = await provider.preflight()
    // A concurrent disable() (or, in principle, another enable() — though the idempotency
    // guard above makes that unreachable) may have superseded this flow while we awaited
    // preflight(). A stale flow does NOTHING further: no set(), and no touching
    // `this.provider` — whichever newer flow bumped the generation already owns both
    // (ADR-422 final review, ledgered race (c), reclassified from "cosmetic" to "must not
    // paint a stale verdict over a live state").
    if (gen !== this.generation) return
    if (pre.kind !== 'off') {
      this.provider = null
      this.set(pre)
      return
    }

    try {
      const port = await this.ingress.start(this.opts.app, this.opts.ingressPort)
      const { url } = await provider.start(port)
      if (gen !== this.generation) return // superseded while binding ingress / starting the provider
      this.failures = 0
      this.set({ kind: 'connected', url, since: new Date().toISOString() })
      this.watch(provider, gen)
      this.startHealthLoop(gen)
    } catch (e) {
      // ADR-422 final review, ledgered race (a): if a DIFFERENT, now-current flow already
      // rebuilt the ingress (a disable() then a fresh enable(), both of which ran while this
      // attempt awaited provider.start()), `await this.ingress.stop()` below would tear down
      // THAT live listener and stamp `failed` over a real `connected` state — one the manager
      // could then never self-heal from, since the health loop short-circuits on a null
      // `url()` while `failed`. Check the generation before calling stop() at all (so a stale
      // flow never touches shared infrastructure it doesn't own), and again after (in case a
      // disable()/enable() lands during the stop() call itself).
      if (gen !== this.generation) return
      await this.ingress.stop()
      if (gen !== this.generation) return
      this.set({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Take remote access down. Always awaits the provider's own stop — for a `system-state`
   *  provider that call is what un-exposes the box, so a fire-and-forget here would leave a
   *  disabled toggle sitting in front of a live public URL. Bumps the generation FIRST,
   *  unconditionally, before any await — this is what makes disable() authoritative over any
   *  flow already in flight, including a pending restart() sitting in its backoff wait
   *  (ADR-422 final review, Important finding I1). */
  async disable(): Promise<void> {
    this.generation++
    clearInterval(this.healthTimer)
    this.healthTimer = undefined
    const provider = this.provider
    this.provider = null
    if (provider) await provider.stop()
    await this.ingress.stop()
    this.set({ kind: 'off' })
  }

  /** Watch a child-process provider for an unexpected exit and restart it with backoff. `gen`
   *  is the generation captured by whichever enable()/restart() call successfully connected
   *  this `provider` — checked here IN ADDITION to the provider-identity check, because the
   *  two catch different kinds of staleness: `gen` mismatching means a disable()/enable()
   *  cycle has run since (this whole connection is over); `this.provider !== provider`
   *  mismatching means `restart()` already replaced this specific instance with a newer one
   *  WITHIN the same connection's lifetime (an earlier crash-restart), which the generation
   *  counter alone can't see since `restart()` deliberately does not bump it. */
  private watch(provider: RemoteProvider, gen: number): void {
    provider.onExit?.((code) => {
      if (gen !== this.generation || this.provider !== provider) return // a stop we asked for, or already superseded
      void this.restart(`provider exited (code ${code})`, gen)
    })
  }

  /** Poll the live public URL end-to-end. A single failed probe is not enough to act on — see
   *  health.ts's `nextHealthCheck` and `CONSECUTIVE_FAILURES_BEFORE_RESTART` (ADR-422 final
   *  review, Critical finding C1): only a run of consecutive failures is treated like an
   *  unexpected exit and restarted with backoff, because a lone blip (or an HTTP 429, which
   *  `probeUrl` already treats as healthy) must not cost a user their public URL.
   *
   *  `gen` is captured once, at the connection this loop was started for, and re-checked on
   *  every tick — belt-and-suspenders alongside `disable()`'s own `clearInterval` call, in
   *  case a future refactor ever lets a tick fire after teardown.
   *
   *  The final `restart(reason, gen)` call passes THIS closure's `gen` explicitly rather than
   *  letting `restart()` re-capture `this.generation` at call time (ADR-422 final-review fix
   *  wave, New Breakage N1). There is a real `await` — `provider.stop()` — between this
   *  callback's last generation check and the `restart()` call: a `disable()` landing during
   *  that await bumps `this.generation`, and without passing the ALREADY-STALE `gen` through,
   *  `restart()` would silently re-capture the NEW generation and proceed as if it were still
   *  current — resurrecting a tunnel the user just explicitly stopped. */
  private startHealthLoop(gen: number): void {
    clearInterval(this.healthTimer)
    this.consecutiveProbeFailures = 0
    this.healthTimer = setInterval(() => {
      if (gen !== this.generation) {
        clearInterval(this.healthTimer)
        return
      }
      const url = this.url()
      if (!url) return
      void this.opts.probe(url).then(async (ok) => {
        if (gen !== this.generation || this.url() !== url) return
        const result = nextHealthCheck(ok, this.consecutiveProbeFailures)
        this.consecutiveProbeFailures = result.consecutiveFailures
        // ADR-422 Phase 3 final-review fix-wave re-review, Minor finding: a successful
        // end-to-end probe is genuine evidence the connection is healthy — reset the
        // give-up counter here too, not only on a successful reconnect (restart()'s own
        // reset is gated to 'child-process', since start() succeeding proves nothing for
        // the other lifecycles; a real passing probe is not subject to that caveat). Without
        // this, `this.failures` was a lifetime count for 'system-state'/'none': a genuinely
        // healthy tunnel that hit ten separate, widely-spaced blips over a long uptime would
        // eventually report "gave up after 10 attempts" for an outage that never happened.
        if (ok) this.failures = 0
        if (!result.shouldRestart) return
        // ADR-422 Phase 3 final review, Important finding I2: calling provider.stop() here
        // purely because an end-to-end probe failed is only safe for 'child-process' — that
        // lifecycle's start() requires the child to print real evidence before resolving, so
        // a stop()-then-restart() cycle is a legitimate way to recover a genuinely wedged
        // child. For 'system-state' (Tailscale) it would issue a REAL `tailscale ... off`
        // purely on the strength of a probe that can fail for reasons that have nothing to do
        // with the tunnel itself (see health.ts's tailnet-reachability notes — userspace
        // networking and disabled MagicDNS make the daemon's own probe of its OWN tailnet URL
        // fail 100% of the time while the tunnel serves every other tailnet device fine), and
        // a false-negative probe must never tear down a working tailnet service. For 'none'
        // (custom) stop() is a guaranteed no-op anyway, since the user owns that tunnel. Only
        // an explicit, user-initiated disable() may ever issue the real reset command on the
        // strength of a health signal alone.
        if (this.provider?.lifecycle === 'child-process') {
          await this.provider.stop().catch(() => {})
        }
        void this.restart('health probe failed — the public URL stopped answering', gen)
      })
    }, HEALTH_INTERVAL_MS)
    this.healthTimer.unref()
  }

  /** Restart the current provider after an unexpected exit or a failed health probe. Part of
   *  the class's existing public surface (a caller may also use it to force a retry — in which
   *  case the default `gen = this.generation` is exactly right, since a manual caller has no
   *  staler generation to inherit).
   *
   *  `gen` is a PARAMETER, not something this function re-derives, because a caller can await
   *  something (health-loop's `provider.stop()`) between its own last generation check and this
   *  call — during which a disable()/enable() cycle can run to completion and bump
   *  `this.generation`. If `restart()` re-captured `this.generation` itself at entry, it would
   *  silently adopt the NEW generation and proceed as if this call were still current
   *  (ADR-422 final-review fix wave, New Breakage N1 — a `--stop` landing in that window could
   *  resurrect the tunnel the user just explicitly stopped). Every synchronous caller (`watch()`,
   *  this function's own catch-recursion) passes the exact `gen` it already validated, which is
   *  a no-op change for them; only the health loop's await makes this distinction load-bearing.
   *
   *  Checked as the FIRST statement, before `this.failures++` — a stale call must not perturb
   *  the CURRENT flow's failure/backoff bookkeeping either. Does NOT bump the generation itself
   *  — a crash-restart is part of the SAME logical connection from the user's point of view, not
   *  a new one — and re-checks after every subsequent await before touching shared state. This
   *  is exactly the interleaving ADR-422's final review traced as Important finding I1:
   *  `disable()` can run while this call is parked in its backoff wait, and — pre-fix — a
   *  subsequent `enable()` reset the `stopping` flag this function used to check, so the stale
   *  timer fired anyway and either leaked an untracked provider `disable()` could no longer
   *  stop, or fought the new connection for `this.provider` / the ingress. */
  async restart(reason: string, gen: number = this.generation): Promise<void> {
    if (gen !== this.generation) return // already stale at entry — see the health-loop note above
    this.failures++
    // ADR-422 Phase 3 final-review fix-wave re-review, Important finding: giving up and
    // tearing down the ingress must be gated the SAME way the stop()-on-probe-failure call
    // above it is (health loop, further up in this file) — only 'child-process', where a
    // failed probe/exit is real evidence the tunnel is actually dead. For 'system-state'
    // (Tailscale) the identical probe signal can be a 100% false negative in a userspace-
    // networking deployment (the daemon's own probe of its OWN tailnet URL can never
    // succeed there, while the tunnel serves every other tailnet device fine) — treating
    // that as terminal would tear down a working ingress and strand the tailnet serve
    // pointed at a now-dead port with no automatic recovery. For 'none' (custom) the user
    // owns the tunnel entirely; restarting it re-reads their config but proves nothing
    // either way, so a probe failure there is equally uninformative. Both lifecycles instead
    // fall through to the same backoff-and-retry path below, forever, at the 60s-capped
    // cadence backoff.ts already documents as the intended behavior for "upstream is down".
    if (this.provider?.lifecycle === 'child-process' && this.failures > MAX_CONSECUTIVE_FAILURES) {
      // ADR-422 final review, ledgered race (b) — the same shape as enable()'s catch above:
      // never tear down a different, now-current flow's live listener just because THIS
      // flow is giving up. (No re-check needed before this branch: the top-of-function check
      // above already covers it, since nothing awaits between entry and here.)
      await this.ingress.stop()
      if (gen !== this.generation) return
      this.set({ kind: 'failed', reason: `gave up after ${MAX_CONSECUTIVE_FAILURES} attempts: ${reason}` })
      return
    }
    this.set({ kind: 'reconnecting', attempt: this.failures, lastError: reason })
    await new Promise((r) => setTimeout(r, backoffDelay(this.failures - 1)))
    // The exact I1 interleaving: a disable() then a fresh enable() may have run to completion
    // during this wait. A stale restart must not touch the ingress or `this.provider` at all
    // — the new enable() already owns both.
    if (gen !== this.generation) return

    const provider = this.opts.makeProvider()
    this.provider = provider
    try {
      const port = this.ingress.ingressPort() ?? (await this.ingress.start(this.opts.app, this.opts.ingressPort))
      const { url } = await provider.start(port)
      if (gen !== this.generation) return
      // ADR-422 Phase 3 final review, Important finding I2: start() succeeding is only real
      // evidence of reachability for a 'child-process' provider — spawnAndWait requires the
      // child to print concrete proof (a real URL) before resolving. For 'system-state' and
      // 'none', start() trivially succeeds regardless of whether the tunnel is actually
      // reachable (Tailscale's start() just re-issues `serve`/`funnel`; custom's start() is
      // `this.started = true; return {url}`), so resetting the failure streak here would make
      // the terminal `failed` state structurally unreachable for those lifecycles no matter
      // how many times the probe keeps failing. Leaving the streak to accumulate across
      // repeated probe-driven restarts is what makes `failed` reachable within
      // MAX_CONSECUTIVE_FAILURES attempts once a tunnel is genuinely unreachable.
      if (provider.lifecycle === 'child-process') this.failures = 0
      this.set({ kind: 'connected', url, since: new Date().toISOString() })
      this.watch(provider, gen)
    } catch (e) {
      if (gen !== this.generation) return
      void this.restart(e instanceof Error ? e.message : String(e), gen)
    }
  }
}
