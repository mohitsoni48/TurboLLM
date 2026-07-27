// TerminalManager — owns PTY sessions, keyed by session ID.
// Each session is a `claude` CLI subprocess launched via the PTY, bridged through
// a WebSocket connection from the browser's xterm.js renderer.
//
// Sessions are scoped to a Code session's repoRoot (the working directory where
// the claude CLI runs). The session survives the WebSocket disconnect — a reconnect
// re-attaches to the same PTY.

import { PTYSession } from './pty-session'

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

  /**
   * Create a new terminal session.
   * @param repoRoot Working directory for the PTY
   * @param codeSessionId Optional Code session to associate with
   * @param cols Terminal columns (default 80)
   * @param rows Terminal rows (default 24)
   * @returns The session ID
   */
  create(
    repoRoot: string,
    codeSessionId: string | null = null,
    cols = 80,
    rows = 24,
  ): string {
    const id = crypto.randomUUID()
    const session = PTYSession.spawn(repoRoot, rows, cols)

    // Pipe PTY output → WebSocket
    session.onData((data: string) => {
      const ev = this.infoMap.get(id)
      if (ev) {
        const handler = this.listeners.get(id)
        if (handler?.onData) handler.onData(data)
      }
    })

    // On exit, close the WebSocket and clean up
    session.onExit(() => {
      const handler = this.listeners.get(id)
      if (handler?.onClose) handler.onClose()
      this.sessions.delete(id)
      this.infoMap.delete(id)
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
      session.dispose()
      this.sessions.delete(id)
      this.infoMap.delete(id)
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

  private listeners = new Map<string, { onData?: (data: string) => void; onClose?: () => void }>

  /**
   * Register a WebSocket handler for a session. Called when the WebSocket
   * connects, and removed when it closes.
   */
  registerWsListener(id: string, handler: { onData: (data: string) => void; onClose?: () => void }): void {
    this.listeners.set(id, handler)
  }

  /**
   * Unregister a WebSocket handler. Called when the WebSocket closes.
   */
  unregisterWsListener(id: string): void {
    this.listeners.delete(id)
  }
}
