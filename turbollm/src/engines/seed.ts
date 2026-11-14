// Auto-provision a default engine on first run (ADR-024 + ADR-025). Detects the
// GPU vendor, downloads the fastest llama.cpp backend it supports, and registers
// it — trying the recommended backend, then Vulkan, then CPU if one won't probe.
// No-ops if any engine is already configured, or once it has seeded (Config.defaultEngineSeeded). Never throws.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Registry } from './registry'
import type { ConfigStore } from '../config/config'
import type { ProvisionState } from './provision-state'
import { amdApuOnly, getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { LLAMA_BUILD, fallbackChain, provisionBackend, recommendBackendId, type BackendId, type ProvisionProgress } from './download'

const VALID_BACKENDS: BackendId[] = ['cuda', 'rocm', 'sycl', 'vulkan', 'metal', 'cpu']

/** Installs and selects the default llama.cpp build on a first run only (Config.defaultEngineSeeded). It ran on every
 *  start that found no engine registered, so once the user had removed every engine (Disabled or Deleted the only one,
 *  or deleted a managed build's folder by hand, which the start unregisters) the next start registered the default
 *  build again, the one on disk or a fresh download, and selected it: the next automatic load ran on an engine the user
 *  never selected. An engine registered before this runs (Android's bundled ones) marks the seed as done too. */
export async function seedDefaultEngines(
  registry: Registry,
  enginesRoot: string,
  provision: ProvisionState,
  store: Pick<ConfigStore, 'snapshot' | 'update'>,
): Promise<void> {
  // Best-effort, as the seed never throws: a config that cannot be saved seeds again at the next start, as before.
  const markSeeded = () => {
    try {
      store.update((c) => { c.defaultEngineSeeded = true })
    } catch (e) {
      console.warn(`seed: could not record the first-run seed (${e instanceof Error ? e.message : e})`)
    }
  }
  if (registry.list().engines.length > 0) {
    if (!store.snapshot().defaultEngineSeeded) markSeeded()
    return
  }
  if (store.snapshot().defaultEngineSeeded) return

  const tag = LLAMA_BUILD
  const sys = getSysInfo()
  const vendor = primaryVendor(sys)
  const hasGpu = sys.gpus.length > 0

  // Escape hatch for environments where live GPU detection can't see the real
  // target hardware — the main case is pre-baking a Docker image at build time
  // (deploy/runpod/Dockerfile): `docker build` never has GPU passthrough, so
  // detection always reports "no GPU" and would otherwise always pre-bake the
  // CPU backend even for an image explicitly built for an NVIDIA GPU box.
  const forced = process.env.TURBOLLM_SEED_BACKEND as BackendId | undefined

  let chain: Awaited<ReturnType<typeof fallbackChain>>
  try {
    const recommended = forced && VALID_BACKENDS.includes(forced)
      ? forced
      : recommendBackendId(vendor, hasGpu, tag, amdApuOnly(sys))
    chain = fallbackChain(recommended, tag)
    if (forced) {
      console.log(`seed: TURBOLLM_SEED_BACKEND=${forced} → backend ${recommended} (skipping live GPU detection)`)
    } else {
      console.log(`seed: detected GPU vendor=${vendor} (${sys.gpus.map((g) => g.name).join(', ') || 'none'}) → backend ${recommended}`)
    }
  } catch (e) {
    console.warn(`seed: ${e instanceof Error ? e.message : e}`)
    return
  }

  const onProgress = (id: string) => (p: ProvisionProgress) => {
    provision.progress(p.phase, p.pct, p.part, p.parts)
    const partTag = (p.parts ?? 1) > 1 ? ` (part ${p.part}/${p.parts})` : ''
    if (p.phase === 'downloading' && p.pct >= 0) {
      process.stdout.write(`\rseed: downloading ${id} engine${partTag} ${Math.round(p.pct * 100)}%   `)
    } else if (p.phase === 'extracting') {
      process.stdout.write(`\rseed: extracting ${id} engine${partTag}…            `)
    }
  }

  let lastError: string | undefined
  for (const backend of chain) {
    try {
      provision.start(backend.id, 'seed')
      const binPath = await provisionBackend(enginesRoot, backend, tag, onProgress(backend.id))
      process.stdout.write('\n')
      // registry.add() probes the binary; a GPU build with no runtime throws here.
      await registry.add(`llama.cpp ${tag} (${backend.id})`, binPath)
      markSeeded()
      provision.done()
      console.log(`seeded default engine: llama.cpp ${tag} (${backend.id})`)
      return
    } catch (e) {
      process.stdout.write('\n')
      lastError = e instanceof Error ? e.message : String(e)
      console.warn(`seed: ${backend.id} engine unavailable (${lastError})`)
      // try next backend in the fallback chain
    }
  }
  // Surface the real last-backend error alongside the generic message — a bare "could not
  // download" hides whether it was actually a network failure, a bad archive, or (Android's
  // real-world case) the download succeeding but the binary failing its post-download probe.
  provision.fail(`Could not download a default engine.${lastError ? ` [${lastError}]` : ' Check your connection or add one manually.'}`)
  console.warn('seed: could not provision a default engine — add one manually in Settings.')
}

/** The packaged Android app imports models into `<HOME>/models` (TurboLLM-Android ModelImport.kt; HOME is the app's
 *  files dir), so that folder is always one of the model folders there, added before the first scan. The app also
 *  registers it after an import, but that request can fail (the daemon still starting at first launch), and the
 *  imported models must not then sit in an unscanned folder. A no-op outside the packaged app, Termux included. */
export function ensureAndroidModelsDir(store: Pick<ConfigStore, 'snapshot' | 'update'>, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.TURBOLLM_ANDROID_NATIVE_LIB_DIR) return
  const dir = join(homedir(), 'models')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  if (store.snapshot().modelDirs.includes(dir)) return
  store.update((cfg) => {
    if (!cfg.modelDirs.includes(dir)) cfg.modelDirs.push(dir)
  })
}
