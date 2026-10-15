// Pidfile utilities for F-035: write/read/remove the daemon's PID file and
// implement `turbollm --stop`. Isolated here so it can be unit-tested without
// touching cli.ts (which is the entrypoint and spins up a full daemon).
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { isIP } from 'node:net'

export interface PidfileData {
  pid: number
  port: number
  /** The address the daemon bound. A daemon bound to one interface (`--addr 192.168.1.5:…`,
   *  `daemon.host`) does not answer on 127.0.0.1, so the identity probe must go here. Absent
   *  from a pidfile written before it was recorded (probed on loopback, as before). */
  host?: string
}

/** Write `{ pid, port, host? }` as JSON to <dir>/daemon.pid. Best-effort. */
export function writePidfile(dir: string, pid: number, port: number, host?: string): void {
  const path = join(dir, 'daemon.pid')
  writeFileSync(path, JSON.stringify({ pid, port, ...(host ? { host } : {}) } satisfies PidfileData))
}

/** Read and parse <dir>/daemon.pid. Returns null if absent or unparseable. */
export function readPidfile(dir: string): PidfileData | null {
  const path = join(dir, 'daemon.pid')
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).pid === 'number' &&
      typeof (parsed as Record<string, unknown>).port === 'number'
    ) {
      const { pid, port, host } = parsed as { pid: number; port: number; host?: unknown }
      // A malformed host is dropped (probe loopback), never put into a URL.
      return typeof host === 'string' && host ? { pid, port, host } : { pid, port }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the TCP port to reach the daemon on, WITHOUT assuming a fixed default.
 * Priority:
 *   1. `explicitPort` — an explicit `--port` the caller passed.
 *   2. The running daemon's pidfile (`<dir>/daemon.pid`) — its ACTUAL bound port,
 *      which is correct even when the daemon was started with `--port`/`--addr` or a
 *      custom config that moved it off the shipped default.
 *   3. `fallbackPort` — the caller's configured / shipped default (last resort, used
 *      when no daemon is running or its pidfile is missing).
 */
export function resolveDaemonPort(
  dir: string,
  explicitPort: number | undefined,
  fallbackPort: number,
): number {
  if (explicitPort && explicitPort > 0) return explicitPort
  const data = readPidfile(dir)
  if (data && data.port > 0) return data.port
  return fallbackPort
}

/** Remove <dir>/daemon.pid. Best-effort — never throws. */
export function removePidfile(dir: string): void {
  try {
    unlinkSync(join(dir, 'daemon.pid'))
  } catch {
    /* best-effort */
  }
}

/** Remove <dir>/daemon.pid only when it is `pid`'s own record — what a daemon's shutdown/exit
 *  path must use. A second daemon started on the same data dir never wrote one, so on its way
 *  out it would otherwise delete the RUNNING daemon's pidfile (and `--stop` could no longer
 *  find it). Best-effort — never throws. */
export function removeOwnPidfile(dir: string, pid: number = process.pid): void {
  if (readPidfile(dir)?.pid === pid) removePidfile(dir)
}

/** The host to reach a daemon that bound `host` on: that address, except that a wildcard bind
 *  (all interfaces) or an older pidfile with no host is reached over loopback, and an IPv6
 *  literal is bracketed for a URL. */
export function daemonReachHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** The daemon that already owns <dir>/daemon.pid and is alive, or null. Alive means the same
 *  proof {@link stopDaemon} demands before it kills anything: the PID exists AND a TurboLLM
 *  answers on the recorded address and port — so a stale pidfile, a recycled PID or a daemon
 *  that already closed its listener (a self-restart handing over) never blocks a start. */
export async function findRunningDaemon(
  dir: string,
  hooks: Pick<StopHooks, 'processExists' | 'confirmTurbollm'> = defaultHooks,
  selfPid: number = process.pid,
): Promise<PidfileData | null> {
  const data = readPidfile(dir)
  if (!data || data.pid === selfPid || !hooks.processExists(data.pid)) return null
  return (await hooks.confirmTurbollm(data.port, data.host)) ? data : null
}

// Injection hook types so unit tests can replace the real OS calls.
export interface StopHooks {
  /** Returns true when the process is still alive. */
  processExists: (pid: number) => boolean
  /** Send a signal to the process (Unix only). */
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** Run taskkill on Windows. */
  taskkill: (pid: number) => void
  /** Confirm a TurboLLM daemon is actually answering on `port` of the bound `host` (see
   *  {@link daemonReachHost}) — the identity check that guards against killing a recycled PID
   *  (stale pidfile whose PID the OS reused). */
  confirmTurbollm: (port: number, host?: string) => Promise<boolean>
  /** Platform — injectable so the Windows vs Unix branch is testable on any OS. */
  platform: NodeJS.Platform
}

/** Default production hooks. */
const defaultHooks: StopHooks = {
  processExists(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      // EPERM: it exists but this user may not signal it (a daemon run elevated or as another
      // user) — alive, so a start beside it is refused and --stop keeps its pidfile. A recycled
      // PID is still caught by the identity probe that follows every use of this.
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  kill(pid, signal) {
    process.kill(pid, signal)
  },
  taskkill(pid) {
    // On Windows, graceful SIGTERM is not reliably deliverable to another console
    // process, so we use taskkill /T (kill tree) /F (force). Any VRAM left by the
    // engine subprocess will be freed by the startup orphan-reaper on the next launch.
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  },
  async confirmTurbollm(port, host) {
    // Probe the recorded address and port. /healthz, not /api/v1/status: a daemon bound to a
    // non-loopback address is LAN-exposed, so with requireApiKey (the default) it answers
    // /api/v1/status 401 to this probe, which reaches it from that address, not from loopback;
    // /healthz is open on every bind (auth.ts isExempt). Identity: every TurboLLM response
    // carries `Server: TurboLLM/<version>` (server.ts) and /healthz's JSON body a `version`.
    // Anything else (refused, non-JSON, foreign app) → not ours. Short timeout; never throws.
    //
    // Only a listener on THIS machine may answer: a pidfile outlives an unclean exit (power
    // loss, SIGKILL), the recorded address may since have gone to another machine (a new DHCP
    // lease), and its TurboLLM answering is no proof about a local pid that --stop then kills.
    // So the probe's own socket is bound to the recorded address (localAddress): the kernel
    // allows that only for an address this machine has (EADDRNOTAVAIL at once otherwise), and
    // traffic to it never leaves the machine. Not os.networkInterfaces(): it leaves out an
    // interface that is up but has no carrier (docker0 or virbr0 with nothing attached), where a
    // daemon can still be bound and answer, and it throws on some Android versions.
    const wildcard = !host || host === '0.0.0.0' || host === '::'
    const addr = wildcard ? '127.0.0.1' : host.replace(/^\[(.*)\]$/, '$1')
    // A hostname or junk from a hand-edited pidfile is never probed. Port: http.get throws
    // synchronously on one out of range and quietly turns 0 into 80.
    if (!isIP(addr) || !Number.isInteger(port) || port < 1 || port > 65535) return false
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let req: http.ClientRequest | undefined
      const done = (ok: boolean): void => {
        clearTimeout(timer)
        req?.destroy()
        resolve(ok)
      }
      const onResponse = (res: http.IncomingMessage): void => {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 299 || !String(res.headers.server ?? '').startsWith('TurboLLM/')) return done(false)
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
          if (text.length > 65_536) done(false) // /healthz is tiny; not an unbounded read
        })
        res.on('end', () => {
          try {
            const body = JSON.parse(text) as unknown
            done(typeof body === 'object' && body !== null && 'version' in body)
          } catch {
            done(false)
          }
        })
        res.on('error', () => done(false))
      }
      try {
        // agent: false — one connection, closed after; nothing pooled keeps the CLI alive.
        req = http.get(
          { host: addr, port, path: '/healthz', agent: false, ...(wildcard ? {} : { localAddress: addr }) },
          onResponse,
        )
      } catch {
        return done(false) // the startup guard awaits this at top level: a throw would crash the start
      }
      req.on('error', () => done(false))
      timer = setTimeout(() => done(false), 2000)
    })
  },
  platform: process.platform,
}

/** Poll until `processExists(pid)` returns false or `timeoutMs` elapses (~100 ms steps). */
async function waitForExit(
  pid: number,
  timeoutMs: number,
  hooks: StopHooks,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!hooks.processExists(pid)) return true
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  return !hooks.processExists(pid)
}

export interface StopResult {
  /** Whether a running daemon was found and stopped. */
  stopped: boolean
  /** The port the daemon was listening on (when stopped = true). */
  port?: number
  /** Human-readable message to print. */
  message: string
}

/**
 * Stop the running TurboLLM daemon by reading its pidfile from `dir`.
 *
 * Cross-platform:
 * - Unix: SIGTERM → wait up to 10 s → SIGKILL if still alive.
 * - Windows: taskkill /PID /T /F (graceful signals aren't reliably deliverable
 *   to another console process on Windows).
 *
 * The pidfile is removed after a successful stop.
 */
export async function stopDaemon(dir: string, hooks: StopHooks = defaultHooks): Promise<StopResult> {
  const data = readPidfile(dir)

  if (!data) {
    return { stopped: false, message: 'No running TurboLLM daemon found.' }
  }

  const { pid, port } = data

  // Check if the process is actually still alive before attempting to stop it.
  if (!hooks.processExists(pid)) {
    removeOwnPidfile(dir, pid)
    return { stopped: false, message: 'No running TurboLLM daemon found.' }
  }

  // Identity check (guards against a recycled PID): the pidfile is removed on every
  // clean-exit path, so a stale pidfile only survives a hard kill — and if the OS then
  // reassigns that PID to an unrelated process, blindly killing it would be a footgun
  // (worse on Windows, where taskkill /T also kills the child tree). Confirm a TurboLLM
  // daemon is actually answering on the recorded port before we kill the PID. If it
  // isn't, refuse and hand the user the manual command rather than risk the wrong process.
  if (!(await hooks.confirmTurbollm(port, data.host))) {
    const manual = hooks.platform === 'win32' ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`
    return {
      stopped: false,
      message:
        `Found a pidfile (pid ${pid}, port ${port}), but no TurboLLM daemon is responding there — ` +
        `it may be stale or the PID was reused by another process. Not killing it automatically.\n` +
        `If you're sure it's TurboLLM, stop it manually: ${manual}`,
    }
  }

  try {
    if (hooks.platform === 'win32') {
      hooks.taskkill(pid)
      // taskkill is synchronous and force-kills, so by the time it returns the
      // process should be gone. Give it a short grace window just in case.
      await waitForExit(pid, 2_000, hooks)
    } else {
      // Unix: send SIGTERM and wait up to 10 s for a graceful shutdown.
      hooks.kill(pid, 'SIGTERM')
      const exited = await waitForExit(pid, 10_000, hooks)
      if (!exited) {
        // Still alive after 10 s — force kill.
        try {
          hooks.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  } catch (e) {
    return { stopped: false, message: `Failed to stop daemon (pid ${pid}): ${e instanceof Error ? e.message : e}` }
  }

  // Only the stopped daemon's own record: it removes its pidfile as soon as shutdown starts,
  // so a daemon started while this one was still stopping can bind and write its own before
  // the poll above sees the old pid gone — deleting that would hide the new daemon from
  // --stop and from the one-daemon-per-data-dir start guard.
  removeOwnPidfile(dir, pid)
  return { stopped: true, port, message: `TurboLLM daemon stopped (port ${port})` }
}
