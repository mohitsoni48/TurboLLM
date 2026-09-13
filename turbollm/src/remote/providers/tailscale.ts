// Tailscale Serve and Funnel (spec 30 §3.3, §3.4).
//
// THE LIFECYCLE IS DIFFERENT AND THAT IS THE WHOLE POINT. `tailscale serve --bg` mutates the
// tailscaled daemon's PERSISTENT config. We own no child process, nothing dies when we exit,
// and the pidfile orphan-safety net does not apply. Consequently:
//   - stop() must issue a real `off` command; dropping a handle changes nothing;
//   - startup must reconcile a serve left behind by an unclean exit (reconcileTailscale).
// Skip either and disabling the toggle leaves the box exposed — a silent, durable failure and
// the worst thing this feature could do.
//
// TWO DIFFERENT PORTS, never conflate them (spec 30 §3.4):
//   - `port` here is Tailscale's PUBLIC port, restricted by Tailscale to 443/8443/10000;
//   - `ingressPort` is the LOCAL target it forwards to, and is unrestricted.
//
// Serve is tailnet-only and injects Tailscale-User-Login identity headers. Funnel is public
// and deliberately injects none — Tailscale's own security choice, since public traffic is
// unauthenticated and there is no identity to assert. Phase 5 relies on exactly that split.
import { execFile } from 'node:child_process'
import type { PreflightState, RemoteProvider } from '../types'

export type TailscalePublicPort = 443 | 8443 | 10000

/** Injected so tests never shell out. Returns the exit code and stdout; a missing binary
 *  must REJECT so preflight can distinguish "not installed" from "installed and unhappy". */
export type RunTailscale = (args: string[]) => Promise<{ code: number; stdout: string }>

export const runTailscale: RunTailscale = (args) =>
  new Promise((resolve, reject) => {
    execFile('tailscale', args, { windowsHide: true }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err)
      resolve({ code: err ? 1 : 0, stdout: stdout ?? '' })
    })
  })

export function parseTailscaleStatus(json: string): { running: boolean; dnsName: string } {
  try {
    const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string } }
    return {
      running: s.BackendState === 'Running',
      // MagicDNS names come back fully-qualified with a trailing dot. Strip it — never
      // string-build the hostname from a tailnet name, which is a different value.
      dnsName: (s.Self?.DNSName ?? '').replace(/\.$/, ''),
    }
  } catch {
    return { running: false, dnsName: '' }
  }
}

abstract class TailscaleProvider implements RemoteProvider {
  abstract readonly id: 'tailscale-serve' | 'tailscale-funnel'
  readonly lifecycle = 'system-state' as const
  protected abstract readonly subcommand: 'serve' | 'funnel'
  private started = false

  constructor(
    protected cfg: { port: TailscalePublicPort },
    protected run: RunTailscale = runTailscale,
  ) {}

  async preflight(): Promise<PreflightState> {
    let out: { code: number; stdout: string }
    try {
      out = await this.run(['status', '--json'])
    } catch {
      return {
        kind: 'unavailable',
        reason: 'Tailscale is not installed on this machine. Install it, then check again.',
      }
    }
    const status = parseTailscaleStatus(out.stdout)
    if (!status.running) {
      return { kind: 'needs-setup', reason: 'Tailscale is installed but not logged in — run `tailscale up`, then check again.' }
    }
    if (!status.dnsName) {
      return { kind: 'needs-setup', reason: 'Tailscale reported no MagicDNS name for this machine. Enable MagicDNS in your tailnet.' }
    }
    return { kind: 'off' }
  }

  async start(ingressPort: number): Promise<{ url: string }> {
    const { stdout } = await this.run(['status', '--json'])
    const { dnsName } = parseTailscaleStatus(stdout)
    if (!dnsName) throw new Error('Tailscale reported no MagicDNS name for this machine')
    await this.run([this.subcommand, '--bg', `--https=${this.cfg.port}`, `http://127.0.0.1:${ingressPort}`])
    this.started = true
    const suffix = this.cfg.port === 443 ? '' : `:${this.cfg.port}`
    return { url: `https://${dnsName}${suffix}` }
  }

  /** Issues a real reset. This is not symmetry-for-its-own-sake: without it the box stays
   *  exposed after the user turns remote access off. */
  async stop(): Promise<void> {
    this.started = false
    await this.run([this.subcommand, `--https=${this.cfg.port}`, 'off']).catch(() => undefined)
  }

  /** There is no process of ours to be alive. "Alive" means "we issued a serve and have not
   *  reset it"; genuine reachability is the supervisor's end-to-end health probe's job. */
  alive(): boolean {
    return this.started
  }
}

export class TailscaleServeProvider extends TailscaleProvider {
  readonly id = 'tailscale-serve' as const
  protected readonly subcommand = 'serve' as const
}

export class TailscaleFunnelProvider extends TailscaleProvider {
  readonly id = 'tailscale-funnel' as const
  protected readonly subcommand = 'funnel' as const
}

/** Startup reconciliation for the system-state lifecycle. If config says remote access is OFF
 *  but a previous unclean exit left a serve/funnel running, turn it off. Returns whether it
 *  acted. Silent no-op for every other provider — nothing to reconcile when we own the child.
 *
 *  Called once at startup beside reapStaleTunnels, which is the child-process equivalent of
 *  this same idea. */
export async function reconcileTailscale(
  cfg: { enabled: boolean; provider: string; port: TailscalePublicPort },
  run: RunTailscale = runTailscale,
): Promise<boolean> {
  if (cfg.enabled) return false
  if (cfg.provider !== 'tailscale-serve' && cfg.provider !== 'tailscale-funnel') return false
  const sub = cfg.provider === 'tailscale-serve' ? 'serve' : 'funnel'
  try {
    await run([sub, `--https=${cfg.port}`, 'off'])
    return true
  } catch {
    return false // Tailscale gone entirely — nothing left exposed by us either
  }
}
