// The dedicated loopback ingress listener (ADR-422, spec 30 §2.1). Every remote-access
// provider's local leg connects here and nothing else does, which is what makes
// auth.ts's isTunneled a property of the socket rather than of a forgeable header.
//
// Bound to 127.0.0.1 explicitly, never 0.0.0.0: this port is reachable only by a provider
// running on this box. Exposing it on the LAN would create a second, unauthenticated-looking
// door into the same app.
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import type { RemoteIngress } from './ingress-types'

type Server = ReturnType<typeof serve>

export class IngressListener implements RemoteIngress {
  private server: Server | null = null
  private port: number | undefined

  ingressPort(): number | undefined {
    return this.port
  }

  /** Bind the ingress listener, resolving with the port actually bound. Idempotent:
   *  replaces any prior listener first, so a provider or port change is safe to re-apply.
   *  Rejects (leaving nothing bound) if the port is unavailable — spec 30 §2.1 requires a
   *  precise failure here rather than a silent fallback to a random port, since a surprise
   *  port would silently break isTunneled's whole premise. */
  async start(app: Hono, port: number): Promise<number> {
    await this.stop()
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
        if (settled) return
        settled = true
        this.server = s
        this.port = info.port
        resolve(info.port)
      })
      ;(s as unknown as { on?: (ev: 'error', cb: (e: Error) => void) => void }).on?.('error', (e) => {
        if (settled) return
        settled = true
        this.server = null
        this.port = undefined
        reject(e)
      })
    })
  }

  async stop(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = null
    this.port = undefined
    await new Promise<void>((resolve) => {
      try {
        ;(s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      } catch {
        /* best-effort */
      }
      s.close(() => resolve())
      setTimeout(resolve, 3_000).unref() // never hang a shutdown on a stuck stream
    })
  }
}
