// Whether a Python engine's environment was left whole by the last install. `uv pip install <pkg>` answers "Checked
// 1 package" and installs NOTHING when the version is already satisfied, so an Install over a venv that an earlier
// install did not finish (a Cancel, a crash, the daemon dying with its tethered install) registered an engine whose
// files were still broken. LiteRT-LM answered with `--reinstall` on every plain Install, which also rewrote a
// complete environment each time (multi-GB of torch and CUDA wheels for the others: a copy when uv's cache is on
// another filesystem, a download after a cache prune), and the other engines never redid one at all.
//
// The marker is written after the install and its probe have both succeeded, and removed before an install starts,
// so its absence beside an existing venv means the last install did not finish. A plain Install then passes
// `--reinstall`; an Install over a finished environment, or into a new venv, passes nothing; an Update keeps its own
// upgrade flag (a version bump rewrites what it changes). A venv from before the marker existed has none, so its next
// plain Install redoes it once.
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PY_ENV_MARKER = '.turbollm-install-complete'

/** Start an install into `envDir` (whose interpreter is `python`): whether the plain install must redo the
 *  environment, read before the marker is removed. Call it right before the venv is created or reused. */
export function beginPyEnvInstall(envDir: string, python: string): { reinstall: boolean } {
  const marker = join(envDir, PY_ENV_MARKER)
  const reinstall = existsSync(python) && !existsSync(marker)
  rmSync(marker, { force: true })
  return { reinstall }
}

/** The install and its probe succeeded: the environment is whole. */
export function finishPyEnvInstall(envDir: string): void {
  writeFileSync(join(envDir, PY_ENV_MARKER), `${new Date().toISOString()}\n`)
}

/** The flags of `uv pip install`: an Update's own upgrade flag, else `--reinstall` for an unfinished environment. */
export function pyInstallFlags(o: { upgrade: boolean; upgradeFlag: '-U' | '--upgrade'; reinstall: boolean }): string[] {
  if (o.upgrade) return [o.upgradeFlag]
  return o.reinstall ? ['--reinstall'] : []
}
