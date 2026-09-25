// Installing (or updating) the Laya engine, as POST /api/v1/engines/laya runs it in the background: provision the
// venv with progress reported on /status, then register the engine — never activating it (Registry.addLaya).
import { layaStatus } from '../api/laya-status'
import type { Deps } from '../deps'
import { ensureLayaEnv } from './laya'

export type LayaInstallDeps = Pick<Deps, 'provision' | 'registry'>

export async function installLayaEngine(
  d: LayaInstallDeps,
  enginesRoot: string,
  upgrade: boolean,
  ensureEnv: typeof ensureLayaEnv = ensureLayaEnv,
): Promise<void> {
  try {
    d.provision.start('laya', 'runtime_env')
    const rt = await ensureEnv(enginesRoot, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), upgrade)
    d.registry.addLaya(`Laya (${rt.version})`, rt.python, rt.version)
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not install Laya: ${e instanceof Error ? e.message : e}`)
  }
}

/** Why the Laya engine cannot be installed or updated right now, or null. Both rewrite the venv the running engine is
 *  executing from, which on Windows leaves it broken. */
export function layaEngineBusy(d: Pick<Deps, 'modelRouter' | 'scanner'>): string | null {
  return layaStatus(d) === null ? null : 'Eject the Laya model before installing or updating the Laya engine.'
}
