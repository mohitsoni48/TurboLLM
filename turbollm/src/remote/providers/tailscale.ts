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
import { execFile, type ExecFileException } from 'node:child_process'
import type { PreflightState, RemoteProvider } from '../types'

export type TailscalePublicPort = 443 | 8443 | 10000

/** Injected so tests never shell out. Returns the exit code, stdout AND stderr. A missing
 *  binary must REJECT so preflight can distinguish "not installed" from "installed and
 *  unhappy" — but every OTHER failure resolves normally, and `code`/`stderr` must actually be
 *  read by every caller (ADR-422 Phase 3 final review, finding I3): before this fix, `code`
 *  was returned but nothing in this file ever branched on it, so a permission refusal (Linux/
 *  macOS require `tailscale set --operator=$USER` for an unprivileged `serve`/`funnel`), a
 *  rejected Funnel approval, or any other non-ENOENT CLI failure silently reported success. */
export type RunTailscale = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

// Bounds how long a single `tailscale` invocation can hang boot or a request. Previously
// unbounded, so a wedged tailscaled would hang `reconcileTailscale` — which cli.ts awaits
// BEFORE writing the pidfile on a fresh boot — forever, leaving a daemon `--stop` can never
// find because it never got that far. Every subcommand this file runs (`status`, `serve`,
// `funnel`, `--bg`) talks to the LOCAL tailscaled over its own socket, not the network, so
// 10s is generous rather than tight.
const TAILSCALE_TIMEOUT_MS = 10_000

export const runTailscale: RunTailscale = (args) =>
  new Promise((resolve, reject) => {
    execFile('tailscale', args, { windowsHide: true, timeout: TAILSCALE_TIMEOUT_MS }, (err: ExecFileException | null, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(err)
      // execFile's error.code carries the real process exit code for a non-spawn failure
      // (it is only ever a STRING like 'ENOENT' when the process failed to spawn at all,
      // which is handled above) — surface the real number rather than collapsing every
      // failure to a hardcoded 1, so a caller that wants to branch on the specific code can.
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })

/** A non-zero exit's message for the user/log: prefer the CLI's own stderr (Tailscale's CLI
 *  reports real reasons there — a permission refusal, a rejected Funnel grant), falling back
 *  to a generic line only when the CLI failed silently. */
function describeTailscaleFailure(subcommand: string, stderr: string): string {
  const text = stderr.trim()
  return text ? `tailscale ${subcommand} failed: ${text}` : `tailscale ${subcommand} exited with a non-zero status`
}

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
    let out: { code: number; stdout: string; stderr: string }
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
    const result = await this.run([this.subcommand, '--bg', `--https=${this.cfg.port}`, `http://127.0.0.1:${ingressPort}`])
    if (result.code !== 0) {
      // ADR-422 Phase 3 final review, finding I3: this is the concrete mechanism that used to
      // let a rejected Funnel approval or a permission refusal report a fabricated
      // `connected`. Throwing here routes into enable()'s/restart()'s existing catch block
      // (manager.ts), which already sets `failed` with the real reason — nothing about that
      // error-handling path needed to change, only that this method now actually reaches it.
      //
      // Spec 30 §3.4 also asks that a pending Funnel approval report `needs-setup`, not
      // `failed`. Attempted and NOT implemented here: Tailscale's own CLI source
      // (cmd/tailscale/cli/serve_legacy.go's enableFeatureInteractive, read 2026-09-13) shows
      // this has no reliable stderr signature to match at all — when the tailnet has not
      // granted the capability and `info.ShouldWait` is false, the CLI prints a dynamic,
      // control-server-supplied message to STDOUT (not stderr) and then calls os.Exit(0), so
      // the failure would not even reach this branch (exit code 0, no serve config was ever
      // written). When `ShouldWait` is true, the CLI instead BLOCKS waiting for browser
      // approval, which would hang this call rather than fail it. Neither case has a stable
      // string to pattern-match, so implementing this would mean shipping an unverified
      // guess — see the fix report for the full citation. Filed as a follow-up requiring a
      // real tailnet to observe the actual behavior live.
      throw new Error(describeTailscaleFailure(this.subcommand, result.stderr))
    }
    this.started = true
    const suffix = this.cfg.port === 443 ? '' : `:${this.cfg.port}`
    return { url: `https://${dnsName}${suffix}` }
  }

  /** Issues a real reset. This is not symmetry-for-its-own-sake: without it the box stays
   *  exposed after the user turns remote access off. Must never throw — disable() (manager.ts)
   *  has to be able to complete unconditionally — but a genuine failure here is not silently
   *  swallowed either: it is at least logged, so it is not indistinguishable from success in
   *  every observable way (ADR-422 Phase 3 final review, finding I3). */
  async stop(): Promise<void> {
    this.started = false
    const subcommand = this.subcommand
    const port = this.cfg.port
    try {
      const result = await this.run([subcommand, `--https=${port}`, 'off'])
      if (result.code !== 0) {
        console.warn(`tailscale ${subcommand} --https=${port} off: ${describeTailscaleFailure(subcommand, result.stderr)}`)
      }
    } catch (e) {
      console.warn(
        `tailscale ${subcommand} --https=${port} off failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
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

// --- Startup reconciliation (ADR-422 Phase 3 final review, finding I1) ---------------------
//
// `tailscale serve status --json` / `tailscale funnel status --json` are wired to the exact
// same handler in Tailscale's own CLI: `cmd/tailscale/cli/serve_v2.go`'s `newServeV2Command`
// is a single constructor used for BOTH `serve` and `funnel` (it `log.Fatalf`s unless told
// which of the two it is being built for) and registers one `status` subcommand with
// `Exec: e.runServeStatus` (defined in `serve_legacy.go`) either way — read 2026-09-13,
// tailscale/tailscale @ main, because neither CLI reference page documents the JSON shape at
// all: the `serve` reference page states outright that "`tailscale serve status` and
// `tailscale serve status --json` return different information" without saying what the
// latter is. (`funnel.go`'s own `newFunnelCommand`, which historically registered this
// separately, is dead code kept only for an easy revert per its own TODO-to-delete comment —
// `funnel.go:31` just forwards to `newServeV2Command(se, funnel)`.) Both commands just
// `json.MarshalIndent` the raw `*ipn.ServeConfig` fetched from `GetServeConfig`. The fields
// this module reads, per `ipn/serve.go`:
//
//   type ServeConfig struct {
//     Web         map[HostPort]*WebServerConfig `json:",omitempty"` // "$SNI_NAME:$PORT" -> handlers
//     AllowFunnel map[HostPort]bool             `json:",omitempty"` // which of the above are public
//     ...
//   }
//   type WebServerConfig struct { Handlers map[string]*HTTPHandler } // mountPoint -> handler
//   type HTTPHandler struct { Proxy string `json:",omitempty"`; ... }
//
// `HTTPHandler.Proxy` is verified to round-trip an already-schemed target UNCHANGED: it is
// produced by `ipn.ExpandProxyTargetValue(target, ...)`, which for an input already in
// `scheme://host:port` form (exactly what this file's own `start()` sends —
// `http://127.0.0.1:<ingressPort>`) just reassembles `u.Host = net.JoinHostPort(host, port)`
// and returns `u.String()` — no added trailing slash, no reordering. That is what makes a
// plain string-equality check below safe, rather than a fuzzy port-number regex that could
// also match a `tailscale serve` the user runs for something of their own on the same port
// number against a different target — precisely the false-positive direction I1 named.
interface TailscaleServeConfigJSON {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | null | undefined> } | null | undefined> | null
  AllowFunnel?: Record<string, boolean> | null
}

/** If the observed serve config currently forwards SOME public host:port to our own local
 *  ingress target, return that host:port's numeric port and whether Funnel is on for it.
 *  Returns null when nothing observed targets us — including when status can't be parsed, in
 *  which case doing nothing is the safe default (never guess and issue `off` blind). */
function findServedIngress(statusJson: string, ingressPort: number): { port: number; funnel: boolean } | null {
  let sc: TailscaleServeConfigJSON
  try {
    sc = JSON.parse(statusJson) as TailscaleServeConfigJSON
  } catch {
    return null
  }
  const target = `http://127.0.0.1:${ingressPort}`
  for (const [hostPort, web] of Object.entries(sc.Web ?? {})) {
    const handlers = web?.Handlers ?? {}
    const isOurs = Object.values(handlers).some((h) => h?.Proxy === target)
    if (!isOurs) continue
    const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    return { port, funnel: sc.AllowFunnel?.[hostPort] === true }
  }
  return null
}

/** Startup reconciliation for the system-state lifecycle: turn off any serve/funnel that is
 *  CURRENTLY OBSERVED to forward our ingress port, regardless of what config currently says
 *  (spec 30 §2.3 — "if config says off but `tailscale status --json` shows our ingress port
 *  still served, turn it off"). Returns whether it acted.
 *
 *  Deliberately does NOT gate on `remoteAccess.enabled` or `.provider` (ADR-422 Phase 3 final
 *  review, finding I1) — the previous config-keyed version had a false negative in three
 *  reachable states (switching the provider away from Tailscale, turning the experimental
 *  flag off while `enabled: true` is still persisted, and editing `tailscale.port` while the
 *  daemon was down all left a stale funnel permanently un-reconciled) and a false positive
 *  (it turned off whatever was on the configured port, including a `tailscale serve` the user
 *  runs for something unrelated). Keying off the OBSERVED proxy target instead — an exact
 *  match against `http://127.0.0.1:<ingressPort>`, the one string this daemon could ever have
 *  written — closes both directions at once. It is safe to run unconditionally at every
 *  startup because it runs BEFORE the supervisor's own `enable()` (cli.ts): if config and the
 *  experimental flag really do want this exact provider running, `enable()` re-issues the
 *  identical `serve`/`funnel --bg` command moments later, so this is at worst a redundant
 *  off-then-on with no observable gap (mirrors `reapStaleTunnels`' unconditional cleanup of
 *  orphaned child-process tunnels, which has the same "let the real owner reassert" shape). */
export async function reconcileTailscale(ingressPort: number, run: RunTailscale = runTailscale): Promise<boolean> {
  let status: { code: number; stdout: string; stderr: string }
  try {
    status = await run(['serve', 'status', '--json'])
  } catch {
    return false // Tailscale isn't even installed — nothing of ours could be exposed through it
  }
  if (status.code !== 0) return false
  const served = findServedIngress(status.stdout, ingressPort)
  if (!served) return false
  const subcommand = served.funnel ? 'funnel' : 'serve'
  try {
    const result = await run([subcommand, `--https=${served.port}`, 'off'])
    return result.code === 0
  } catch {
    return false
  }
}
