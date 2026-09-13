// The zero-setup default (spec 30 §3.1). Mechanism unchanged from ADR-153; what changed is
// that it is now one provider among several rather than the only thing that exists.
//
// Its documented limits are real and belong in the UI, not hidden here: 200 in-flight
// requests (429 beyond), no SLA, a URL re-rolled on every start, and Cloudflare's own
// "Quick Tunnels do not support Server-Sent Events" line — which spec 30 T-12 settles by
// experiment rather than assumption.
import { ensureCloudflared } from '../../tunnel/provision'
import { ChildTunnel } from '../child-process'
import type { PreflightState, RemoteProvider } from '../types'

export const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export class CloudflareQuickProvider implements RemoteProvider {
  readonly id = 'cloudflare-quick' as const
  readonly lifecycle = 'child-process' as const
  private child: ChildTunnel

  constructor(private dataDir: string) {
    this.child = new ChildTunnel(dataDir)
  }

  /** Always ready: no account, no token, nothing to configure. The binary is downloaded on
   *  demand by start(), so a missing cloudflared is a start-time failure with a real download
   *  error, not a preflight refusal the user can do nothing about. */
  async preflight(): Promise<PreflightState> {
    return { kind: 'off' }
  }

  argv(ingressPort: number): string[] {
    return ['tunnel', '--url', `http://127.0.0.1:${ingressPort}`]
  }

  async start(ingressPort: number): Promise<{ url: string }> {
    const { binPath } = await ensureCloudflared(this.dataDir)
    const url = await this.child.spawnAndWait(binPath, this.argv(ingressPort), QUICK_URL_RE)
    return { url }
  }

  stop(): Promise<void> {
    return this.child.stop()
  }

  alive(): boolean {
    return this.child.alive()
  }

  onExit(cb: (code: number | null) => void): void {
    this.child.onExit(cb)
  }
}
