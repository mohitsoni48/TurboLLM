// The variables by which a parent tells the daemon "I supervise you", read once at boot and removed from
// process.env, so nothing the daemon starts inherits them.
//
// Before, the desktop app's TURBOLLM_DESKTOP=1 reached every child: a TurboLLM run from a desktop Code terminal or
// bash command took itself for the app's own daemon, and on a Settings restart exited 75 for an app that was not
// listening, so it simply ended. A stdin lifeline read the same way would be worse: a nested daemon whose stdin is
// /dev/null would shut down the moment it started (measured). So:
//   - TURBOLLM_LIFELINE=stdin:<pid> (the desktop app; a restart keeper, cli.ts becomeKeeper): shut down gracefully
//     when stdin ends. Honoured only when <pid> is this process's parent.
//   - TURBOLLM_SUPERVISOR=keeper:<pid>: the parent is the restart keeper, which starts a fresh daemon on exit 75.
//     Honoured only when <pid> is this process's parent.
//   - TURBOLLM_DESKTOP=1: the desktop app supervises this daemon (it respawns it on exit 75).
// A mismatch is logged and ignored. util/boot-env.test.ts checks that no other file reads these names from the
// environment.
//
// Test-only switches (TURBOLLM_TEST_*) are read here too, so the real cli.ts can be driven by cli.keeper.test.ts.
// They are left in the environment, so a restart's replacement sees them as well.

export interface BootEnvironment {
  /** Shut down gracefully when stdin ends: the parent holds its other end (TURBOLLM_LIFELINE=stdin:<ppid>). */
  stdinLifeline: boolean
  /** The restart keeper this daemon runs under (TURBOLLM_SUPERVISOR=keeper:<ppid>), or null. */
  keeperPid: number | null
  /** The desktop app supervises this daemon (TURBOLLM_DESKTOP=1). */
  desktop: boolean
  /** Test-only (TURBOLLM_TEST_STALL_RESTART=1): a Settings restart's teardown never settles, so the restart's 14 s
   *  watchdog finishes it. */
  testStallRestart: boolean
  /** Test-only (TURBOLLM_TEST_SLOW_SHUTDOWN_MS=<ms>): the signal shutdown's teardown takes this much longer, which
   *  makes the order of a keeper's and its replacement's endings visible. */
  testSlowShutdownMs: number
}

export const BOOT_ENV_NAMES = ['TURBOLLM_LIFELINE', 'TURBOLLM_SUPERVISOR', 'TURBOLLM_DESKTOP'] as const

let taken: BootEnvironment | null = null

/** A `<kind>:<pid>` value bound to the parent: true when it names `ppid`. */
function boundToParent(name: string, value: string | undefined, kind: string, ppid: number, log: (line: string) => void): boolean {
  if (value === undefined || value === '') return false
  const m = new RegExp(`^${kind}:(\\d+)$`).exec(value)
  if (m && Number(m[1]) === ppid) return true
  log(`${name}=${value} does not name this process's parent (pid ${ppid}); ignored`)
  return false
}

/** Read the supervision variables once, bind them to the parent's pid, and remove them from `env` (process.env).
 *  cli.ts calls it first thing, before anything is spawned; later calls return the same answer. */
export function takeBootEnvironment(env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid, log: (line: string) => void = (line) => console.warn(line)): BootEnvironment {
  if (taken) return taken
  const lifeline = env.TURBOLLM_LIFELINE
  const supervisor = env.TURBOLLM_SUPERVISOR
  const desktop = env.TURBOLLM_DESKTOP
  for (const name of BOOT_ENV_NAMES) delete env[name]
  const keeper = boundToParent('TURBOLLM_SUPERVISOR', supervisor, 'keeper', ppid, log)
  const slow = Number(env.TURBOLLM_TEST_SLOW_SHUTDOWN_MS)
  taken = {
    stdinLifeline: boundToParent('TURBOLLM_LIFELINE', lifeline, 'stdin', ppid, log),
    keeperPid: keeper ? ppid : null,
    // Strict '1': supervision is a promise the parent makes, never something inferred.
    desktop: desktop === '1',
    testStallRestart: env.TURBOLLM_TEST_STALL_RESTART === '1',
    testSlowShutdownMs: Number.isFinite(slow) && slow > 0 ? slow : 0,
  }
  return taken
}

/** The answer takeBootEnvironment gave (it takes it now when nothing has yet: a test, or a module used alone). */
export function bootEnvironment(): BootEnvironment {
  return taken ?? takeBootEnvironment()
}

/** Test-only: forget the answer, so the next take reads the environment again. */
export function _resetBootEnvironment(): void {
  taken = null
}
