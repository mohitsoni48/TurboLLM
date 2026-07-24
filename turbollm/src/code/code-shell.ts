// `!command` / `!!command` shell escape hatch (ADR-258) — the USER (not the model) runs a real
// shell command straight from the Code composer, in the session's own repo root. `!` feeds the
// output back to the model as context (persisted as a user message by the route); `!!` is a
// transcript-only peek that never enters model context.
//
// Runs through createRobustBashOperations — the SAME verified-kill bash wrapper the agent's own
// bash tool uses (robust-bash.ts) — so the command executes with the identical shell resolution,
// spawn shape, and abort/timeout kill discipline, in the session `repoRoot` as cwd. No shell-string
// injection surface: the user's command is handed to the shell verbatim as the command to run (the
// intended behavior of a shell escape — the user IS the author), never concatenated into a larger
// script we build. A hard output cap and wall-clock timeout bound a runaway command.
import { createRobustBashOperations } from './robust-bash'

/** Default ceilings — a `!command` is an interactive peek, not a build: keep output bounded so a
 *  chatty command can't blow up the transcript or the next turn's context window, and time-box it
 *  so a hung command can't wedge the composer. */
export const SHELL_MAX_OUTPUT = 100_000 // characters
export const SHELL_TIMEOUT_SEC = 60

export interface ShellRunResult {
  command: string
  /** Combined stdout+stderr, capped at `maxOutput` characters. */
  output: string
  /** Process exit code, or null when it was killed/terminated without one. */
  exitCode: number | null
  /** True when the process was killed for exceeding `timeoutSec`. */
  timedOut: boolean
  /** True when `output` was cut off at the cap. */
  truncated: boolean
}

/** Run one user-typed shell command in `repoRoot`. Never throws for a non-zero exit or a timeout —
 *  those are normal outcomes reported in the result; it only rejects if the shell itself can't be
 *  spawned (e.g. the cwd vanished). `sessionLabel` is threaded to robust-bash purely for its
 *  kill-escalation warning logs. */
export async function runShellCommand(
  command: string,
  repoRoot: string,
  sessionLabel: string,
  opts?: { maxOutput?: number; timeoutSec?: number; signal?: AbortSignal },
): Promise<ShellRunResult> {
  const maxOutput = opts?.maxOutput ?? SHELL_MAX_OUTPUT
  const timeoutSec = opts?.timeoutSec ?? SHELL_TIMEOUT_SEC
  const ops = createRobustBashOperations({ sessionLabel })

  let output = ''
  let truncated = false
  const onData = (chunk: Buffer | string) => {
    if (truncated) return
    output += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (output.length > maxOutput) {
      output = output.slice(0, maxOutput)
      truncated = true
    }
  }

  const signal = opts?.signal ?? new AbortController().signal
  try {
    const { exitCode } = await ops.exec(command, repoRoot, { onData, signal, timeout: timeoutSec, env: process.env })
    return { command, output, exitCode, timedOut: false, truncated }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // robust-bash throws `timeout:<sec>` when it kills a command for exceeding the wall clock —
    // report that as a normal (timed-out) result with whatever output was captured before the kill,
    // rather than a 500. An abort (the caller cancelled) rethrows.
    if (msg.startsWith('timeout:')) return { command, output, exitCode: null, timedOut: true, truncated }
    throw e
  }
}

/** The user-message body a `!command` (feed-to-model) persists — what the model reads back as
 *  context on the next turn (seedPriorHistory replays a user message's `content` verbatim). Framed
 *  as the user reporting a command THEY ran, so the model never mistakes it for a tool IT called. */
export function shellContextText(result: ShellRunResult): string {
  const body = result.output.trim() || '(no output)'
  const status = result.timedOut
    ? ` (timed out after ${SHELL_TIMEOUT_SEC}s)`
    : result.exitCode !== null && result.exitCode !== 0
      ? ` (exit code ${result.exitCode})`
      : ''
  const trunc = result.truncated ? '\n…(output truncated)' : ''
  return `I ran a shell command in the repo${status}:\n\n$ ${result.command}\n\n${body}${trunc}`
}
