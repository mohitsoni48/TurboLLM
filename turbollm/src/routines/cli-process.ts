// Non-interactive `claude` CLI subprocess runner for a CLI-flavor Code Routine's scheduled
// fire — spec 20 §1's "programmatic mode", never a PTY. Deliberately spawned WITHOUT a shell
// unless the resolved binary requires one (a .cmd/.bat PATHEXT shim), same rule cli-launch.ts's
// realSpawn and agent-modes.ts's realHelpRunner already follow, for the same reason: a shell
// parses arguments differently than the OS's own CreateProcess/execve, and this codebase found a
// real command-injection bug going the other way (cli-launch.ts:86-100). That matters more here
// than almost anywhere else in the daemon: a routine's `-p` argument is its stored prompt —
// arbitrary user prose, written once at creation time and replayed unattended on a schedule.
//
// The kill-on-timeout path below is a deliberately SIMPLER cousin of robust-bash.ts's
// killProcessTreeVerified — that function's escalating, WMI-based, verify-it-actually-died
// design exists because an interactive Code session's bash tool is something a user is actively
// staring at, so an occasionally-orphaned process is a live, visible bug. A routine's one-shot
// CLI invocation has no such audience: best-effort kill is an acceptable bar here (the same
// "fast path only" tier robust-bash.ts itself calls killProcessTreeFast), without the
// verify+escalate tier.
import { spawn, type StdioOptions } from 'node:child_process'
import type { Readable } from 'node:stream'
import { resolveExecutable, requiresShell } from '../util/resolve-executable'
import { buildShellCommand } from '../util/shell-command'

export const CLI_ROUTINE_TIMEOUT_MS = 600_000 // 10 minutes — see this plan's Self-review notes.

export interface CliProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Narrow shape runClaudeCliProcess actually needs from a spawned child — matches
 *  cli-launch.ts's SpawnLike pattern of only depending on what's actually used.
 *
 *  Spelled out structurally rather than as `Pick<ChildProcess, 'pid' | 'stdout' | ...>`, which
 *  looks equivalent but is not usable: `ChildProcess.on` is declared with a polymorphic `this`
 *  return, so picking it yields `(...) => ChildProcess` — a fake would have to BE a full
 *  ChildProcess (stdin, stdio, connected, exitCode, and 8 more) to satisfy the one method we
 *  call, which defeats the entire point of a narrow injection seam. Declaring `on` with the two
 *  events actually subscribed, returning `unknown`, keeps a real ChildProcess assignable while
 *  letting a plain EventEmitter stand in. */
export interface CliChildProcess {
  pid?: number
  stdout: Readable | null
  stderr: Readable | null
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type SpawnCliProcess = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => CliChildProcess

/** Same platform-aware fast kill robust-bash.ts's killProcessTreeFast uses — taskkill /F /T on
 *  Windows, a process-group SIGKILL (falling back to a plain SIGKILL) on POSIX. Best-effort only,
 *  matching this module's simpler timeout tier (see module comment above).
 *
 *  The POSIX branch only kills a TREE because `realSpawnCliProcess` spawns detached there, making
 *  the child its own process-group leader so a group with id == pid actually exists. Without that,
 *  `process.kill(-pid)` raises ESRCH and silently degrades to a direct-child-only kill, orphaning
 *  every tool subprocess `claude` started — the two halves have to stay together. */
export function killCliProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', detached: true, windowsHide: true }) } catch { /* best-effort */ }
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
    }
  }
}

export const realSpawnCliProcess: SpawnCliProcess = (cmd, args, opts) => {
  const resolved = resolveExecutable(cmd)
  // `detached` on POSIX only — same as robust-bash.ts:215. It is what gives the child its own
  // process group, which is the precondition for killCliProcessTree's group SIGKILL reaching the
  // tool subprocesses `claude` spawns rather than just `claude` itself.
  const base = {
    ...opts,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'] as StdioOptions,
    windowsHide: true,
  }
  if (requiresShell(resolved)) {
    return spawn(buildShellCommand(cmd, args), { ...base, shell: true })
  }
  return spawn(resolved ?? cmd, args, base)
}

/** Spawn `claude` with `args`, capture stdout/stderr in full (a routine's response is never
 *  large enough to warrant streaming to disk), and enforce a hard wall-clock timeout — spec 20
 *  §6's runaway-protection requirement (the loop-detection half is already handled for free by
 *  the gateway, see this plan's Investigation findings §4).
 *
 *  Never rejects: a spawn failure (ENOENT, EACCES) resolves with `exitCode: null` and the error
 *  message appended to stderr, so the caller has exactly one outcome shape to record on the
 *  RoutineRun rather than a try/catch plus a result branch.
 *
 *  `_killTree` is injectable for the same reason `_spawn` is, and it is NOT optional politeness:
 *  the OS-level sweep is fire-and-forget against a raw pid, so a test running against a FAKE child
 *  would otherwise send a real `taskkill /F /T` to whatever unrelated process currently owns that
 *  fake's pid number on the developer's machine. The injected spawn and the injected kill have to
 *  be swapped as a pair or the mock isn't actually a mock. */
export function runClaudeCliProcess(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
  _spawn: SpawnCliProcess = realSpawnCliProcess,
  _killTree: (pid: number) => void = killCliProcessTree,
): Promise<CliProcessResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? CLI_ROUTINE_TIMEOUT_MS
    const child = _spawn('claude', args, { cwd: opts.cwd, env: opts.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      // Signal the direct child first — the one handle we definitely own — then sweep whatever
      // subprocesses it started. The direct kill is what makes the timeout observable at all when
      // the tree sweep is a no-op (a fake child, or a POSIX child that never became a group leader).
      try { child.kill('SIGKILL') } catch { /* already dead */ }
      if (child.pid) _killTree(child.pid)
    }, timeoutMs)

    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8') })

    child.on('error', (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr += `\n${e.message}`
      resolve({ exitCode: null, stdout, stderr, timedOut })
    })

    child.on('exit', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })
}
