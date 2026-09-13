// ngrok (spec 30 §3.5).
//
// Its free tier is genuinely poor for this use and the UI must say so before a user picks it:
// sessions are capped at 2 hours, and an interstitial page is shown in front of all HTML
// browser traffic — which means in front of the TurboLLM web UI itself. Realistically this is
// a paid-plan option. That belongs on the provider card, not buried in a log line.
import { ChildTunnel } from '../child-process'
import { ensureNgrok } from './ngrok-provision'
import type { PreflightState, RemoteProvider } from '../types'

export { ngrokAssetUrl } from './ngrok-provision'

export const NGROK_URL_RE = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|dev|io)/

export interface NgrokConfig {
  authtoken: string
  domain: string
}

export class NgrokProvider implements RemoteProvider {
  readonly id = 'ngrok' as const
  readonly lifecycle = 'child-process' as const
  private child: ChildTunnel

  constructor(
    private dataDir: string,
    private cfg: NgrokConfig,
  ) {
    this.child = new ChildTunnel(dataDir)
  }

  async preflight(): Promise<PreflightState> {
    if (!this.cfg.authtoken) {
      return { kind: 'needs-setup', reason: 'Paste your ngrok authtoken from the ngrok dashboard.' }
    }
    return { kind: 'off' }
  }

  argv(ingressPort: number): string[] {
    // --log stdout is what makes the assigned URL parseable at all; without it ngrok takes
    // over the terminal with its TUI and prints nothing a parent process can read.
    const args = ['http', String(ingressPort), '--authtoken', this.cfg.authtoken, '--log', 'stdout']
    if (this.cfg.domain) args.push('--domain', this.cfg.domain)
    return args
  }

  async start(ingressPort: number): Promise<{ url: string }> {
    const { binPath } = await ensureNgrok(this.dataDir)
    const url = await this.child.spawnAndWait(binPath, this.argv(ingressPort), NGROK_URL_RE)
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
