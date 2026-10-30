// git's automatic gc is the common real case of a process that escapes the daemon's tie (util/tether.ts): `git
// commit` (and fetch, merge, …) can start `git gc --auto` (since 2.29 through `git maintenance run --auto`), and gc
// daemonizes with setsid(), out of every process group and session, so neither the lifeline's group kill nor a Code
// terminal's session sweep reaches it. Measured with git 2.43, 3000 loose objects and gc.auto=1: a plain commit left
// `git gc --auto --quiet` running in a session of its own; `-c maintenance.auto=false -c gc.auto=0` ran no gc; the
// autoDetach pair (as flags or through GIT_CONFIG_COUNT) ran it in the foreground, about 0.5 s longer, and left
// nothing.

/** For TurboLLM's own git calls: no automatic gc at all. A foreground gc in a large repository could turn a commit
 *  that succeeded into "timed out", and the user's own git still collects garbage on the shared object store. */
export const NO_AUTO_GC_ARGS: readonly string[] = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0']

/** For a Code agent's bash commands and a Code terminal's shell: git's automatic gc still runs, in the foreground,
 *  inside the command's tied group. The two entries go after any GIT_CONFIG_COUNT entries `env` already has. */
export function withForegroundGitGc(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = Number(env.GIT_CONFIG_COUNT)
  const n = Number.isInteger(count) && count > 0 ? count : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'gc.autoDetach',
    [`GIT_CONFIG_VALUE_${n}`]: 'false',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'maintenance.autoDetach',
    [`GIT_CONFIG_VALUE_${n + 1}`]: 'false',
  }
}
