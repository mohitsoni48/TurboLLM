// Decides how a restart's teardown ends: the old process becomes the keeper of its replacement, exit 75 for a
// supervisor, or exit only (spec 08 §2, ADR-442). Pure on purpose, so it imports nothing.

/** Exit status a supervised daemon uses to ask its supervisor to start a fresh one.
 *  MIRRORED in wrapper/daemon-supervisor.js; change both or neither (both test suites pin it).
 *  75 = sysexits EX_TEMPFAIL ("temporary, retry"): readable in a log, outside Node's reserved
 *  exit codes (1,3-7,9,10,12,13), below the 128+signal range, and produced by no other path. */
export const RESTART_REQUESTED_EXIT_CODE = 75

export type RestartExitPlan =
  // npm/CLI, Docker, a service: the old process stays as a thin keeper in the terminal's (or the container's)
  // foreground, starts the replacement as its own child, and exits with it (cli.ts becomeKeeper).
  | { kind: 'become-keeper'; exitCode: 0 }
  // The desktop app or a keeper supervises this daemon: exit 75, and the supervisor starts the fresh one.
  | { kind: 'supervisor-respawn'; exitCode: typeof RESTART_REQUESTED_EXIT_CODE }
  // The app-update helper relaunches the daemon.
  | { kind: 'exit-only'; exitCode: 0 }

/** Pure. exitOnly wins over supervision (the update path's contract never changes). `supervised`: the desktop app
 *  or a restart keeper is this daemon's parent, as util/boot-env.ts bound it at boot. */
export function planRestartExit(opts: { exitOnly: boolean; supervised: boolean }): RestartExitPlan {
  if (opts.exitOnly) return { kind: 'exit-only', exitCode: 0 }
  if (opts.supervised) return { kind: 'supervisor-respawn', exitCode: RESTART_REQUESTED_EXIT_CODE }
  return { kind: 'become-keeper', exitCode: 0 }
}
