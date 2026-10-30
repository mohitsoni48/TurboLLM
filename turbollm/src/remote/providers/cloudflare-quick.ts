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

/** The tunnel's own URL, as cloudflared prints it inside its "Your quick Tunnel has been
 *  created!" box (`INF |  https://<random-words>.trycloudflare.com    |`). Not just any
 *  trycloudflare.com URL in the output: cloudflared asks for a tunnel by POSTing to
 *  https://api.trycloudflare.com/tunnel, and offline or behind a firewall it prints that URL
 *  and exits (`failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel":
 *  dial tcp: lookup api.trycloudflare.com ...`). Taking that for the tunnel URL showed
 *  'connected', and every exit then "reconnected" within a second, which reset the give-up
 *  count, so the manager never reached 'failed'. So the host is never `api`, the URL must end
 *  at whitespace (not run on into a path or a closing quote), and a line carrying ERR, error or
 *  failed before it never counts. */
export const QUICK_URL_RE =
  /(?<!\b(?:ERR|error|failed)\b[^\n]*)https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com(?=\s)/i

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
