// PTYSession — a single pseudo-terminal backed by node-pty.
//
// Spawns a shell (pwsh.exe if installed, else the built-in powershell.exe, on
// Windows; bash elsewhere) in a real PTY so that interactive TUI applications
// (claude CLI, vim, htop, etc.) render correctly.
// The PTY is created in the caller-supplied `cwd` (the Code session's repoRoot).
//
// The `claude` CLI is NOT spawned directly — instead we spawn a shell and have it
// run `claude`. This way we reuse the shell's environment (PATH, env vars, etc.)
// and don't need platform-specific binary resolution.
//
// The caller writes the claude launch command into the PTY's stdin once, after
// which all I/O flows through the PTY's stdin/stdout.

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)

/** Resolve the shell to spawn on Windows: prefer PowerShell Core (`pwsh.exe`) if
 *  installed, otherwise fall back to the built-in Windows PowerShell
 *  (`powershell.exe`), which ships on every Windows install. Cached after first
 *  resolution — the answer can't change for the life of the daemon process. */
let cachedWindowsShell: string | null = null
function resolveWindowsShell(): string {
  if (cachedWindowsShell) return cachedWindowsShell
  try {
    execFileSync('where', ['pwsh.exe'], { stdio: 'ignore' })
    cachedWindowsShell = 'pwsh.exe'
  } catch {
    cachedWindowsShell = 'powershell.exe'
  }
  return cachedWindowsShell
}

/** A single PTY session backed by node-pty. */
export class PTYSession {
  private pty: ReturnType<typeof import('node-pty').spawn> | null = null
  private emitter = new EventEmitter()
  private exited = false
  private exitCode: number | null = null
  private processId: number | null = null

  /** Spawn a new PTY session. The caller should write the launch command (e.g.
   *  `claude`) via `session.write()` after this returns. */
  static spawn(cwd: string, rows = 24, cols = 80): PTYSession {
    const s = new PTYSession()
    s.doSpawn(cwd, rows, cols)
    return s
  }

  private doSpawn(cwd: string, rows: number, cols: number): void {
    const ptyModule = require('node-pty')

    const shell = process.platform === 'win32' ? resolveWindowsShell() : 'bash'

    this.pty = ptyModule.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    })

    const termPty = this.pty!
    this.processId = termPty.pid

    // termPty is non-null here (captured from `this.pty!` above).
    termPty.onData((data: string) => {
      this.emitter.emit('data', data)
    })

    termPty.onExit(({ exitCode, signal }: { exitCode?: number; signal?: number }) => {
      this.exited = true
      this.exitCode = exitCode ?? signal ?? 1
      this.emitter.emit('exit', { exitCode: this.exitCode, signal })
    })
  }

  // ── public API ──────────────────────────────────────────────────────

  /** Write raw bytes to the PTY's stdin. */
  write(data: string): void {
    if (this.exited || !this.pty) return
    this.pty.write(data)
  }

  /** Resize the PTY (cols, rows). */
  resize(cols: number, rows: number): void {
    if (!this.pty) return
    try { this.pty.resize(cols, rows) } catch { /* best-effort */ }
  }

  /** Kill the PTY and all child processes. */
  kill(): void {
    if (!this.pty || this.exited) return
    try { this.pty.kill() } catch { /* best-effort */ }
    this.exited = true
  }

  isExited(): boolean { return this.exited }
  getExitCode(): number | null { return this.exitCode }
  getPid(): number | null { return this.processId }

  onData(cb: (data: string) => void): void { this.emitter.on('data', cb) }
  onExit(cb: (info: { exitCode: number | null; signal?: number }) => void): void { this.emitter.on('exit', cb) }

  /** Remove all listeners and kill the PTY. */
  dispose(): void {
    this.kill()
    this.emitter.removeAllListeners()
  }
}
