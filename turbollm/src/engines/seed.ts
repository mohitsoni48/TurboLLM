// Auto-provision a default engine on first run (ADR-024 + ADR-025). Detects the
// GPU vendor, downloads the fastest llama.cpp backend it supports, and registers
// it — trying the recommended backend, then Vulkan, then CPU if one won't probe.
// No-ops if any engine is already configured. Never throws.
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Registry } from './registry'
import type { ConfigStore } from '../config/config'
import type { ProvisionState } from './provision-state'
import { amdApuOnly, getSysInfo, primaryVendor } from '../sysinfo/sysinfo'
import { LITERT_LM_NATIVE_SERVER, litertLmNativeVersion } from './litert-lm'
import { LLAMA_BUILD, fallbackChain, provisionBackend, recommendBackendId, type BackendId, type ProvisionProgress } from './download'

const VALID_BACKENDS: BackendId[] = ['cuda', 'rocm', 'sycl', 'vulkan', 'metal', 'cpu']

/** Fixed identity for the one engine the Android app ever registers for itself — never
 *  user-renamable to something else on Android (there's no "add engine" UI reachable in
 *  the WebView-only app shell), so matching on this exact name is a safe, stable way to
 *  find "the engine this function owns" across restarts without persisting a separate id
 *  anywhere. */
const ANDROID_ENGINE_NAME = 'llama-server-android'

/** The optional second engine: the same llama.cpp server built with the Vulkan backend, so the
 *  GPU can be tried on devices whose driver supports it.
 *
 *  It is a SEPARATE, statically-linked binary rather than extra backend .so files next to the CPU
 *  engine, and that is not a packaging preference — it is forced twice over. `nativeLibraryDir` is
 *  flat, so a shared Vulkan build's libggml.so/libllama.so would collide with the CPU engine's
 *  under identical names. And measured on a Galaxy S21 FE (Mali-G78): with `libggml-vulkan.so`
 *  merely PRESENT in that directory, llama-server died during load_model even at `-ngl 0`, while
 *  moving that one file aside let the identical binary load and serve in ~2s. Sharing a directory
 *  would therefore let a flaky GPU driver take the working CPU engine down with it. Two
 *  self-contained binaries keep that blast radius to whichever engine the user selected.
 *
 *  Registered only when the file is actually in the APK, so a build without it simply has one
 *  engine instead of logging a failure for something that was never shipped. */
const ANDROID_VULKAN_ENGINE_NAME = 'llama-server-android-vulkan'

/** The app's bundled LiteRT-LM engine: the native port of `litert-lm serve` that TurboLLM-Android ships beside
 *  liblitert-lm.so (litert-lm.ts, LITERT_LM_NATIVE_SERVER). Registered only when the APK carries it, like the Vulkan
 *  engine. It never needs activating: .litertlm models are routed to it whatever engine is active (engineForModel). */
const ANDROID_LITERT_LM_ENGINE_NAME = 'litert-lm-android'

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

  const bundled: { name: string; file: string; required: boolean; kind: 'llama-server' | 'litert-lm' }[] = [
    { name: ANDROID_ENGINE_NAME, file: 'libllama_server.so', required: true, kind: 'llama-server' },
    { name: ANDROID_VULKAN_ENGINE_NAME, file: 'libllama_server_vk.so', required: false, kind: 'llama-server' },
    { name: ANDROID_LITERT_LM_ENGINE_NAME, file: LITERT_LM_NATIVE_SERVER, required: false, kind: 'litert-lm' },
  ]

  for (const { name, file, required, kind } of bundled) {
    const binPath = join(nativeLibDir, file)
    // Optional engines are skipped silently when absent: "this APK didn't ship the Vulkan
    // binary" is a build configuration, not a fault worth a warning on every boot.
    if (!required && !existsSync(binPath)) continue
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

export async function seedDefaultEngines(
  registry: Registry,
  enginesRoot: string,
  provision: ProvisionState,
): Promise<void> {
  if (registry.list().engines.length > 0) return

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
