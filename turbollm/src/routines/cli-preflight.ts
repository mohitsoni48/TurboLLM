// Spec 20 §6's "CLI not authenticated/available" precondition: a CLI-flavor Code Routine must
// be SKIPPED and FLAGGED, never crash and never silently no-op, when the terminal-agent CLI
// isn't installed. `claude --version` is the cheapest possible probe — it exits 0 whether or
// not the CLI is authenticated against a real gateway, but a missing binary (ENOENT) is by far
// the common real-world case this guards (a fresh install, or a routine created on one machine
// and the daemon later run on another). Authentication itself isn't separately probe-able here:
// the CLI is pointed at TurboLLM's OWN local gateway, which enforces no auth (cli-launch.ts's
// AUTH_TOKEN comment: "No auth is enforced on the local gateway; the CLI just needs a non-empty
// token") — so "installed" is the only real precondition failure mode for THIS gateway, unlike
// a real cloud Anthropic account which could also be unauthenticated.
//
// The probe runs through cli-launch.ts's `realRunCommandWithin` (its `startRunCommand`): the
// resolved executable WITHOUT a shell, except a `.cmd`/`.bat` shim (an npm-installed CLI on
// Windows) or a name not found on PATH, which run under the platform shell (cmd.exe, sh) with
// each argument quoted by `buildShellCommand`, so a missing CLI fails at once (sh's 127);
// startRunCommand's comment says why a bare spawn of a shim's name fails on Windows. The probe is
// tethered, and at VERSION_PROBE_DEADLINE_MS its whole tree is ended.
import { realRunCommandWithin, type BoundedRunCommand } from '../cli-launch'

/** How long `<bin> --version` may run before it is ended (isCliAvailable). A healthy CLI answers well within it: pi's
 *  takes about 0.9 s here, and about 2 s with every CPU busy twice over; a Windows `.cmd` shim adds cmd.exe's start
 *  to that. For the Code agent picker its end costs a slow but healthy CLI nothing (it counts as installed then), so
 *  the bound only has to leave the picker an answer while a wedged one holds its probe. A routine's run is skipped
 *  then ("Skipped (cli_unavailable)" in its history; it fires again on its schedule or by Run now), so the bound is
 *  also the slowest `--version` a routine waits for: about ten times pi's. */
export const VERSION_PROBE_DEADLINE_MS = 10_000

/** `<bin> --version` — the cheapest "is it installed" probe, per harness. Every CLI TurboLLM can
 *  launch supports it (verified: claude 2.1.232, pi 0.82.1, opencode 1.18.9 all exit 0 and print a
 *  version), so this needs no per-harness special-casing.
 *
 *  One that has not answered at `deadlineMs` is ended, its whole tree (realRunCommandWithin), and `onTimeout` says what
 *  that answer is, with one line in the log for it. The probe used to have no deadline: one that never answered left
 *  its caller waiting for good.
 *  - 'installed', the Code agent picker's (the default): it was found and started (a missing one fails at once: its
 *    name runs under the platform shell, which exits with its not-found code, sh's 127), so "not installed" would be
 *    wrong, and the picker would refuse a CLI that is there and offer to install it again. Its terminal then shows
 *    what the CLI does.
 *  - 'unavailable', a routine's preflight (execute.ts): the run is skipped ('cli_unavailable') before it touches the
 *    model or the gate. Read as installed, the run would go on with a CLI that does not answer: swap in its pinned
 *    model and hold it until its own bound (10 minutes for a one-shot run, up to 30 parked for an interactive one). */
export async function isCliAvailable(
  bin: string,
  run: BoundedRunCommand = realRunCommandWithin,
  deadlineMs = VERSION_PROBE_DEADLINE_MS,
  onTimeout: 'installed' | 'unavailable' = 'installed',
): Promise<boolean> {
  const answer = await run(bin, ['--version'], deadlineMs)
  if (answer !== 'timeout') return answer
  if (onTimeout === 'unavailable') {
    console.warn(`[routines] \`${bin} --version\` did not answer within ${deadlineMs} ms: it was ended, and the routine skips ${bin}`)
    return false
  }
  console.warn(`[agents] \`${bin} --version\` did not answer within ${deadlineMs} ms: it was ended, and ${bin} counts as installed (it started)`)
  return true
}

/** Back-compat alias for `isCliAvailable('claude', run)`, so with the picker's reading of a probe that times out (the
 *  routines' preflights pass 'unavailable': execute.ts). Prefer `isCliAvailable(bin)`. */
export async function isClaudeCliAvailable(run: BoundedRunCommand = realRunCommandWithin): Promise<boolean> {
  return isCliAvailable('claude', run)
}
