// Non-interactive `claude` CLI subprocess runner for a CLI-flavor Code Routine's scheduled
// fire — spec 20 §1's "programmatic mode", never a PTY.
//
// ── The prompt never touches a command line (review 2026-08-01, C1) ──────────────────────────
// A routine's prompt is arbitrary free text: accepted over HTTP at creation time
// (`POST /api/v1/routines`), stored, and then replayed UNATTENDED on a schedule. The first
// version of this module passed it as an argv element (`-p <prompt>`), which is safe on the
// direct-spawn path but NOT on the shell path this module still needs for a `.cmd`/`.bat` shim:
// `quoteWindowsArg` escapes for CommandLineToArgvW, and cmd.exe does not use that parser — it
// reads `\"` as CLOSING the quoted region, so a prompt containing a double quote broke out and
// executed chained commands (reproduced by the reviewer with a marker file; the same class of bug
// resolve-executable.ts:5-22 documents).
//
// The fix removes the quoting surface instead of trying to quote better: the prompt is written to
// the child's STDIN and is never an argument at all, on any platform, whether `claude` resolves to
// a native binary or a shim. That is a first-class input channel for the CLI, not a trick — with
// `--print` and no positional prompt the binary itself says so:
//
//     $ claude -p --output-format stream-json --verbose < /dev/null
//     Error: Input must be provided either through stdin or as a prompt argument when using --print
//
// So the only strings that can still reach a shell command line are TurboLLM's OWN fixed flags
// (`--output-format`, `stream-json`, …) and the command name itself. To keep that true as Task 6
// grows the argument list, `assertShellSafeArg` refuses — rather than quotes — anything on that
// command line that is not made entirely of characters this repo has measured `buildShellCommand`
// round-tripping faithfully. A refusal surfaces as an ordinary failed run, not as an injection.
//
// The shell itself cannot be dropped entirely: Node refuses to spawn a `.cmd`/`.bat` without one
// (EINVAL, deliberate mitigation — resolve-executable.ts:19-22), and `requiresShell(null)` keeps
// the old shell behaviour when the command cannot be resolved at all. Both branches are covered by
// the rules above.
//
// The kill-on-timeout path below is a deliberately SIMPLER cousin of robust-bash.ts's
// killProcessTreeVerified — that function's escalating, WMI-based, verify-it-actually-died
// design exists because an interactive Code session's bash tool is something a user is actively
// staring at, so an occasionally-orphaned process is a live, visible bug. A routine's one-shot
// CLI invocation has no such audience: best-effort kill is an acceptable bar here (the same
// "fast path only" tier robust-bash.ts itself calls killProcessTreeFast), without the
// verify+escalate tier.
import { spawn, type SpawnOptions, type StdioOptions } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolveExecutable, requiresShell } from '../util/resolve-executable'
import { buildShellCommand } from '../util/shell-command'

/** 10 minutes. Deliberately the same value as runaway-guard.ts's `ROUTINE_RUN_TIMEOUT_MS`, which
 *  carries the reasoning for the number and is the ceiling the Chat-flavor path uses; the two are
 *  still separate constants because this one bounds a subprocess and that one bounds an
 *  AbortController, and collapsing them is a follow-up, not a silent import. */
export const CLI_ROUTINE_TIMEOUT_MS = 600_000

/** After the child exits, how long its stdout/stderr may stay idle before the result is taken as
 *  complete. Same constant and same reason as robust-bash.ts's `EXIT_STDIO_GRACE_MS`: a detached
 *  descendant can hold the pipes open past its parent's exit, so resolving on `'exit'` alone
 *  truncates trailing output (here: the final `result` event), while waiting for `'close'` alone
 *  hangs if that descendant never lets go. */
const EXIT_STDIO_GRACE_MS = 100

/** After the wall-clock timeout fires and the kill is issued, how long the child gets to report
 *  its own exit before the promise resolves anyway. Spec 20 §6 asks for a HARD timeout: a child
 *  the kill cannot touch (elevated, uninterruptible, or a shell whose real target the tree sweep
 *  missed) must not be able to keep a RoutineRun pinned at `running` forever.
 *
 *  This is an ABSOLUTE ceiling, not a sliding window: total settlement is bounded by
 *  `timeoutMs + CLI_KILL_GRACE_MS` no matter what the child does afterwards. See `armGrace`. */
export const CLI_KILL_GRACE_MS = 1_000

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
 *  call, which defeats the entire point of a narrow injection seam. Declaring `on` with the
 *  events actually subscribed, returning `unknown`, keeps a real ChildProcess assignable while
 *  letting a plain EventEmitter stand in. */
export interface CliChildProcess {
  pid?: number
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
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

/** Characters a string may contain and still survive `buildShellCommand` byte-for-byte. An
 *  ALLOW-LIST, deliberately, for the reason shell-command.ts:23-25 already states about its own
 *  quoting decision: "a denylist that misses one character is a quoting bug".
 *
 *  The first version of this tripwire WAS a denylist — `/["%]/`, the two characters cmd.exe was
 *  known to mishandle (`"` closes the quoted region, the C1 breakout; `%` expands as `%VAR%` even
 *  inside double quotes, with no in-line escape, shell-command.ts:41-44). Re-review 2026-08-01 (N3)
 *  drove seven metacharacters through the shipped shell branch on real cmd.exe and found two more
 *  that PASSED the denylist and were then silently corrupted rather than refused: a newline
 *  TRUNCATES the argument (`a\necho x` arrived as `a`, the rest gone) and a carriage return is
 *  EATEN (`a\recho x` arrived as `aecho x`). Neither executed anything — but "quietly different
 *  from what the caller asked for" is exactly the failure class an allow-list exists to prevent.
 *
 *  The set is shell-command.ts's `SAFE_UNQUOTED_WIN` minus `%`, plus a space. Backslash and space
 *  are IN because `cmd` is held to this same rule (see realSpawnCliProcess) and a command is a
 *  path: both are round-tripped faithfully — by `quoteWindowsArg`'s backslash-doubling rule on
 *  Windows and by `quotePosixArg`'s single quotes on POSIX. Everything left out is either measured
 *  broken (`"`, `%`, LF, CR) or simply never needed, and refusing it costs nothing: TurboLLM's
 *  entire vocabulary here is `claude`, `-p`, `--output-format`, `stream-json`, `--verbose`,
 *  `--permission-mode` and the values `resolveClaudePermissionMode` can return (`auto`,
 *  `acceptEdits`, `plan`, `manual`, `default`) — all plain ASCII words. Prose never reaches here at
 *  all; it goes on stdin (see the module comment's C1 section). */
const SHELL_SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\ -]+$/

function assertShellSafeArg(arg: string): void {
  if (!SHELL_SAFE_ARG.test(arg)) {
    throw new Error(
      `refusing to build a shell command line containing an unquotable argument: ${JSON.stringify(arg.slice(0, 80))}`,
    )
  }
}

/** The two `spawn` overloads this module uses, as one injectable function: `args === null` selects
 *  the single-command-string form `{ shell: true }` requires (passing an args array alongside
 *  `shell: true` is deprecated — DEP0190, shell-command.ts:4-8). */
type RawSpawn = (cmd: string, args: string[] | null, opts: SpawnOptions) => CliChildProcess

const defaultRawSpawn: RawSpawn = (cmd, args, opts) => (args === null ? spawn(cmd, opts) : spawn(cmd, args, opts))

/** Seams for `realSpawnCliProcess`'s own tests: the shell-vs-direct decision is security-relevant
 *  (see C1 in the module comment) and its two branches are otherwise only reachable by having a
 *  real `.cmd` shim on the running machine's PATH. */
export interface RealSpawnDeps {
  spawn?: RawSpawn
  resolve?: (command: string, env?: NodeJS.ProcessEnv) => string | null
  needsShell?: (resolvedPath: string | null) => boolean
}

export function realSpawnCliProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
  deps: RealSpawnDeps = {},
): CliChildProcess {
  const rawSpawn = deps.spawn ?? defaultRawSpawn
  const resolve = deps.resolve ?? resolveExecutable
  const needsShell = deps.needsShell ?? requiresShell
  // Resolved against the env the CHILD will actually run under, not the daemon's own: a service
  // with a minimal PATH would otherwise resolve one binary form here and execute another.
  const resolved = resolve(cmd, opts.env)
  // `detached` on POSIX only — same as robust-bash.ts:215. It is what gives the child its own
  // process group, which is the precondition for killCliProcessTree's group SIGKILL reaching the
  // tool subprocesses `claude` spawns rather than just `claude` itself.
  const base: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    detached: process.platform !== 'win32',
    // stdin is a PIPE, not 'ignore': it is how the prompt is delivered (module comment, C1).
    stdio: ['pipe', 'pipe', 'pipe'] as StdioOptions,
    windowsHide: true,
  }
  if (needsShell(resolved)) {
    // `cmd` is interpolated onto the same command line as the args (`buildShellCommand(bin, args)`
    // quotes `bin` with the identical function), so it is subject to the identical rule — a guard
    // whose stated purpose is to have no exemptions cannot exempt the first token (re-review N4).
    // `runClaudeCliProcess` hardcodes `'claude'`, but this function is exported and takes `cmd`
    // from its caller.
    assertShellSafeArg(cmd)
    for (const arg of args) assertShellSafeArg(arg)
    return rawSpawn(buildShellCommand(cmd, args), null, { ...base, shell: true })
  }
  return rawSpawn(resolved ?? cmd, args, base)
}

/** Spawn `claude` with `args`, write `opts.stdin` (the routine's prompt) to the child's stdin,
 *  capture stdout/stderr in full (a routine's response is never large enough to warrant streaming
 *  to disk), and enforce a hard wall-clock timeout — spec 20 §6's runaway-protection requirement.
 *  Only the timeout half is this module's: the loop-detection half is handled upstream, by the
 *  gateway the CLI is pointed at plus runaway-guard.ts's `ToolLoopTracker`.
 *
 *  The prompt belongs in `opts.stdin` and must NOT be put in `args` — see the module comment's C1
 *  section for why that is a security property and not a style preference.
 *
 *  Never rejects: a spawn failure (ENOENT, EACCES, or a refused shell argument) resolves with
 *  `exitCode: null` and the error message appended to stderr, so the caller has exactly one
 *  outcome shape to record on the RoutineRun rather than a try/catch plus a result branch.
 *
 *  `_killTree` is injectable for the same reason `_spawn` is, and it is NOT optional politeness:
 *  the OS-level sweep is fire-and-forget against a raw pid, so a test running against a FAKE child
 *  would otherwise send a real `taskkill /F /T` to whatever unrelated process currently owns that
 *  fake's pid number on the developer's machine. The injected spawn and the injected kill have to
 *  be swapped as a pair or the mock isn't actually a mock. */
export function runClaudeCliProcess(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number },
  _spawn: SpawnCliProcess = realSpawnCliProcess,
  _killTree: (pid: number) => void = killCliProcessTree,
): Promise<CliProcessResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? CLI_ROUTINE_TIMEOUT_MS
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    let child: CliChildProcess
    try {
      child = _spawn('claude', args, { cwd: opts.cwd, env: opts.env })
    } catch (e) {
      // A synchronous spawn throw (EINVAL from Node's own .cmd guard, or assertShellSafeArg)
      // takes the same shape as an async 'error' — the contract is "never rejects".
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${(e as Error).message}`, timedOut })
      return
    }

    let exited = false
    let exitCode: number | null = null
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    /** Absolute wall-clock instant after which this promise MUST be settled, set exactly once, by
     *  the wall-clock timer, and never moved afterwards. `undefined` until that timer fires — a run
     *  that finishes on its own is not on a deadline at all. */
    let hardDeadlineAt: number | undefined

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ exitCode, stdout, stderr, timedOut })
    }
    /** Exit seen but a pipe still open: settle once the pipes have been idle this long, so a
     *  descendant that never closes them cannot hold the run open (robust-bash.ts's shape).
     *
     *  Every request is CLAMPED to what is left of `hardDeadlineAt`, and that is what makes spec
     *  20 §6's timeout hard rather than soft (re-review 2026-08-01, N1). The window is re-armable
     *  by the child — each post-exit chunk of stdout pushes it out another 100 ms — and the
     *  wall-clock timer discharges its own responsibility into this same one timer, so before the
     *  clamp a chatty detached descendant writing faster than the grace window kept the promise
     *  pending forever: reproduced unsettled at 4000 ms with `timeoutMs: 300` against a claimed
     *  1300 ms bound. That is precisely the pi#5303 shape the trailing-output fix above exists for,
     *  turned from "output truncated" into "RoutineRun pinned at `running`, scheduler slot held,
     *  for a child the daemon has already killed" — the exact outcome the timeout was raised to
     *  prevent. Clamping (rather than a second timer) keeps ONE timer and covers every re-arm site
     *  by construction, including ones added later. `robust-bash.ts:81` has the un-clamped shape and
     *  is right to: it claims no wall-clock bound and its caller has an abort path. This module
     *  claims one. */
    const armGrace = (ms: number) => {
      const capped = hardDeadlineAt === undefined ? ms : Math.max(0, Math.min(ms, hardDeadlineAt - Date.now()))
      if (graceTimer) clearTimeout(graceTimer)
      graceTimer = setTimeout(finish, capped)
    }
    const finishIfDrained = () => {
      if (!exited || settled) return
      if (stdoutEnded && stderrEnded) finish()
    }

    const timer = setTimeout(() => {
      timedOut = true
      // Signal the direct child first — the one handle we definitely own — then sweep whatever
      // subprocesses it started. The direct kill is what makes the timeout observable at all when
      // the tree sweep is a no-op (a fake child, or a POSIX child that never became a group leader).
      try { child.kill('SIGKILL') } catch { /* already dead */ }
      if (child.pid) _killTree(child.pid)
      // Then settle regardless of whether the child cooperates: the kill is best-effort, so the
      // promise must not depend on it landing (see CLI_KILL_GRACE_MS). Stamping the deadline here
      // — once, before the grace window is armed — is what stops the child re-arming its way past
      // it; from now on `armGrace` can only ever shorten the remaining wait, never extend it.
      hardDeadlineAt = Date.now() + CLI_KILL_GRACE_MS
      armGrace(CLI_KILL_GRACE_MS)
    }, timeoutMs)

    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); if (exited) armGrace(EXIT_STDIO_GRACE_MS) })
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (exited) armGrace(EXIT_STDIO_GRACE_MS) })
    child.stdout?.once('end', () => { stdoutEnded = true; finishIfDrained() })
    child.stderr?.once('end', () => { stderrEnded = true; finishIfDrained() })
    // A stream-level error (EPIPE on a killed child is the common one) would otherwise throw out
    // of band with no handler attached. Record it and treat that pipe as finished — it will never
    // emit 'end' now, and the run's outcome is decided by the child's exit, not by the pipe.
    child.stdout?.on('error', (e: Error) => { stderr += `\n${e.message}`; stdoutEnded = true; finishIfDrained() })
    child.stderr?.on('error', (e: Error) => { stderr += `\n${e.message}`; stderrEnded = true; finishIfDrained() })

    // The prompt. Always end stdin, even when there is nothing to send, so a child that reads it
    // sees EOF instead of blocking forever.
    if (child.stdin) {
      child.stdin.on('error', (e: Error) => { stderr += `\n${e.message}` })
      child.stdin.end(opts.stdin ?? '')
    }

    child.on('error', (e: Error) => {
      if (settled) return
      stderr += `\n${e.message}`
      exitCode = null
      finish()
    })

    child.on('exit', (code: number | null) => {
      if (settled) return
      exited = true
      exitCode = code
      finishIfDrained()
      if (!settled) armGrace(EXIT_STDIO_GRACE_MS)
    })

    // Both pipes closed AND the child gone: nothing further can arrive.
    child.on('close', (code: number | null) => {
      if (settled) return
      if (!exited) exitCode = code
      finish()
    })
  })
}
