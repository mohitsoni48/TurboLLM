// Installing (or updating) the Laya engine, as POST /api/v1/engines/laya runs it in the background: provision the
// venv with progress reported on /status, then register the engine — never activating it (Registry.addLaya).
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
