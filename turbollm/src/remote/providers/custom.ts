// "I run my own tunnel" (spec 30 §3.6).
//
// This is what keeps the provider list finite. frp, rathole, zrok, Pinggy, localhost.run, a
// VPS behind nginx — each would be its own integration and its own maintenance burden, for a
// population that is already comfortable running the thing themselves. They point their own
// tunnel at the ingress port and tell us the URL.
//
// Auth and trust behaviour is IDENTICAL to every other provider, because isTunneled keys off
// the ingress socket (ADR-422), not off which provider is configured.
import type { PreflightState, RemoteProvider } from '../types'

export class CustomProvider implements RemoteProvider {
  readonly id = 'custom' as const
  readonly lifecycle = 'none' as const
  private started = false

  constructor(private cfg: { publicUrl: string }) {}

  async preflight(): Promise<PreflightState> {
    if (!this.cfg.publicUrl) {
      return { kind: 'needs-setup', reason: 'Enter the public URL your own tunnel serves this machine on.' }
    }
    let u: URL
    try {
      u = new URL(this.cfg.publicUrl)
    } catch {
      return { kind: 'needs-setup', reason: 'That is not a valid URL — include https:// at the start.' }
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { kind: 'needs-setup', reason: 'The URL must start with https:// (or http:// on a trusted network).' }
    }
    return { kind: 'off' }
  }

  async start(_ingressPort: number): Promise<{ url: string }> {
    this.started = true
    return { url: this.cfg.publicUrl.replace(/\/+$/, '') }
  }

  async stop(): Promise<void> {
    this.started = false
  }

  alive(): boolean {
    return this.started
  }
}
