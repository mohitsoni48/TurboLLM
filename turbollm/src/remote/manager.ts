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
import type { RemoteProvider, RemoteState } from './types'

export interface RemoteAccessOptions {
  app: Hono
  /** The loopback port to bind. 0 asks the OS for an ephemeral one (tests only). */
  ingressPort: number
  makeProvider: () => RemoteProvider
  /** End-to-end reachability check against the live public URL. Injected so tests never
   *  make a real network call; production passes the probe from Task 8. */
  probe: (url: string) => Promise<boolean>
  /** Called whenever the state changes, so the API/UI can observe transitions. */
  onState?: (s: RemoteState) => void
}

export class RemoteAccessManager implements RemoteIngress {
  private ingress = new IngressListener()
  private provider: RemoteProvider | null = null
  private current: RemoteState = { kind: 'off' }
  private failures = 0
  private stopping = false

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
   *  concurrently with the pending restart: both would assign `this.provider`, both would race
   *  unguarded on the shared `IngressListener`, and whichever's `provider.start()` resolved last
   *  would win `state()` regardless of which provider was actually alive — silently disabling
   *  future crash-detection for the connection actually in use (ADR-422 Task 7 fix round,
   *  Critical finding). The simplest correct behavior is to let the pending restart continue
   *  undisturbed, exactly like the `connected`/`starting` no-ops already do. */
  async enable(): Promise<void> {
    if (
      this.current.kind === 'connected' ||
      this.current.kind === 'starting' ||
      this.current.kind === 'reconnecting'
    ) {
      return
    }
    this.stopping = false
    this.failures = 0
    this.set({ kind: 'starting' })

    const provider = this.opts.makeProvider()
    this.provider = provider

    // Preflight BEFORE binding anything: a provider that cannot run must report why in the
    // user's own terms, not fail halfway through with a stack trace (spec 30 §7.5).
    const pre = await provider.preflight()
    if (pre.kind !== 'off') {
      // This provider's start() was never called — don't leave it as `this.provider`, or a
      // later disable() will call .stop() on an instance that never started (ADR-422 Task 7
      // fix round, Important finding). Guard on identity rather than unconditionally nulling,
      // matching the guard watch()'s own exit callback uses, in case a concurrent disable()
      // already claimed `this.provider` for something else while we were awaiting preflight().
      if (this.provider === provider) this.provider = null
      this.set(pre)
      return
    }

    try {
      const port = await this.ingress.start(this.opts.app, this.opts.ingressPort)
      const { url } = await provider.start(port)
      // A concurrent flow (disable(), or — pre-fix — a competing enable()/restart()) may have
      // already superseded this provider while we were awaiting start(). Only the flow whose
      // provider is still the tracked one gets to report success and re-arm watch(), mirroring
      // the identity check watch()'s own exit callback already uses.
      if (this.provider !== provider) return
      this.failures = 0
      this.set({ kind: 'connected', url, since: new Date().toISOString() })
      this.watch(provider)
    } catch (e) {
      await this.ingress.stop()
      this.set({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Take remote access down. Always awaits the provider's own stop — for a `system-state`
   *  provider that call is what un-exposes the box, so a fire-and-forget here would leave a
   *  disabled toggle sitting in front of a live public URL. */
  async disable(): Promise<void> {
    this.stopping = true
    const provider = this.provider
    this.provider = null
    if (provider) await provider.stop()
    await this.ingress.stop()
    this.set({ kind: 'off' })
  }

  /** Watch a child-process provider for an unexpected exit and restart it with backoff. */
  private watch(provider: RemoteProvider): void {
    const withExit = provider as RemoteProvider & { onExit?: (cb: (code: number | null) => void) => void }
    withExit.onExit?.((code) => {
      if (this.stopping || this.provider !== provider) return // a stop we asked for
      void this.restart(`provider exited (code ${code})`)
    })
  }

  /** Restart the current provider after an unexpected exit or a failed health probe. */
  async restart(reason: string): Promise<void> {
    if (this.stopping) return
    this.failures++
    if (this.failures > MAX_CONSECUTIVE_FAILURES) {
      await this.ingress.stop()
      this.set({ kind: 'failed', reason: `gave up after ${MAX_CONSECUTIVE_FAILURES} attempts: ${reason}` })
      return
    }
    this.set({ kind: 'reconnecting', attempt: this.failures, lastError: reason })
    await new Promise((r) => setTimeout(r, backoffDelay(this.failures - 1)))
    if (this.stopping) return

    const provider = this.opts.makeProvider()
    this.provider = provider
    try {
      const port = this.ingress.ingressPort() ?? (await this.ingress.start(this.opts.app, this.opts.ingressPort))
      const { url } = await provider.start(port)
      // Same identity check as enable()'s success path: a concurrent disable() may have
      // superseded this provider while start() was in flight, so only report success and
      // re-arm watch() when this is still the tracked provider (ADR-422 Task 7 fix round).
      if (this.provider !== provider) return
      this.failures = 0
      this.set({ kind: 'connected', url, since: new Date().toISOString() })
      this.watch(provider)
    } catch (e) {
      // No identity check needed here: the only way `this.provider` could have changed out
      // from under us by now is a concurrent disable(), which always sets `stopping = true`
      // first — and this recursive restart() call's own top-of-function check already bails
      // on that before doing anything else.
      void this.restart(e instanceof Error ? e.message : String(e))
    }
  }
}
