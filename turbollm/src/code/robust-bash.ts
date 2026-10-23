// Robust bash tool operations for Code (founder-reported gap, 2026-07-17: "the stop button in
// code is very weak. most of the time it doesn't work and waits for completion").
//
// Root cause, confirmed via live, repeated, timed testing against a real running daemon (not
// just code reading): pi-coding-agent's own built-in bash tool (createLocalBashOperations,
// @earendil-works/pi-coding-agent/dist/core/tools/bash.js) already wires the abort signal
// correctly all the way from CodeRunManager.stop() through AgentSession.abort() to a REAL
// killProcessTree(child.pid) call on the spawned shell — the whole chain is genuinely fast when
// it works (~300ms, verified with GPU/process-tree telemetry). But it is NOT reliable: on
// Windows, pi's bash tool spawns commands through Git Bash's bash.exe (an MSYS2-based POSIX
// emulation layer — see getShellConfig()'s own preference order), and Windows' native
// `taskkill /F /T /PID <pid>` (pi's own kill mechanism, utils/shell.js's killProcessTree) does
// not always correctly walk descendants spawned through that layer. Measured live: 3 of 4
// identical trials killed the full process tree in ~300ms; one trial left the spawned process
// (and its own children) running for 10+ seconds past the "aborted" state already showing in the
// UI/DB — a real orphaned process silently still consuming resources while TurboLLM had already
// told the user the turn stopped. That intermittency ("most of the time") is the founder's exact
// report.
//
// Fix: a drop-in replacement for pi's bash tool operations (BashOperations — the same public
// extension point createCodingTools/createBashTool already accept) that does everything pi's own
// implementation does, but VERIFIES the kill actually took effect instead of firing-and-trusting,
// and escalates to an independent, WMI-based descendant enumeration (proven reliable in the same
// live testing — it correctly reported the full bash.exe -> bash.exe -> ping.exe ancestry in
// every trial, including the one where taskkill's own internal tree-walk silently failed) when
// the first attempt doesn't verify within a bounded grace window. Never silently reports success
// it didn't confirm — logs a warning on the rare case even the escalation can't confirm, so a
// recurrence leaves forensic evidence instead of a silent lie (same discipline as this codebase's
// other defensive fallbacks, e.g. code-session.ts's history-seed retry).
//
// waitForChildProcess below is adapted verbatim from pi-coding-agent's own
// utils/child-process.js (MIT-licensed, same package already a direct dependency here) — NOT
// reimplemented from scratch, since it defends against a real, specific, already-fixed upstream
// bug (earendil-works/pi#5303: a detached descendant holding stdout/stderr open past its parent's
// own exit must not have its trailing output truncated by a naive fixed-deadline wait). Copied
// rather than imported because pi-coding-agent's package.json restricts `exports` to its public
// entry point only — this utility isn't reachable via a subpath import.
import { access as fsAccess } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { getShellConfig } from '@earendil-works/pi-coding-agent'
import type { BashOperations } from '@earendil-works/pi-coding-agent'
import { killTetheredTree, spawnHeld, tetherPlatform } from '../util/tether'
import { withForegroundGitGc } from '../util/git-gc'

const EXIT_STDIO_GRACE_MS = 100

/** Windows: what a command waits behind until its job exists (see exec below). Exported for its test. bash's `read`
 *  takes an exported TMOUT for its timeout when it is given no -t (CIS hardening sets TMOUT=900), and a plain `read`
 *  then let the command start TMOUT seconds in, untied. So the gate's read has a -t of a day, which keeps TMOUT out of
 *  it in every bash (3.2, macOS's, on), TMOUT readonly or not, and is never reached: the line is written within 2 s of
 *  the spawn (TIE_WAIT_MS in util/tether.ts), and the daemon's death gives the read EOF. Reading again after a timeout
 *  would not do under bash 3.2, whose timed-out read returns 1, as at EOF; nor would `TMOUT= read` where TMOUT is
 *  readonly (a BASH_ENV can make it so): the assignment fails and the read still times out. The command keeps TMOUT.
 *  A shellPath set to a shell whose read has no -t (dash) gets the plain read after it, which waits there (dash's read
 *  takes no TMOUT); its "Illegal option -t" goes to /dev/null, not into the command's output. At EOF the plain read
 *  returns at once too. */
export const TIE_GATE = 'IFS= read -t 86400 -r _ 2>/dev/null || IFS= read -r _; exec </dev/null; '

/** Adapted from pi-coding-agent's utils/child-process.js — see module comment above. */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let exited = false
    let exitCode: number | null = null
    let postExitTimer: ReturnType<typeof setTimeout> | undefined
    let stdoutEnded = child.stdout === null
    let stderrEnded = child.stderr === null
    const cleanup = () => {
      if (postExitTimer) { clearTimeout(postExitTimer); postExitTimer = undefined }
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.removeListener('close', onClose)
      child.stdout?.removeListener('end', onStdoutEnd)
      child.stderr?.removeListener('end', onStderrEnd)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
    }
    const finalize = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(code)
    }
    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return
      if (stdoutEnded && stderrEnded) finalize(exitCode)
    }
    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer)
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS)
    }
    const onData = () => { if (exited && !settled) armIdleTimer() }
    const onStdoutEnd = () => { stdoutEnded = true; maybeFinalizeAfterExit() }
    const onStderrEnd = () => { stderrEnded = true; maybeFinalizeAfterExit() }
    const onError = (err: Error) => { if (settled) return; settled = true; cleanup(); reject(err) }
    const onExit = (code: number | null) => {
      exited = true
      exitCode = code
      maybeFinalizeAfterExit()
      if (!settled) armIdleTimer()
    }
    const onClose = (code: number | null) => finalize(code)
    child.stdout?.once('end', onStdoutEnd)
    child.stderr?.once('end', onStderrEnd)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
    child.once('close', onClose)
  })
}

/** Portable "is this pid still alive" check — signal 0 is a no-op existence probe on every
 *  platform Node supports, including Windows. ESRCH = gone; EPERM = alive but unsignalable
 *  (still counts as alive — an unrelated permission boundary, not evidence of death). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Windows-only escalation: enumerate every live descendant of `rootPid` via WMI (reliable in
 *  live testing even in the exact trial where taskkill's own internal /T tree-walk silently
 *  failed to reach the same processes) and kill each one individually with a plain, non-tree
 *  taskkill — sidestepping whatever /T's own walk gets wrong for an MSYS2-rooted tree. Returns
 *  the pids it attempted to kill, for logging. */
async function killDescendantsViaWmi(rootPid: number): Promise<number[]> {
  const psScript =
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; ` +
    `$ids = @(${rootPid}); $frontier = @(${rootPid}); ` +
    `for ($i = 0; $i -lt 8; $i++) { ` +
    `  $children = $all | Where-Object { $frontier -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId; ` +
    `  if (-not $children) { break }; $ids += $children; $frontier = $children ` +
    `}; ` +
    `$ids | Select-Object -Unique | ForEach-Object { Write-Output $_ }`
  const pids = await new Promise<number[]>((resolve) => {
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => {
      const found = out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0)
      resolve([...new Set(found)])
    })
    proc.on('error', () => resolve([]))
  })
  for (const pid of pids) {
    try { spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', detached: true, windowsHide: true }) } catch { /* best-effort */ }
  }
  return pids
}

/** First attempt — same mechanism pi's own killProcessTree uses (fast, works most of the time,
 *  per live testing: ~300ms in 3 of 4 trials). Kept identical to pi's own approach here rather
 *  than skipping straight to the WMI escalation on every call, since that escalation costs a real
 *  process spawn (~100-300ms) this fast path avoids on the common case. */
function killProcessTreeFast(pid: number): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', detached: true, windowsHide: true }) } catch { /* best-effort */ }
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch {
      try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
    }
  }
}

const VERIFY_GRACE_MS = 800
const VERIFY_POLL_MS = 100
const FINAL_VERIFY_MS = 1500

/** Whether Node has seen `child` exit. From then on its pid may name another process: Node has
 *  reaped it (on Windows, libuv has closed the handle that kept the number from being reused). */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Kill the command's whole process tree and VERIFY it actually died instead of firing-and-trusting —
 *  see the module comment for why: pi's own equivalent (killProcessTree) is correct in mechanism
 *  but intermittently ineffective against a Git-Bash-rooted tree on Windows. Escalates to a
 *  WMI-based descendant kill only when the fast path doesn't verify within `VERIFY_GRACE_MS`.
 *
 *  Stop or the timeout can come after the shell itself has exited: a job it left that still writes
 *  to its output keeps the command waiting (waitForChildProcess), for as long as it writes at least
 *  every EXIT_STDIO_GRACE_MS. Node has reaped the shell by then, so its pid may name another process:
 *  a `taskkill /F /T /PID` of it, the group kill's bare-pid fallback or the escalation would end that
 *  one, or its tree. Then the tether's own force path (killTetheredTree, util/tether.ts) ends what it
 *  can without the pid: the command's group while its watcher still pins the group id, or on Windows
 *  the command's job, where it has one. The same holds for the verification: a shell Node has seen
 *  exit is dead, whatever a reused pid answers. */
async function killProcessTreeVerified(child: ChildProcess, sessionLabel: string): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (hasExited(child)) {
    killTetheredTree(child, 'SIGKILL')
    return
  }
  killProcessTreeFast(pid)
  const gone = () => hasExited(child) || !isAlive(pid)
  const deadline = Date.now() + VERIFY_GRACE_MS
  while (Date.now() < deadline) {
    if (gone()) return
    await sleep(VERIFY_POLL_MS)
  }
  if (gone()) return
  console.warn(`[code-session:${sessionLabel}] bash process ${pid} still alive ${VERIFY_GRACE_MS}ms after abort — escalating to WMI-based descendant kill`)
  if (process.platform === 'win32') {
    const killed = await killDescendantsViaWmi(pid)
    console.warn(`[code-session:${sessionLabel}] WMI escalation targeted ${killed.length} process(es): ${killed.join(', ')}`)
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
  }
  await sleep(FINAL_VERIFY_MS)
  if (!gone()) {
    console.warn(`[code-session:${sessionLabel}] bash process ${pid} SURVIVED the WMI escalation — giving up, it may still be running orphaned`)
  }
}

/** Drop-in replacement for pi-coding-agent's createLocalBashOperations with a verified,
 *  escalating kill on abort/timeout instead of a fire-and-forget one. Everything else (shell
 *  resolution, spawn shape, streaming, stdio wiring, exit-vs-close draining) matches pi's own
 *  implementation — only the kill path changes. `sessionLabel` is purely for the warning logs
 *  above (a Code session id), so a recurrence is traceable to which session hit it.
 *
 *  Each command is tethered to the daemon (util/tether.ts) and held in the Code session's scope
 *  (`code-session:<sessionId>`; a skill or delegate sub-session passes its parent's id, and without one
 *  the label is the scope): what a command leaves running in the background (`npm run dev &`, a `nohup`
 *  server) keeps running after the command returns, until the session is archived or deleted, a
 *  routine's run ends, or the daemon stops, however it stops. Before, it was cut loose: a SIGKILLed or
 *  crashed daemon left it running, parented to init, and even a graceful stop never ended it. A command
 *  that left nothing running holds nothing. Stop and the timeout still kill the command's whole group,
 *  also once the shell has exited while a job it left still writes to its output (through the tether,
 *  never the shell's pid). */
export function createRobustBashOperations(options?: { shellPath?: string; sessionLabel: string; sessionId?: string }): BashOperations {
  const scope = `code-session:${options?.sessionId ?? options?.sessionLabel ?? 'unknown'}`
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error('aborted')
      const shellConfig = getShellConfig(options?.shellPath)
      try {
        await fsAccess(cwd, constants.F_OK)
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
      }
      const commandFromStdin = shellConfig.commandTransport === 'stdin'
      // Windows: the command starts only once its tie exists. The job sentinel puts the shell in a job of its own
      // (util/tether.ts), but a command that returns within milliseconds (`nohup srv &`, `cmd //c start srv`) could
      // leave srv running, born outside that job, before the tie was made. So the shell first waits for one line on
      // a stdin pipe, which is written once the sentinel has answered for it (or after 2 s; at once without a
      // sentinel), whatever TMOUT says (TIE_GATE), and then gives the command /dev/null as its stdin, as before. A
      // shell that takes its command on stdin (WSL's bash) simply gets the command then.
      const gate = tetherPlatform() === 'win32'
      // The command leads a process group of its own (the tether makes it one, as `detached` did), which is what
      // killProcessTreeVerified's group kill needs. git's automatic gc runs in the foreground, inside that group:
      // daemonized (setsid), it escaped the tie (util/git-gc.ts).
      const { child, tied } = spawnHeld(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, gate ? `${TIE_GATE}${command}` : command],
        {
          cwd,
          env: withForegroundGitGc(env ?? process.env),
          stdio: [commandFromStdin || gate ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
        { kind: 'code-bash', hold: scope },
      )
      if (commandFromStdin || gate) child.stdin?.on('error', () => { /* best-effort */ })
      if (commandFromStdin && gate) void tied.then(() => child.stdin?.end(command))
      else if (commandFromStdin) child.stdin?.end(command)
      else if (gate) void tied.then(() => child.stdin?.end('\n'))

      let timedOut = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => { void killProcessTreeVerified(child, options?.sessionLabel ?? 'unknown') }

      try {
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            void killProcessTreeVerified(child, options?.sessionLabel ?? 'unknown')
          }, timeout * 1000)
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
        const exitCode = await waitForChildProcess(child)
        if (signal?.aborted) throw new Error('aborted')
        if (timedOut) throw new Error(`timeout:${timeout}`)
        return { exitCode }
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
