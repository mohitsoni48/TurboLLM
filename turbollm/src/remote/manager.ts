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

  /** Bring remote access up. Idempotent — a second call while connected is a no-op, so the
   *  settings route can call it without tracking whether it is already running. */
  async enable(): Promise<void> {
    if (this.current.kind === 'connected' || this.current.kind === 'starting') return
    this.stopping = false
    this.failures = 0
    this.set({ kind: 'starting' })

    const provider = this.opts.makeProvider()
    this.provider = provider

    // Preflight BEFORE binding anything: a provider that cannot run must report why in the
    // user's own terms, not fail halfway through with a stack trace (spec 30 §7.5).
    const pre = await provider.preflight()
    if (pre.kind !== 'off') {
      this.set(pre)
      return
    }

    try {
      const port = await this.ingress.start(this.opts.app, this.opts.ingressPort)
      const { url } = await provider.start(port)
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
      this.failures = 0
      this.set({ kind: 'connected', url, since: new Date().toISOString() })
      this.watch(provider)
    } catch (e) {
      void this.restart(e instanceof Error ? e.message : String(e))
    }
  }
}
