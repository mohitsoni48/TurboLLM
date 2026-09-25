// Decides how a restart's teardown ends: self-respawn, exit 75 for the desktop supervisor, or exit
// only (spec 08 §2, ADR-442). Pure on purpose, so it imports nothing.

/** Exit status a supervised daemon uses to ask its supervisor to start a fresh one.
 *  MIRRORED in wrapper/daemon-supervisor.js; change both or neither (both test suites pin it).
 *  75 = sysexits EX_TEMPFAIL ("temporary, retry"): readable in a log, outside Node's reserved
 *  exit codes (1,3-7,9,10,12,13), below the 128+signal range, and produced by no other path. */
export const RESTART_REQUESTED_EXIT_CODE = 75

/** True when the desktop wrapper spawned this daemon and has promised to respawn it on
 *  RESTART_REQUESTED_EXIT_CODE (wrapper/main.js sets TURBOLLM_DESKTOP=1). Strict '1', and
 *  deliberately NOT classifyInstall's `/resources/daemon/` path fallback: supervision is a
 *  promise the parent makes, never something inferred from where the files live. */
export function isDesktopSupervised(env: NodeJS.ProcessEnv): boolean {
  return env.TURBOLLM_DESKTOP === '1'
}

export type RestartExitPlan =
  | { kind: 'self-respawn'; exitCode: 0 }                                          // npm/CLI: today's path
  | { kind: 'supervisor-respawn'; exitCode: typeof RESTART_REQUESTED_EXIT_CODE }  // desktop
  | { kind: 'exit-only'; exitCode: 0 }                                             // app-update helper relaunches

/** Pure. exitOnly wins over supervision (the update path's contract never changes). */
export function planRestartExit(opts: { exitOnly: boolean; supervised: boolean }): RestartExitPlan {
  if (opts.exitOnly) return { kind: 'exit-only', exitCode: 0 }
  if (opts.supervised) return { kind: 'supervisor-respawn', exitCode: RESTART_REQUESTED_EXIT_CODE }
  return { kind: 'self-respawn', exitCode: 0 }
}
