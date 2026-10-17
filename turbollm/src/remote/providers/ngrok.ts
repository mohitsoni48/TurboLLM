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

/** A random URL ngrok assigns when no reserved domain is configured. */
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
    // over the terminal with its TUI and prints nothing a parent process can read. The
    // authtoken travels via env(), not here — see its doc comment.
    const args = ['http', String(ingressPort), '--log', 'stdout']
    const host = this.domainHost()
    if (host) args.push('--domain', host)
    return args
  }

  /** The reserved domain as a bare host, whether it was entered as one or as a URL. The
   *  Settings field does not say "host only", and ngrok's own help gives the --url that
   *  replaces --domain as a full URL, so "https://llm.ngrok.app/" is a likely entry; matched
   *  as stored it made urlPattern() look for https://https://..., which never appears. */
  private domainHost(): string {
    return this.cfg.domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  }

  /** The authtoken as an env var, never argv: argv is readable by any local user via
   *  `/proc/<pid>/cmdline` (or Task Manager), an env var scoped to this one child is not.
   *  `NGROK_AUTHTOKEN` is ngrok's own documented equivalent to `--authtoken`. */
  env(): NodeJS.ProcessEnv {
    return { NGROK_AUTHTOKEN: this.cfg.authtoken }
  }

  /** What start() waits for in ngrok's log. With a reserved domain the tunnel is served on
   *  exactly that host, and NGROK_URL_RE (ngrok's own hosts, one label deep) never matches a
   *  custom one such as llm.example.com: that start always ran into the 30 s timeout and
   *  ended `failed`. So match the domain itself, and only as the `url=` of ngrok's "started
   *  tunnel" line, since an error can name it too ("The endpoint 'https://<domain>' is
   *  already online" while another ngrok agent holds it). */
  urlPattern(): RegExp {
    const domain = this.domainHost()
    if (!domain) return NGROK_URL_RE
    const host = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<=\\burl=)https://${host}(?![a-z0-9.-])`, 'i')
  }

  async start(ingressPort: number): Promise<{ url: string }> {
    const { binPath } = await ensureNgrok(this.dataDir)
    const url = await this.child.spawnAndWait(binPath, this.argv(ingressPort), this.urlPattern(), 30_000, this.env())
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
