// Auto-provision a default engine on first run (ADR-024 + ADR-025). Detects the
// GPU vendor, downloads the fastest llama.cpp backend it supports, and registers
// it — trying the recommended backend, then Vulkan, then CPU if one won't probe.
// No-ops if any engine is already configured, or once it has seeded (Config.defaultEngineSeeded). Never throws.
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Registry } from './registry'
import type { ConfigStore, Engine } from '../config/config'
import type { ProvisionState } from './provision-state'
import { amdApuOnly, getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { litertLmNativeVersion } from './litert-lm'
import { ANDROID_BUNDLED_ENGINES, ANDROID_ENGINE_NAME } from './android-engines'
import { LLAMA_BUILD, fallbackChain, provisionBackend, recommendBackendId, type BackendId, type ProvisionProgress } from './download'

const VALID_BACKENDS: BackendId[] = ['cuda', 'rocm', 'sycl', 'vulkan', 'metal', 'cpu']

/** The app's in-app engine (the TurboLLM SDK, kind 'turbollm-sdk'): an HTTP server inside the app process, not a
 *  binary. The app sets TURBOLLM_ANDROID_SDK_URL when it started it this launch. */
const ANDROID_SDK_ENGINE_NAME = 'TurboLLM SDK'

/** BUG-01 fix (QA_BUGS.md): on Android, the llama-server binary bundled inside the APK
 *  lives at `<nativeLibraryDir>/libllama_server.so` — the only on-disk location Android's
 *  W^X hardening exempts from execve() (build.gradle.kts's jniLibs comment). Nothing in
 *  the Android app shell ever registered that engine automatically; every prior
 *  verification pass did it by hand with a one-off curl call. Worse, `nativeLibraryDir`
 *  is re-derived by PackageManager on every install/update (a fresh signing session even
 *  for the identical APK), so even a manually-registered engine's `binPath` goes stale
 *  the moment the app is reinstalled — reproduced live: a plain `adb install -r` over an
 *  already-registered engine turned a working chat completion into `spawn ... ENOENT`.
 *
 *  Called unconditionally at every daemon boot (cli.ts), before `seedDefaultEngines` —
 *  a no-op on every platform except Android (gated on `TURBOLLM_ANDROID_NATIVE_LIB_DIR`,
 *  set only by MainActivity.kt). Self-heals a stale path in place (same engine id, so any
 *  existing per-engine profile/update-policy config survives) and registers fresh on a
 *  genuine first launch — either way, "the app can load a model" never again depends on a
 *  developer having run a manual registration step first. Errors are logged, not thrown:
 *  a probe failure here must not take the rest of daemon startup down with it. */
export async function ensureAndroidBundledEngine(registry: Registry): Promise<void> {
  const nativeLibDir = process.env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
  if (!nativeLibDir) return

  // With the SDK engine as the default, the CPU engine is the optional fallback (Option B), so an APK without it is a
  // build configuration too.
  const sdkIsDefault = Boolean(process.env.TURBOLLM_ANDROID_SDK_URL)

  for (const { name, file, kind } of ANDROID_BUNDLED_ENGINES) {
    const required = name === ANDROID_ENGINE_NAME && !sdkIsDefault
    const binPath = join(nativeLibDir, file)
    // Optional engines are skipped silently when absent: "this APK didn't ship the Vulkan
    // binary" is a build configuration, not a fault worth a warning on every boot. A row an
    // earlier APK registered for one is unregistered instead of offered (ADR-239).
    if (!required && !existsSync(binPath)) {
      unregisterUnshippedEngine(registry, name, file)
      continue
    }
    try {
      const existing = registry.list().engines.find((e) => e.name === name)
      if (kind === 'litert-lm') {
        // Not a llama-server, so no probe: the version comes from the server's own --version, and it is
        // refreshed on every boot because an app update can ship a newer runtime at the same path.
        // A failed --version must not cost the engine: it ships in the APK, so register it regardless and say why.
        // A version already on record is kept over the placeholder: one failed probe must not erase a real one.
        const version = await litertLmNativeVersion(binPath).catch((err) => {
          console.warn(`android: ${name} --version failed (${err instanceof Error ? err.message : err}); registering anyway`)
          return existing?.version || 'litert-lm (bundled)'
        })
        if (!existing) {
          registry.addLitertLm(name, binPath, version)
          console.log(`android: registered bundled engine ${name} (${version}) at ${binPath}`)
        } else if (existing.binPath !== binPath || existing.version !== version) {
          await registry.repairBinPath(existing.id, binPath, version)
          console.log(`android: refreshed bundled engine ${name} (${version}) at ${binPath}`)
        }
      } else if (!existing) {
        await registry.add(name, binPath)
        console.log(`android: registered bundled engine ${name} at ${binPath}`)
      } else if (existing.binPath !== binPath) {
        await registry.repairBinPath(existing.id, binPath)
        console.log(`android: repaired stale engine path for ${name} → ${binPath}`)
      }
    } catch (e) {
      // Per-engine catch, deliberately: a Vulkan binary that won't probe on this device must
      // not stop the CPU engine — the one that actually works — from being registered.
      console.warn(`android: could not register/repair ${name} (${e instanceof Error ? e.message : e})`)
    }
  }
}

/** G-7 (ADR-239): a bundled engine registered by an earlier APK that this one does not ship (the LiteRT-LM row after an
 *  upgrade to the default build, the Vulkan row with that build flag off) is unregistered, not offered as working. Only
 *  the app's own row is: its bundled name on a binary of the bundled file's name, in this install's nativeLibraryDir
 *  or an earlier one (a reinstall moves it). Never throws, like its caller. */
function unregisterUnshippedEngine(registry: Registry, name: string, file: string): void {
  const unshipped = registry.list().engines.find((e) => e.name === name && basename(e.binPath) === file)
  if (!unshipped) return
  try {
    if (registry.active()?.id === unshipped.id) activateAndroidDefault(registry)
    registry.remove(unshipped.id)
    console.log(`android: unregistered bundled engine ${name}: this app build does not ship ${file}`)
  } catch (e) {
    console.warn(`android: could not unregister ${name} (${e instanceof Error ? e.message : e})`)
  }
}

/** The engine an Android start falls back to: the SDK engine when the app started it this launch (it may register
 *  only after this, and then becomes active as the only choice), else the bundled CPU engine when its file is there. */
function activateAndroidDefault(registry: Registry): void {
  const engines = registry.list().engines
  const fallback = process.env.TURBOLLM_ANDROID_SDK_URL
    ? engines.find((e) => e.kind === 'turbollm-sdk')
    : engines.find((e) => e.name === ANDROID_ENGINE_NAME && existsSync(e.binPath))
  if (fallback) registry.activate(fallback.id)
}

/** Registers or repairs the app's in-app engine (the TurboLLM SDK) at every start, and makes it the default engine
 *  (Option B, R-5). Called right after ensureAndroidBundledEngine (cli.ts); a no-op outside the packaged app.
 *  - Its URL is an ephemeral port that changes every launch, so the one engine of its kind is repaired in place (same
 *    id, so its per-engine settings survive). Its token is never read or stored here (engine-headers.ts).
 *  - It is activated when it was registered this start (an upgrading user moves off llama-server once), when no
 *    engine is active, or when the active one is a bundled engine whose file is gone. Otherwise the user's pick stays.
 *  - Without the URL (the app could not start the SDK this launch) the SDK engine is kept, and if it is the active one
 *    the bundled CPU engine takes over when its file is there, so a model can still load.
 *  Errors are logged, not thrown, like its neighbour's. */
export function ensureAndroidSdkEngine(registry: Registry, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.TURBOLLM_ANDROID_NATIVE_LIB_DIR) return
  try {
    const baseUrl = env.TURBOLLM_ANDROID_SDK_URL
    if (baseUrl) registerSdkEngine(registry, baseUrl)
    else fallBackFromSdkEngine(registry)
  } catch (e) {
    console.warn(`android: could not register/repair ${ANDROID_SDK_ENGINE_NAME} (${e instanceof Error ? e.message : e})`)
  }
}

function registerSdkEngine(registry: Registry, baseUrl: string): void {
  const previous = registry.list().engines.find((e) => e.kind === 'turbollm-sdk')
  const sdk = registry.addTurbollmSdk(ANDROID_SDK_ENGINE_NAME, baseUrl)
  if (previous?.baseUrl !== baseUrl) {
    console.log(`android: ${previous ? 'repaired' : 'registered'} ${ANDROID_SDK_ENGINE_NAME} at ${baseUrl}`)
  }
  if (!previous || !activeEngineCanRun(registry)) registry.activate(sdk.id)
}

/** False when no engine is active, or the active one is a bundled engine whose file this APK no longer has. */
function activeEngineCanRun(registry: Registry): boolean {
  const active = registry.active()
  return active !== undefined && !(isBundledEngine(active) && !existsSync(active.binPath))
}

function isBundledEngine(engine: Engine): boolean {
  return ANDROID_BUNDLED_ENGINES.some((b) => b.name === engine.name && basename(engine.binPath) === b.file)
}

function fallBackFromSdkEngine(registry: Registry): void {
  if (registry.active()?.kind !== 'turbollm-sdk') return
  const cpu = registry.list().engines.find((e) => e.name === ANDROID_ENGINE_NAME && existsSync(e.binPath))
  if (!cpu) return
  registry.activate(cpu.id)
  console.log(`android: ${ANDROID_SDK_ENGINE_NAME} did not start this launch, so ${ANDROID_ENGINE_NAME} is the active engine`)
}

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
