// TerminalManager — owns PTY sessions, keyed by session ID.
// Each session is a `claude` CLI subprocess launched via the PTY, bridged through
// a WebSocket connection from the browser's xterm.js renderer.
//
// Sessions are scoped to a Code session's repoRoot (the working directory where
// the claude CLI runs). The session survives the WebSocket disconnect — a reconnect
// re-attaches to the same PTY.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PTYSession } from './pty-session'
import { sessionAuth } from '../code/session-auth'

// ── Orphan-safety pidfile (mirrors tunnel/manager.ts's tunnel-<pid>.pid pattern, which
// itself mirrors engines/manager.ts) ──────────────────────────────────────────────────
// Found live in this exact repo: after a day of daemon restarts during Code-terminal
// testing, `tasklist` showed 11 orphaned claude.exe + 6 orphaned powershell.exe processes
// — cli.ts's shutdown handlers (SIGINT/SIGTERM/SIGHUP, and the sync 'exit' safety net)
// killed tracked engines and tunnels but never touched terminal-agent PTYs at all. Each
// leaked CLI process stays configured with ANTHROPIC_BASE_URL pointed at the (possibly
// long-gone) daemon's port and stays pinned to whatever model was loaded at ITS OWN
// launch time — a stray request from one of these zombies hitting a NEW daemon instance
// (if it landed on the same port) would silently trigger the gateway's autoSwap and load
// a model out from under whatever the user just picked, reading as an inexplicable
// "silent revert". This is the terminal-tracking counterpart that was missing.
//
// Tracks the PTY's own shell pid (powershell.exe/bash) — the launched CLI (claude.exe
// etc.) is a CHILD of that shell, so a `taskkill /T` (Windows) or process-group signal
// (POSIX) on the shell's pid takes the CLI down with it.

function terminalPidDir(dataDir: string): string {
  return join(dataDir, 'run')
}
function terminalPidFile(dataDir: string, pid: number): string {
  return join(terminalPidDir(dataDir), `terminal-${pid}.pid`)
}
function writeTerminalPid(dataDir: string, pid: number): void {
  try {
    mkdirSync(terminalPidDir(dataDir), { recursive: true })
    writeFileSync(terminalPidFile(dataDir, pid), JSON.stringify({ pid, owner: process.pid }))
  } catch {
    /* best-effort — tracking is a safety net, never block a launch on it */
  }
}
function clearTerminalPid(dataDir: string, pid: number): void {
  try {
    rmSync(terminalPidFile(dataDir, pid), { force: true })
  } catch {
    /* best-effort */
  }
}
function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
function readTerminalPidFiles(dataDir: string): Array<{ pid: number; owner: number; file: string }> {
  const dir = terminalPidDir(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^terminal-\d+\.pid$/.test(n))
  } catch {
    return [] // no run dir yet
  }
  const out: Array<{ pid: number; owner: number; file: string }> = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const { pid, owner } = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; owner?: number }
      if (typeof pid === 'number' && pid > 0) out.push({ pid, owner: typeof owner === 'number' ? owner : 0, file })
      else rmSync(file, { force: true })
    } catch {
      try { rmSync(file, { force: true }) } catch { /* best-effort */ }
    }
  }
  return out
}

/** Reap terminal-agent shell processes left behind by a previous daemon that didn't shut
 *  down cleanly. Called once at startup, alongside reapStaleEngines/reapStaleTunnels. An
 *  orphan is one whose owner daemon is gone. Returns the number reaped. */
export function reapStaleTerminals(dataDir: string): number {
  let killed = 0
  for (const { pid, owner, file } of readTerminalPidFiles(dataDir)) {
    if (owner && pidAlive(owner)) continue // still managed by a live daemon
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'])
      else process.kill(pid, 'SIGKILL')
      killed++
    } catch {
      /* already gone */
    }
    try { rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
  return killed
}

/** Synchronous best-effort kill of terminal shells THIS daemon owns, for a process 'exit'
 *  handler (which can't await). Mirrors killTrackedEnginesSync/killTrackedTunnelsSync.
 *  Owner-scoped so a daemon exiting during a restart overlap never kills the incoming
 *  daemon's terminal. */
export function killTrackedTerminalsSync(dataDir: string): void {
  for (const { pid, owner, file } of readTerminalPidFiles(dataDir)) {
    if (owner !== process.pid) continue
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'])
      else process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    try { rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
}

export interface TerminalSessionInfo {
  id: string
  /** The Code session ID this terminal belongs to (or null for a standalone terminal). */
  codeSessionId: string | null
  /** The working directory for the PTY. */
  cwd: string
  /** The cols/rows of the terminal. */
  cols: number
  rows: number
  /** When the session was created (ISO string). */
  createdAt: string
}

export class TerminalManager {
  private sessions = new Map<string, PTYSession>()
  private infoMap = new Map<string, TerminalSessionInfo>()

  /** `dataDir` — the daemon's own data directory (ConfigStore.dir()), for the orphan-safety
   *  pidfile tracking above. Terminal-manager unit tests never spawn a real PTY (see
   *  terminal-manager.test.ts's header), so an empty string is a safe default there. */
  constructor(private dataDir: string = '') {}

  /**
   * Create a new terminal session.
   * @param repoRoot Working directory for the PTY
   * @param codeSessionId Optional Code session to associate with
   * @param cols Terminal columns (default 80)
   * @param rows Terminal rows (default 24)
   * @param launchCommand Optional command the shell runs at startup (see pty-session.ts) —
   *   e.g. `turbollm launch claude`, built server-side (terminal-routes.ts), never sent by
   *   the client. Absent for a plain interactive shell.
   * @returns The session ID
   */
  create(
    repoRoot: string,
    codeSessionId: string | null = null,
    cols = 80,
    rows = 24,
    launchCommand?: string,
  ): string {
    const id = crypto.randomUUID()
    const session = PTYSession.spawn(repoRoot, rows, cols, launchCommand)

    // Orphan-safety: track the shell's own pid so a daemon crash/force-kill still lets the
    // NEXT startup (reapStaleTerminals) or THIS process's exit handler (killTrackedTerminalsSync)
    // reap it — see the pidfile helpers above for why this was previously missing entirely.
    const shellPid = session.getPid()
    if (shellPid) writeTerminalPid(this.dataDir, shellPid)

    // Pipe PTY output → every attached WebSocket (a Code session can be open in more than
    // one browser tab at once — see broadcast()).
    session.onData((data: string) => {
      const ev = this.infoMap.get(id)
      if (ev) this.broadcast(id, (h) => h.onData?.(data))
    })

    // On exit, close every attached WebSocket and clean up
    session.onExit(() => {
      this.broadcast(id, (h) => h.onClose?.())
      this.sessions.delete(id)
      this.infoMap.delete(id)
      if (shellPid) clearTerminalPid(this.dataDir, shellPid)
      // The CLI subprocess exited on its own (e.g. `exit` typed in-shell) rather than via the
      // kill endpoint below — revoke its session-scoped auth token here too, otherwise it only
      // gets cleaned up on daemon restart.
      if (codeSessionId) sessionAuth.revoke(codeSessionId)
    })

    this.sessions.set(id, session)
    this.infoMap.set(id, {
      id,
      codeSessionId,
      cwd: repoRoot,
      cols,
      rows,
      createdAt: new Date().toISOString(),
    })

    return id
  }

  /**
   * Resize a terminal session.
   */
  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (session) session.resize(cols, rows)
    const info = this.infoMap.get(id)
    if (info) {
      info.cols = cols
      info.rows = rows
    }
  }

  /**
   * Write data to a terminal's PTY stdin.
   */
  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (session) session.write(data)
  }

  /**
   * Kill a terminal session.
   */
  kill(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      const shellPid = session.getPid()
      session.dispose()
      this.sessions.delete(id)
      this.infoMap.delete(id)
      // Also cleared by the onExit handler in create() once the process actually exits —
      // idempotent (force:true), so clearing eagerly here too just closes the window between
      // "we told it to die" and "it actually did" a little sooner.
      if (shellPid) clearTerminalPid(this.dataDir, shellPid)
    }
  }

  /**
   * Check if a session exists and is alive.
   */
  isActive(id: string): boolean {
    const session = this.sessions.get(id)
    const info = this.infoMap.get(id)
    return !!session && !!info && !session.isExited()
  }

  /**
   * Get info about a session.
   */
  getInfo(id: string): TerminalSessionInfo | undefined {
    return this.infoMap.get(id)
  }

  /**
   * List all session IDs.
   */
  listIds(): string[] {
    return Array.from(this.infoMap.keys())
  }

  /**
   * Look up a terminal ID by the Code session ID it was scoped to.
   * Returns null if no active terminal is associated with that Code session.
   */
  findByCodeSessionId(codeSessionId: string): string | null {
    for (const [id, info] of this.infoMap) {
      if (info.codeSessionId === codeSessionId && this.sessions.get(id) && !this.sessions.get(id)!.isExited()) {
        return id
      }
    }
    return null
  }

  /**
   * Clean up idle sessions (older than the given age in ms).
   */
  cleanupIdle(maxAgeMs = 300_000): void {
    const now = Date.now()
    for (const [id, info] of this.infoMap) {
      const age = now - new Date(info.createdAt).getTime()
      if (age > maxAgeMs) {
        this.kill(id)
      }
    }
  }

  // ── WebSocket handler registration ─────────────────────────────────
  // A Code session's terminal can be attached from more than one browser tab at once (the
  // PTY itself already supports this — see the scrollback replay below, tmux-attach style) —
  // so each terminal id maps to a SET of handlers, not a single one. A single-handler map
  // would let a second tab's connect silently steal the first tab's slot, and either tab
  // closing would silence (or fully unregister) the other.

  private listeners = new Map<string, Set<{ onData?: (data: string) => void; onClose?: () => void }>>()

  /** Call `fn` for every handler currently attached to `id`. No-op if none are attached. */
  private broadcast(
    id: string,
    fn: (h: { onData?: (data: string) => void; onClose?: () => void }) => void,
  ): void {
    const handlers = this.listeners.get(id)
    if (!handlers) return
    for (const h of handlers) fn(h)
  }

  /**
   * Register a WebSocket handler for a session. Called when the WebSocket
   * connects, and removed (via `unregisterWsListener`, passing the SAME handler
   * reference) when it closes.
   *
   * Replays the PTY's buffered scrollback to the handler BEFORE registering it for live
   * `onData` — otherwise a reconnecting client (tab reload, a dropped WS, navigating away
   * and back to the session) shows a blank terminal until the next byte happens to arrive,
   * even though the CLI underneath is still running and has already printed real output.
   */
  registerWsListener(id: string, handler: { onData: (data: string) => void; onClose?: () => void }): void {
    const session = this.sessions.get(id)
    if (session) {
      const scrollback = session.getScrollback()
      if (scrollback) handler.onData(scrollback)
    }
    let handlers = this.listeners.get(id)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(id, handlers)
    }
    handlers.add(handler)
  }

  /**
   * Unregister one WebSocket handler. Called when that WebSocket closes — must pass the
   * exact handler object given to `registerWsListener`, so a still-open second tab's
   * handler on the same terminal id is untouched.
   */
  unregisterWsListener(id: string, handler: { onData?: (data: string) => void; onClose?: () => void }): void {
    const handlers = this.listeners.get(id)
    if (!handlers) return
    handlers.delete(handler)
    if (handlers.size === 0) this.listeners.delete(id)
  }
}
