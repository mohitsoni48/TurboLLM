// Pidfile utilities for F-035: write/read/remove the daemon's PID file and
// implement `turbollm --stop`. Isolated here so it can be unit-tested without
// touching cli.ts (which is the entrypoint and spins up a full daemon).
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface PidfileData {
  pid: number
  port: number
}

/** Write `{ pid, port }` as JSON to <dir>/daemon.pid. Best-effort. */
export function writePidfile(dir: string, pid: number, port: number): void {
  const path = join(dir, 'daemon.pid')
  writeFileSync(path, JSON.stringify({ pid, port } satisfies PidfileData))
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
      return parsed as PidfileData
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

/** The daemon that already owns <dir>/daemon.pid and is alive, or null. Alive means the same
 *  proof {@link stopDaemon} demands before it kills anything: the PID exists AND a TurboLLM
 *  answers /api/v1/status on the recorded port — so a stale pidfile, a recycled PID or a daemon
 *  that already closed its listener (a self-restart handing over) never blocks a start. */
export async function findRunningDaemon(
  dir: string,
  hooks: Pick<StopHooks, 'processExists' | 'confirmTurbollm'> = defaultHooks,
  selfPid: number = process.pid,
): Promise<PidfileData | null> {
  const data = readPidfile(dir)
  if (!data || data.pid === selfPid || !hooks.processExists(data.pid)) return null
  return (await hooks.confirmTurbollm(data.port)) ? data : null
}

// Injection hook types so unit tests can replace the real OS calls.
export interface StopHooks {
  /** Returns true when the process is still alive. */
  processExists: (pid: number) => boolean
  /** Send a signal to the process (Unix only). */
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** Run taskkill on Windows. */
  taskkill: (pid: number) => void
  /** Confirm a TurboLLM daemon is actually answering on `port` — the identity check
   *  that guards against killing a recycled PID (stale pidfile whose PID the OS reused). */
  confirmTurbollm: (port: number) => Promise<boolean>
  /** Platform — injectable so the Windows vs Unix branch is testable on any OS. */
  platform: NodeJS.Platform
}

/** Default production hooks. */
const defaultHooks: StopHooks = {
  processExists(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
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
  async confirmTurbollm(port) {
    // Probe the recorded port; a TurboLLM daemon answers /api/v1/status with a JSON
    // body carrying `version` + `engine`. Anything else (refused, non-JSON, foreign
    // app) → not ours. Loopback only; short timeout; never throws.
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return false
      const body = (await res.json()) as unknown
      return typeof body === 'object' && body !== null && 'version' in body && 'engine' in body
    } catch {
      return false
    }
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
    removePidfile(dir)
    return { stopped: false, message: 'No running TurboLLM daemon found.' }
  }

  // Identity check (guards against a recycled PID): the pidfile is removed on every
  // clean-exit path, so a stale pidfile only survives a hard kill — and if the OS then
  // reassigns that PID to an unrelated process, blindly killing it would be a footgun
  // (worse on Windows, where taskkill /T also kills the child tree). Confirm a TurboLLM
  // daemon is actually answering on the recorded port before we kill the PID. If it
  // isn't, refuse and hand the user the manual command rather than risk the wrong process.
  if (!(await hooks.confirmTurbollm(port))) {
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

  removePidfile(dir)
  return { stopped: true, port, message: `TurboLLM daemon stopped (port ${port})` }
}
