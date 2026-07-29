// PTYSession — a single pseudo-terminal backed by node-pty.
//
// Spawns a shell (pwsh.exe if installed, else the built-in powershell.exe, on
// Windows; bash elsewhere) in a real PTY so that interactive TUI applications
// (claude CLI, vim, htop, etc.) render correctly.
// The PTY is created in the caller-supplied `cwd` (the Code session's repoRoot).
//
// A target CLI (claude/pi/opencode/...) is NOT spawned directly — instead we spawn a
// shell and have it run `turbollm launch <agent>` as its OWN startup command. This way
// we reuse the shell's environment (PATH, env vars, etc.) and don't need platform-
// specific binary resolution — AND the command is never typed as literal keystrokes the
// shell would echo back: it's baked into the shell's own invocation (`-Command`/`-lc`),
// so the very first thing visible in the terminal is the launch command's own output,
// never the command text itself. When no launchCommand is given, the shell just starts
// normally (interactive, no command), unchanged from earlier behavior.

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

/** Cap on the in-memory scrollback buffer (bytes) — generous enough for a full-screen TUI
 *  repaint history without unbounded growth for a long-lived session. Trimmed from the
 *  FRONT (oldest first) once exceeded, same as any bounded scrollback. */
const SCROLLBACK_CAP = 512 * 1024

/** A single PTY session backed by node-pty. */
export class PTYSession {
  private pty: ReturnType<typeof import('node-pty').spawn> | null = null
  private emitter = new EventEmitter()
  private exited = false
  private exitCode: number | null = null
  private processId: number | null = null
  // Every byte the PTY has ever written, capped — replayed to a NEWLY connecting WebSocket
  // client (terminal-manager.ts's registerWsListener) so a reconnect (tab reload, WS drop,
  // navigating away and back) shows the terminal's actual current state instead of a blank
  // screen until the next byte happens to arrive. xterm.js replaying the same escape
  // sequences that produced the original screen reconstructs it correctly, the same way
  // `tmux attach`/`screen -r` catch a reconnecting client up.
  private scrollback = ''

  /** Spawn a new PTY session. When `launchCommand` is given, the shell runs it as its
   *  own startup command (never typed into stdin — see the module header comment). */
  static spawn(cwd: string, rows = 24, cols = 80, launchCommand?: string): PTYSession {
    const s = new PTYSession()
    s.doSpawn(cwd, rows, cols, launchCommand)
    return s
  }

  private doSpawn(cwd: string, rows: number, cols: number, launchCommand?: string): void {
    const ptyModule = require('node-pty')

    const win32 = process.platform === 'win32'
    const shell = win32 ? resolveWindowsShell() : 'bash'
    // -NoExit / exec bash: run the command, then drop into a normal interactive shell
    // once it exits (matches the plain-shell experience the terminal already had).
    const args = launchCommand
      ? (win32 ? ['-NoExit', '-Command', launchCommand] : ['-lc', `${launchCommand}; exec bash`])
      : []

    this.pty = ptyModule.spawn(shell, args, {
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
      this.scrollback += data
      if (this.scrollback.length > SCROLLBACK_CAP) {
        this.scrollback = this.scrollback.slice(this.scrollback.length - SCROLLBACK_CAP)
      }
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
  /** Everything written so far (capped, oldest trimmed) — replay this to a newly-attached
   *  client before it starts receiving live `onData` output. */
  getScrollback(): string { return this.scrollback }

  onData(cb: (data: string) => void): void { this.emitter.on('data', cb) }
  onExit(cb: (info: { exitCode: number | null; signal?: number }) => void): void { this.emitter.on('exit', cb) }

  /** Remove all listeners and kill the PTY. */
  dispose(): void {
    this.kill()
    this.emitter.removeAllListeners()
  }
}
