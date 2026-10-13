// LiteRT-LM engine provisioning + launch. LiteRT-LM (google-ai-edge/LiteRT-LM) is Google's on-device LLM runtime:
// it runs `.litertlm` bundles (Gemma 3n/4, Qwen3, Phi-4-mini, ...) on CPU or on the GPU through WebGPU, with an
// OpenAI-compatible server (`litert-lm serve`). A fifth Python engine kind beside MLX, vLLM and SGLang: we reuse the uv
// bootstrap (ensureUv, shared with mlx.ts/vllm.ts), create an isolated venv, `uv pip install litert-lm`, and run its
// CLI as a module. No system Python is touched.
//
// How the CLI differs from every other engine here (verified against litert-lm 0.17.1, live):
//   - `serve` takes NO model argument. It resolves the request's `model` field per call: an existing file path is used
//     as-is (Model.from_model_reference), anything else is looked up in its own import registry. We always send the
//     file path, so nothing is imported, copied or linked — the same shape as MLX-VLM's path-valued model field.
//   - The engine loads lazily on the FIRST chat request, so /v1/models answers 200 with the model not loaded. Readiness
//     therefore needs a one-token warm-up request (warmUpLitertLm), which is also where a bad model file surfaces.
//   - There is no /health route (404) and no launch-time sampling flags. Backend (cpu/gpu), context and threads come
//     from a JSON file passed with `--config`; its `default` section applies to whichever model the request names.
//   - The `model` field is `<id>[,<backend>[,<max-tokens>]]`, so a path containing a comma cannot be sent
//     (litertLmPathBlocker refuses it up front rather than letting it be misparsed).
//
// Platform reality: the native wheel (litert-lm-api) ships for Windows x64, Linux x64/arm64, macOS arm64 and Android
// (arm64-v8a, x86_64) — there is no macOS-Intel or Windows-ARM build, and the catalog gates on exactly that.
//
// Android is the odd one out. The Android wheel is `py3-none-android_23_<abi>`: a thin ctypes wrapper around one
// liblitert-lm.so (bionic, linked only against system libs), so it works in any bionic Python such as Termux's — but
// (a) `uv` publishes no Android build, so the venv comes from the device's own `python -m venv`, and (b) pip refuses a
// wheel whose platform tag it does not recognise, which Termux's Python may not, so the native wheel is fetched from
// PyPI and unpacked into the venv directly (ensureLitertLmAndroidEnv). The Android APK has no Python at all, so there
// this engine is only reachable when TurboLLM itself runs inside Termux.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

const LITERT_LM_PYTHON = '3.12'

export interface LitertLmRuntime {
  python: string
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated LiteRT-LM runtime: uv → venv (pinned python) → `uv pip install litert-lm`. The wheel bundles
 * the native runtime, so unlike vLLM/SGLang this is small (tens of MB, no torch/CUDA). Returns the venv python +
 * version. When `upgrade` is true, passes `-U`. `signal` aborts a provision in flight (the web UI's Cancel): every
 * child process here takes it in its exec options, so an abort kills uv/pip and rejects with AbortError — the route
 * maps that to a clean "user cancelled" state instead of a failure banner.
 *
 * The whole body sits in a `finally` that clears the serve-preflight cache (see
 * resetLitertLmServeCache): a provision that rewrote the venv — or died halfway through
 * rewriting it — invalidates every cached verdict about the old files.
 */
export async function ensureLitertLmEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
  signal?: AbortSignal,
): Promise<LitertLmRuntime> {
  try {
    if (process.platform === 'android') return await ensureLitertLmAndroidEnv(root, onProgress, upgrade, signal)
    const uv = await ensureUv(root, onProgress)
    const envDir = join(root, 'litert-lm', 'venv')
    const py = venvPython(envDir)

    if (!existsSync(py)) {
      onProgress?.({ phase: 'extracting', pct: -1 })
      await execFileP(uv, ['venv', '--python', LITERT_LM_PYTHON, envDir], { cwd: root, signal })
    }
    onProgress?.({ phase: 'extracting', pct: -1 })
    // `--reinstall` on the plain install (PR #271 re-review, live-verified on uv 0.12): a bare
    // `uv pip install litert-lm` answers "Checked 1 package" and installs NOTHING when the
    // version is already satisfied — so an Install over a half-installed venv (a cancelled
    // provision leaves one behind) would register an engine whose files are still broken.
    // --reinstall makes Install mean "a coherent environment": a no-op on a fresh venv, a full
    // rewrite from the uv cache on a damaged one. The Update path keeps plain -U — the
    // alreadyLatest short-circuit refuses same-version updates, and a real version bump
    // rewrites everything anyway.
    const installArgs = ['pip', 'install', '--python', py, ...(upgrade ? ['-U'] : ['--reinstall']), 'litert-lm']
    await execFileP(uv, installArgs, { cwd: root, maxBuffer: 64 * 1024 * 1024, signal })

    const version = await probeLitertLm(py, signal)
    return { python: py, version }
  } finally {
    resetLitertLmServeCache()
  }
}

// ── Android (Termux) provisioning ────────────────────────────────────────────

const PYPI = 'https://pypi.org/pypi'

/** The ABI part of the native wheel's platform tag for this CPU, or null when Android has no build for it. */
export function androidWheelAbi(arch: string): 'arm64_v8a' | 'x86_64' | null {
  if (arch === 'arm64') return 'arm64_v8a'
  if (arch === 'x64') return 'x86_64'
  return null
}

export interface PypiFile { filename: string; url: string; digests?: { sha256?: string } }

/** Pick the Android native wheel for `abi` out of a PyPI release's file list (highest API level wins when several).
 *  Only a wheel that can be verified and safely named qualifies: it must carry a SHA-256 digest, and its file
 *  name (later joined into a write path) must contain no path separator. */
export function pickAndroidWheel(files: PypiFile[], abi: string): PypiFile | null {
  const re = new RegExp(`-py3-none-android_(\\d+)_${abi}\\.whl$`)
  const found = files
    .filter((f) => Boolean(f.digests?.sha256) && !/[\\/]/.test(f.filename))
    .map((f) => ({ f, api: Number(re.exec(f.filename)?.[1]) }))
    .filter((x) => Number.isFinite(x.api))
    .sort((a, b) => b.api - a.api)
  return found[0]?.f ?? null
}

/** Termux hint shared by every "no usable Python" failure. */
const ANDROID_PYTHON_HINT =
  'LiteRT-LM on Android needs Python 3.10 or newer from Termux (run `pkg install python`) with TurboLLM started ' +
  'from Termux. The standalone Android app needs none of this: it ships LiteRT-LM built in.'

/** A python>=3.10 with the venv module on this device, or throws with the Termux instructions. */
async function findAndroidPython(): Promise<string> {
  for (const cand of ['python3', 'python']) {
    try {
      const { stdout } = await execFileP(
        cand,
        ['-c', 'import sys, venv; print("%d.%d" % sys.version_info[:2])'],
        { timeout: 30_000 },
      )
      const [maj, min] = stdout.trim().split('.').map(Number)
      if (maj > 3 || (maj === 3 && min >= 10)) return cand
    } catch { /* try the next name */ }
  }
  throw new Error(ANDROID_PYTHON_HINT)
}

async function pypiJson(url: string, signal?: AbortSignal): Promise<{ info: { version: string }; urls: PypiFile[] }> {
  // The caller's signal rides along with the timeout (PR #271 re-review): the web UI's Cancel
  // must interrupt the metadata fetch too, not just the wheel download below — the same
  // AbortSignal.any combination that fetch uses there.
  const r = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`PyPI answered ${r.status} for ${url}`)
  return (await r.json()) as { info: { version: string }; urls: PypiFile[] }
}

async function installAndroidNativeWheel(py: string, root: string, version: string, signal?: AbortSignal): Promise<void> {
  const abi = androidWheelAbi(process.arch)
  if (!abi) throw new Error(`LiteRT-LM has no Android build for the ${process.arch} architecture.`)
  const release = await pypiJson(`${PYPI}/litert-lm-api/${version}/json`, signal)
  const wheel = pickAndroidWheel(release.urls, abi)
  if (!wheel) throw new Error(`litert-lm-api ${version} publishes no verifiable Android ${abi} wheel.`)

  const r = await fetch(wheel.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) })
  if (!r.ok) throw new Error(`Could not download ${wheel.filename} (HTTP ${r.status}).`)
  const bytes = Buffer.from(await r.arrayBuffer())
  // pickAndroidWheel only returns a wheel that has a digest, so the check always runs.
  if (createHash('sha256').update(bytes).digest('hex') !== wheel.digests?.sha256) {
    throw new Error(`${wheel.filename} failed its SHA-256 check — the download is corrupt, try again.`)
  }

  const { stdout } = await execFileP(py, ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { timeout: 30_000, signal })
  const site = stdout.trim()
  // A wheel is a zip. Drop any earlier litert_lm_api metadata first so an upgrade leaves one dist-info behind.
  for (const e of readdirSync(site)) if (/^litert_lm_api-.*\.dist-info$/.test(e)) rmSync(join(site, e), { recursive: true, force: true })
  const tmp = join(root, 'litert-lm', wheel.filename)
  mkdirSync(dirname(tmp), { recursive: true })
  writeFileSync(tmp, bytes)
  try {
    await execFileP(py, ['-m', 'zipfile', '-e', tmp, site], { timeout: 120_000, signal })
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Android/Termux twin of ensureLitertLmEnv (see the header comment for why it differs): device Python → venv → pip
 * installs the pure-Python packages → the native wheel is unpacked from PyPI by hand. `signal` cancels it (the web
 * UI's Cancel) — same contract as the desktop path.
 */
export async function ensureLitertLmAndroidEnv(
  root: string,
  onProgress?: (p: ProvisionProgress) => void,
  upgrade = false,
  signal?: AbortSignal,
): Promise<LitertLmRuntime> {
  const systemPython = await findAndroidPython()
  const envDir = join(root, 'litert-lm', 'venv')
  const py = venvPython(envDir)
  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    await execFileP(systemPython, ['-m', 'venv', envDir], { cwd: root, signal })
  }
  onProgress?.({ phase: 'extracting', pct: -1 })
  // --force-reinstall is the Android twin of the desktop --reinstall (PR #271 re-review): pip
  // skips an already-satisfied package, so without it a broken litert_lm_cli / builder / click
  // would survive an Install. The packages are small and pure-Python, and the native wheel is
  // re-unpacked unconditionally below — together they make Install mean "a coherent environment".
  const pip = (...args: string[]) =>
    execFileP(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--force-reinstall', ...(upgrade ? ['-U'] : []), ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 900_000, signal })
  // --no-deps: litert-lm pins litert-lm-api==<same version>, and pip would reject its Android-tagged wheel.
  await pip('--no-deps', 'litert-lm')
  const version = (await probeLitertLm(py, signal)).replace(/^litert-lm /, '')
  await pip(`litert-lm-builder==${version}`, 'click', 'prompt_toolkit', 'typing-extensions', 'questionary')
  onProgress?.({ phase: 'downloading', pct: -1 })
  await installAndroidNativeWheel(py, root, version, signal)

  const blocker = await litertLmServeBlocker(py, signal)
  if (blocker) throw new Error(blocker)
  return { python: py, version: `litert-lm ${version}` }
}

/** Read the installed litert-lm version (also a smoke test that the package imports). */
export async function probeLitertLm(python: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import importlib.metadata as m; print(m.version("litert-lm"))'],
    { timeout: 30_000, signal },
  )
  return `litert-lm ${stdout.trim()}`
}

/**
 * Turn a failed native-load probe into an actionable message. The package installs anywhere pip does (the CLI is pure
 * Python), but its native library only loads where a wheel exists, so an unsupported OS/arch — or a Linux whose C
 * library predates the manylinux_2_27 wheel — fails with a loader error that means nothing to a user.
 */
export function classifyLitertLmBlocker(platform: NodeJS.Platform, arch: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) ?? 'the native runtime did not load'
  const supported =
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
    (platform === 'darwin' && arch === 'arm64') ||
    (platform === 'android' && androidWheelAbi(arch) !== null)
  if (!supported) {
    return 'LiteRT-LM publishes its runtime only for Windows x64, Linux x64/arm64, macOS on Apple Silicon and Android ' +
      '(arm64 / x86_64) — there is no build for this operating system / architecture.'
  }
  const need = platform === 'android'
    ? 'On Android it needs Android 6.0 (API 23) or newer and the Python from Termux; reinstalling the engine from Engines may also fix a half-installed environment.'
    : 'On Linux it needs glibc 2.27 or newer; reinstalling the engine from Engines may also fix a half-installed environment.'
  return `LiteRT-LM's native runtime could not load on this machine (${detail}). ${need}`
}

/**
 * Python that proves the native runtime loads, not just the package. `import litert_lm` alone proves nothing: the
 * wrapper dlopens liblitert-lm.so lazily on first use (`_ffi._get_lib`, verified on litert-lm-api 0.17.1), so a wrong-arch
 * or unloadable library would otherwise only surface mid-request. `_get_lib` is private, so if a future version renames
 * it the probe degrades to the plain import instead of reporting a false failure.
 */
const NATIVE_LOAD_PROBE = [
  'import importlib, litert_lm',
  "ffi = importlib.import_module('litert_lm._ffi')",
  "load = getattr(ffi, '_get_lib', None)",
  'load() if callable(load) else None',
].join('\n')

/** The serve probe's wall-clock budget: 60 s in production — a venv's first import can be slow on a
 *  phone — and injectably shorter in tests so the timeout path can be exercised without a
 *  minute-long test. */
export const LITERT_LM_PROBE_TIMEOUT_MS = 60_000

/** Whether a failed probe was cut short rather than answering: execFile's `timeout` kills the child
 *  (`killed` set), an outside SIGTERM/SIGKILL stops it, and a killed spawn can surface as ETIMEDOUT.
 *  A busy phone can make the very probe that times out now pass a minute later, so this gets a
 *  "try again" message, not "could not load" (PR #271 review). A non-zero exit, or a crash signal
 *  such as SIGSEGV/SIGILL from a native library that cannot run on this CPU, is a real answer. */
export function isLitertLmProbeInconclusive(e: unknown): boolean {
  const err = e as { killed?: boolean; signal?: unknown; code?: unknown }
  return Boolean(err?.killed || err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL')
}

/** Preflight: can the LiteRT-LM runtime actually load here? Returns a clear message when blocked, or null when OK. */
export async function litertLmServeBlocker(
  python: string,
  signal?: AbortSignal,
  timeoutMs: number = LITERT_LM_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  try {
    await execFileP(python, ['-c', NATIVE_LOAD_PROBE], { timeout: timeoutMs, signal })
    return null
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    if (isLitertLmProbeInconclusive(e)) {
      return `LiteRT-LM's native-runtime check did not finish — the machine was too busy to answer within ` +
        `${Math.max(1, Math.round(timeoutMs / 1000))} s. Nothing is known about the runtime; try loading again.`
    }
    // A crash leaves stderr empty, and Node's message ends with the probe's own source — name the signal instead.
    const { signal: crash, stderr } = e as { signal?: string; stderr?: string }
    const detail = crash ? `the native runtime crashed (${crash})` : stderr || e
    return classifyLitertLmBlocker(process.platform, process.arch, detail)
  }
}

/** Why this model path cannot be sent to `litert-lm serve`, or null. The server splits the request's `model` on commas
 *  (`<id>,<backend>,<max-tokens>`), so a comma in a directory or file name would be misread as an override. */
export function litertLmPathBlocker(modelPath: string): string | null {
  return modelPath.includes(',')
    ? 'LiteRT-LM cannot load a model whose path contains a comma — rename the file or its folder and rescan.'
    : null
}

// ── serve preflight, cached per venv ─────────────────────────────────────────────

/** A cheap fingerprint of a LiteRT-LM interpreter's environment: its own mtime plus the
 *  installed `litert_lm` package dir's mtime ('absent' when there is no recognizable venv
 *  layout — the interpreter's own mtime still keys the cache). The serve preflight
 *  (litertLmServeBlocker) spawns a fresh Python process that dlopens the native library —
 *  up to 60 s, noticeable on a phone — and the Manager runs it on EVERY load and
 *  auto-resume. The result is stable for an unchanged environment, so the cache is keyed on
 *  this fingerprint: a reinstall touches the package dir (pip rewrites it wholesale), a
 *  rebuilt venv touches the interpreter, and either invalidates the cached answer.
 *  null → the interpreter itself cannot be stat'd (missing, or a bare command name the
 *  filesystem can't resolve); the caller just runs the probe uncached. */
export function litertLmEnvFingerprint(python: string): string | null {
  try {
    const pyStat = statSync(python)
    const envDir = dirname(dirname(python)) // <env>/bin/python (POSIX) / <env>/Scripts/python.exe (Windows)
    const siteDir = process.platform === 'win32'
      ? join(envDir, 'Lib', 'site-packages')
      : (() => {
          const lib = join(envDir, 'lib')
          if (!existsSync(lib)) return null
          const ver = readdirSync(lib, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith('python'))
          return ver ? join(lib, ver.name, 'site-packages') : null
        })()
    const pkg = siteDir ? join(siteDir, 'litert_lm') : null
    const pkgStat = pkg && existsSync(pkg) ? statSync(pkg) : null
    return `${python}|${pyStat.mtimeMs}|${pkgStat ? pkgStat.mtimeMs : 'absent'}`
  } catch {
    return null
  }
}

/** The in-flight probe, or a PASS, per fingerprint. The PROMISE is cached so concurrent loads
 *  share one probe. Only a pass stays: a failure is often fixed outside the venv (Defender done
 *  scanning a fresh DLL, a runtime library installed), which no fingerprint sees, so a cached
 *  failure would outlive the fix until the daemon restarted (v1.14.5 review). An abort
 *  propagates so the caller can treat the load as cancelled, not as pass/fail. */
const serveBlockerCache = new Map<string, Promise<string | null>>()

/** Drop every cached serve-preflight answer. Called when a provision finishes (successfully
 *  or not — ensureLitertLmEnv wraps its whole body in this): the venv was just rewritten, or
 *  died halfway through being rewritten, so any cached verdict describes files that no longer
 *  exist. The fingerprint cannot catch this by itself on Android (PR #271 re-review): the
 *  native wheel is unpacked by `zipfile -e` OVER the old files in place, which rewrites every
 *  file in `litert_lm/` but never adds or removes a directory entry — and a directory's mtime
 *  only changes when entries come and go. A cached "native runtime could not load" from before
 *  the reinstall could therefore survive it, contradicting the "reinstalling may fix it" the
 *  message itself advises, until the daemon restarted. Clearing here covers every provision
 *  path (fresh install, Update, applyPipUpdate) in one place; the next load re-probes and
 *  re-caches. */
export function resetLitertLmServeCache(): void {
  serveBlockerCache.clear()
}

/** Cached litertLmServeBlocker for the Manager's per-load preflight (see
 *  litertLmEnvFingerprint for why the probe is worth caching). Install-time callers
 *  (ensureLitertLmAndroidEnv) use the plain uncached litertLmServeBlocker on purpose: they
 *  have just written the environment and must see what they built. */
export function litertLmServeBlockerCached(
  python: string,
  signal?: AbortSignal,
  timeoutMs: number = LITERT_LM_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const key = litertLmEnvFingerprint(python)
  if (!key) return litertLmServeBlocker(python, signal, timeoutMs)
  const hit = serveBlockerCache.get(key)
  if (hit) return hit
  const answer = litertLmServeBlocker(python, signal, timeoutMs)
  serveBlockerCache.set(key, answer)
  const forget = () => {
    if (serveBlockerCache.get(key) === answer) serveBlockerCache.delete(key)
  }
  // THIS load still gets the blocker; only the next one re-probes.
  answer.then((blocker) => { if (blocker !== null) forget() }, forget)
  return answer
}

/** The settings TurboLLM drives through LiteRT-LM's `--config` file. Every key is one the 0.17 schema accepts. */
export interface LitertLmConfig {
  default: {
    backend: 'cpu' | 'gpu'
    max_num_tokens?: number
    cpu_thread_count?: number
  }
}

/**
 * Map a load profile to LiteRT-LM's config. LiteRT-LM has no partial offload, so the profile's `litertLm.backend` picks
 * cpu or gpu outright; `auto` (the default) follows the KoboldCpp convention: `ngl > 0` on a machine with a GPU means
 * the GPU backend and everything else means CPU.
 *   ctx     → max_num_tokens   (the KV-cache length; a bundle exported with a shorter one still caps it)
 *   threads → cpu_thread_count (when set; 0 = `autoThreads` if given — the performance cores on a phone, where the
 *             runtime's own fixed default can land threads on efficiency cores — else the runtime chooses)
 */
export function litertLmProfileToConfig(
  p: { ctx: number; ngl: number; threads: number; litertLm?: { backend?: 'auto' | 'cpu' | 'gpu' } },
  hasGpu: boolean,
  autoThreads = 0,
): LitertLmConfig {
  // An explicit choice wins over detection: Android/Termux cannot report a GPU, so `auto` would pin it to CPU.
  const choice = p.litertLm?.backend ?? 'auto'
  const backend: 'cpu' | 'gpu' = choice === 'auto' ? (hasGpu && p.ngl > 0 ? 'gpu' : 'cpu') : choice
  const config: LitertLmConfig = { default: { backend } }
  if (Number.isInteger(p.ctx) && p.ctx > 0) config.default.max_num_tokens = p.ctx
  if (Number.isInteger(p.threads) && p.threads > 0) config.default.cpu_thread_count = p.threads
  else if (Number.isInteger(autoThreads) && autoThreads > 0) config.default.cpu_thread_count = autoThreads
  return config
}

/**
 * Prefill speed for a LiteRT-LM turn. Its OpenAI server reports only token counts (`usage`), never llama.cpp-style
 * `timings`, even though the runtime measures prefill internally — so the speed is derived: prompt tokens over the time
 * to the first streamed token. That time also contains the first decode step, so this slightly UNDER-states true
 * prefill, which is the honest direction for an approximation. Null when either input is missing, so nothing is faked.
 */
export function litertLmPrefillStats(promptTokens: number | undefined, ttftMs: number): { promptMs: number; promptTps: number } | null {
  if (!promptTokens || promptTokens <= 0 || !(ttftMs > 0)) return null
  return { promptMs: ttftMs, promptTps: Math.round((promptTokens / ttftMs) * 1000 * 10) / 10 }
}

/** Where the config for the engine on `port` lives. Per port, not shared: two engines can run side by side and a
 *  shared file would let the second start rewrite the first's settings. */
export function litertLmConfigPath(dataDir: string, port: number): string {
  return join(dataDir, 'engines', 'litert-lm', `config-${port}.json`)
}

/** Write the config file `litert-lm serve --config` reads. */
export function writeLitertLmConfig(path: string, config: LitertLmConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

/**
 * Command + args to launch the LiteRT-LM OpenAI-compatible server. We invoke the CLI as a module (`python -m
 * litert_lm_cli.main`) rather than the venv's console script, the same way SGLang is launched: one path on every OS,
 * no `.exe` shim to locate. `serve` defaults to 0.0.0.0:9379, so host and port are always passed explicitly.
 *
 * `extraArgs` are the user's own `serve` flags (--verbose, --cors-origin, ...) and go last.
 */
export function litertLmServerCommand(
  python: string,
  configPath: string,
  port: number,
  host: string,
  extraArgs: string[] = [],
): { cmd: string; args: string[] } {
  const serve = ['serve', '--config', configPath, '--host', host, '--port', String(port), ...extraArgs]
  // The Android app's bundled server takes the CLI's own `serve` arguments, so only the program differs.
  if (isNativeLitertLm(python)) return { cmd: python, args: serve }
  return { cmd: python, args: ['-m', 'litert_lm_cli.main', ...serve] }
}

/**
 * The standalone Android app's LiteRT-LM engine: a native port of `litert-lm serve` (TurboLLM-Android,
 * engines/litert-lm-server) that drives the same liblitert-lm.so the Python server reaches through ctypes. The app has
 * no Python and may only execute files installed with its APK, so it ships this server in its nativeLibraryDir under
 * a lib*.so name, where seed.ts registers it. It speaks the same contract as `serve` — `--config/--host/--port`, the
 * model path in each request's `model` field, the runtime's message in a failed request's status line — so everything
 * else about the litert-lm kind (config file, warm-up, compat) applies unchanged. What differs is only what follows
 * from it not being Python: no venv preflight, no pip updates, the native library environment.
 */
export const LITERT_LM_NATIVE_SERVER = 'liblitertlm_server.so'

/** Whether a litert-lm engine's binPath is the bundled native server rather than a venv's python. */
export function isNativeLitertLm(binPath: string): boolean {
  return basename(binPath) === LITERT_LM_NATIVE_SERVER
}

/** The engine version for the native server, from its `--version` line
 *  ("turbollm-litertlm-server 1.0.0 (LiteRT-LM 0.18.0)") in the pip-style form the litert-lm kind stores
 *  ("litert-lm 0.18.0"). `--version` returns before the runtime library is loaded, so this is instant. */
export async function litertLmNativeVersion(binPath: string): Promise<string> {
  // 5 s: it runs at every boot of the app, where a hung probe would hold up engine registration.
  const { stdout } = await execFileP(binPath, ['--version'], { timeout: 5_000 })
  return parseLitertLmNativeVersion(stdout)
}

/** `litertLmNativeVersion`'s banner-to-stored-version mapping, split out from the spawn so the format stays
 *  assertable wherever the server itself cannot run — it ships as a native library (ELF/PE), and Windows refuses to
 *  execute a `#!` stand-in with a spawn EFTYPE, which is exactly why seed.ts's registration has a fallback version. */
export function parseLitertLmNativeVersion(stdout: string): string {
  // The banner carries two versions — "turbollm-litertlm-server <server> (LiteRT-LM <runtime>)" — and the kind stores
  // the RUNTIME one in pip style, so only the parenthesised token is read; an unrecognised banner keeps its own
  // trimmed text (or reads "unknown" when it printed nothing) rather than being reported as an empty version.
  const m = /LiteRT-LM\s+([\w.+-]+)/.exec(stdout)
  return `litert-lm ${m ? m[1] : stdout.trim() || 'unknown'}`
}

export type LitertLmWarmUp = { ok: true } | { ok: false; message: string }

/**
 * Load the model by asking it for one token. `serve` binds its socket before any model is loaded and loads on the first
 * chat request, so this is the only moment a bad bundle, an unsupported architecture or a GPU that cannot be initialised
 * becomes visible — as an HTTP 500 whose status text carries the runtime's own message. Returns that message.
 */
export async function warmUpLitertLm(port: number, modelRef: string, signal: AbortSignal): Promise<LitertLmWarmUp> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelRef,
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 1,
        stream: false,
      }),
      signal,
    })
    if (r.ok) return { ok: true }
    // The runtime's message rides in the status line ("500 Failed to load engine: RuntimeError(...)").
    const reason = r.statusText.trim() || `HTTP ${r.status}`
    return { ok: false, message: reason.slice(0, 300) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** A runtime error from a LiteRT-LM turn, with the likely fix when it is the context limit. A .litertlm bundle is
 *  exported with a fixed maximum sequence length, and raising Context on the load panel cannot go past it, so a long
 *  system prompt (the TurboLLM Expert persona alone is ~15k tokens) fails on small bundles however Context is set. */
export function litertLmTurnErrorMessage(reason: string): string {
  // The runtime's wording (tasks.cc): "Input token ids are too long. Exceeding the maximum number of tokens allowed".
  if (!/token ids are too long|maximum number of tokens|max_num_tokens/i.test(reason)) return reason
  return `${reason}. The prompt is longer than this model can take: a LiteRT-LM bundle has a fixed maximum length set ` +
    'when it was exported, and the Context setting cannot raise it. Use a shorter system prompt (the Lite persona), ' +
    'start a new chat, or use a model exported with a longer context.'
}

/** The user-facing text for a failed warm-up: the runtime's message plus the two causes that account for most of them. */
export function litertLmLoadFailureMessage(reason: string, backend: 'cpu' | 'gpu'): string {
  // The GPU hint must name a control the LiteRT-LM panel actually offers: "set GPU layers to
  // 0" is llama.cpp advice — the GPU-layers slider is not rendered for LiteRT-LM, whose
  // backend is chosen outright on the model's load panel.
  const hint = backend === 'gpu'
    ? 'If this model does not run on your GPU, switch the Backend setting to CPU on the model\'s load panel and load it again.'
    : 'Check that the file is a complete .litertlm bundle supported by this LiteRT-LM version.'
  return `LiteRT-LM could not load this model — ${reason}. ${hint}`
}
