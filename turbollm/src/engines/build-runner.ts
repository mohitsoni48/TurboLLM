// In-app 1-click compile-from-source (ADR-100, Windows + CUDA; Linux port). Runs git clone →
// cmake configure → cmake build inside the daemon, streaming each line to a {@link BuildState}
// so the UI shows live progress, then hands the built binary to the registry.
//
// Generator choice matters (ADR-100 follow-up). On Windows, the default "Visual Studio"
// generator needs the CUDA *Visual Studio integration* (.props) that only the full CUDA
// installer adds — a standalone / conda CUDA Toolkit doesn't have it, so the VS generator
// fails with "No CUDA toolset found". We instead build with **Ninja** (or NMake as a
// no-extra-install fallback) *inside the MSVC developer environment* (vcvars): that generator
// drives `nvcc` directly off PATH (no VS integration needed) and is much faster. vcvars is
// required because Ninja/NMake — unlike the VS generator — don't auto-find cl.exe; vcvars puts
// cl/ml64/INCLUDE/LIB on PATH. On Linux there's no VS-generator trap and no dev-env shell to
// enter — cmake is invoked directly, preferring **Ninja** (falling back to Unix Makefiles).
//
// The toolchain PATH override (build-prereqs.ts `buildEnv`) is applied so a conda-env /
// custom-path CUDA Toolkit (and a user-provided ninja) are found. Windows or Linux + CUDA only.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { buildEnv, checkBuildPrereqs, CMAKE_CONFIGURE_ARGS, CMAKE_CONFIGURE_ARGS_MACOS, CMAKE_CONFIGURE_ARGS_MACOS_CPU, CUDA_RUNTIME_DLL_PREFIXES, CUDA_RUNTIME_SO_PREFIXES } from './build-prereqs'
import { resolveServerBinary } from './scan'
import type { BuildPhase } from './build-state'

const execFileP = promisify(execFile)

export interface BuildRequest {
  repoUrl: string
  branch?: string
  /** Pin the build to an exact commit SHA instead of a branch tip — for A/B-ing a specific
   *  historical commit (e.g. bisecting a reported regression). Takes priority over `branch`
   *  when both are set. Requires the remote to allow fetching arbitrary SHAs (GitHub does). */
  commit?: string
  /** Optional URL of a unified-diff patch to apply on top of the checked-out commit before
   *  configuring — for an engine whose architecture isn't in the repo's mainline yet and needs
   *  a third-party patch to compile (e.g. solar_open2). Opt-in: unset = the build is unchanged.
   *  MUST be paired with {@link patchSha256} — a patch is never applied without a pinned hash. */
  patchUrl?: string
  /** Pinned lowercase 64-char hex SHA-256 the downloaded {@link patchUrl} bytes are verified
   *  against before the patch is applied. A mismatch hard-fails the build (never apply an
   *  unverified/mutated patch). Required whenever `patchUrl` is set. */
  patchSha256?: string
  /** `<dataDir>/engines` — builds live under `<enginesRoot>/build/<slug>/`. */
  enginesRoot: string
  /** Dirs prepended to PATH for the build (ADR-100). */
  toolchainDirs: string[]
}

export interface BuildHooks {
  phase: (p: BuildPhase) => void
  log: (line: string) => void
}

export interface BuildOutput {
  /** Absolute path to the compiled `llama-server[.exe]`. */
  binPath: string
  /** The exact commit that was built (HEAD of the cloned shallow checkout). */
  commit: string
  /** Directory the build lives in (so the caller can GC on failure if desired). */
  buildRoot: string
}

/** PURE: a filesystem-safe directory slug for a repo+branch, so a rebuild of the same
 *  source reuses (overwrites) the same dir. e.g. ("https://github.com/ikawrakow/ik_llama.cpp.git",
 *  "sidestream") → "ik_llama.cpp-sidestream". Falls back to "engine" for an unparseable URL. */
export function buildDirName(repoUrl: string, branch?: string, commit?: string): string {
  const last = repoUrl.trim().replace(/\/+$/, '').split(/[\\/]/).pop() ?? ''
  const repo = last.replace(/\.git$/i, '').trim() || 'engine'
  const b = (branch ?? '').trim()
  const sha = (commit ?? '').trim()
  // A pinned commit must land in its OWN dir — otherwise it collapses to the same name as a
  // plain branch build of the same repo and `runBuild`'s clean-start rmSync would silently wipe
  // an existing (possibly currently-installed) build of that repo.
  const raw = sha ? `${repo}-${sha.slice(0, 12)}` : b ? `${repo}-${b}` : repo
  // Keep it tame on disk: collapse anything outside [A-Za-z0-9._-] to a single dash.
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'engine'
}

/** PURE: loose equality of two repo identifiers (full URL or `owner/repo`), ignoring scheme,
 *  a `github.com/` host prefix, a trailing `.git`/slash, and case. Lets us match a catalog
 *  entry's homepage to a source-built engine's stored `sourceRepo`. */
export function sameRepo(a?: string, b?: string): boolean {
  const na = normRepoUrl(a)
  return na !== '' && na === normRepoUrl(b)
}

/** PURE: normalize a repo identifier (full URL or `owner/repo`) to a comparable/keyable form —
 *  strips scheme, a `github.com/` host prefix, a trailing `.git`/slash, and case. Exported (not
 *  just {@link sameRepo}'s internal helper) so a stable per-repo KEY can be built the same way
 *  a match is judged — e.g. {@link customSourceKey} in registry.ts. */
export function normRepoUrl(s?: string): string {
  return (s ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/** The built `llama-server` for a repo (+optional branch) under `enginesRoot`, or null. Used
 *  to detect a source-built engine whose registry entry was removed (disabled) but whose build
 *  output still sits on disk under `engines/build/<slug>/`. */
export function sourceBuildBinary(enginesRoot: string, repoUrl: string, branch?: string, commit?: string): string | null {
  const root = join(enginesRoot, 'build', buildDirName(repoUrl, branch, commit))
  return resolveServerBinary(join(root, 'build')) ?? resolveServerBinary(root)
}

/** PURE: given a built engine's binPath, the `engines/build/<slug>` dir it lives under (for
 *  purge), or null when the path isn't a source-build output. */
export function sourceBuildDirOf(binPath: string, enginesRoot: string): string | null {
  const m = binPath.replace(/\\/g, '/').match(/\/engines\/build\/([^/]+)(?:\/|$)/i)
  if (!m) return null
  return join(enginesRoot, 'build', m[1])
}

/** PURE: prefer Ninja (fast, parallel) when a ninja executable is reachable; else fall back
 *  to the platform's always-available generator — NMake Makefiles on Windows (ships with the
 *  MSVC Build Tools, available after vcvars) or Unix Makefiles on Linux (ships with `make`). */
export function pickGenerator(hasNinja: boolean, isWindows: boolean): 'Ninja' | 'NMake Makefiles' | 'Unix Makefiles' {
  if (hasNinja) return 'Ninja'
  return isWindows ? 'NMake Makefiles' : 'Unix Makefiles'
}

/** PURE: true when a macOS Metal build's compile log shows the fork's own source calling
 *  Metal-backend symbols (ggml_backend_is_metal, ggml_backend_metal_*) that its vendored ggml
 *  doesn't actually implement — i.e. this specific fork's Metal support is incomplete, not a
 *  transient/environmental failure. Lets the 1-click build retry as CPU-only instead of just
 *  failing (seen in the wild: ik_llama.cpp). */
export function isIncompleteMetalBackendError(log: string[]): boolean {
  return log.some((line) => /undeclared identifier 'ggml_backend_(is_metal|metal_\w+)'/.test(line))
}

/** PURE: the actionable failure message when the cloned repo isn't a llama.cpp-family CMake
 *  project — null when it is. Checked right after cloning: without it, a Python-only engine
 *  (e.g. exllamav3, GitHub #61) burns through the toolchain checks and clone, then dies on a
 *  bare "cmake exited with code 1" with the real reason (no CMakeLists.txt) buried in the
 *  scrolled build log instead of the headline error. */
export function notCmakeProjectError(hasCMakeLists: boolean): string | null {
  if (hasCMakeLists) return null
  return (
    "This repository doesn't look like a llama.cpp-based (CMake) project — no CMakeLists.txt was " +
    'found at its root. 1-click build currently only supports llama.cpp-family engines built with ' +
    'CMake. If this project exposes a llama-server-compatible binary some other way, add it as a ' +
    'custom engine by pointing TurboLLM directly at that binary instead of building from source.'
  )
}

/** PURE: the security guard for the optional patch step. A patch may be applied ONLY when a
 *  pinned SHA-256 is supplied to verify its downloaded bytes against — so a `patchUrl` with no
 *  `patchSha256` must refuse *before any network call*. Returns the actionable error string in
 *  that case, else null (no patch, or a patch with a pin — both fine to proceed). */
export function missingPatchShaError(patchUrl?: string, patchSha256?: string): string | null {
  if (!(patchUrl ?? '').trim()) return null
  if ((patchSha256 ?? '').trim()) return null
  return (
    'Refusing to apply a build patch with no pinned SHA-256 checksum — a patch may only be applied when its exact ' +
    'downloaded bytes can be verified against a known hash.'
  )
}

/** PURE: lowercase hex SHA-256 of a buffer — the checksum a downloaded patch's bytes are pinned
 *  against before it is ever applied. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** PURE: null when a downloaded patch's actual SHA-256 matches the pinned one (case-insensitive),
 *  else the actionable hard-fail error. This is the load-bearing safety property of the patched
 *  build: a mutated/compromised remote patch whose bytes don't match the pin must NEVER be
 *  applied — the build stops here instead. */
export function patchChecksumMismatchError(expectedSha256: string, actualSha256: string): string | null {
  const want = expectedSha256.trim().toLowerCase()
  const got = actualSha256.trim().toLowerCase()
  if (want === got) return null
  return (
    `The downloaded patch did not match its pinned SHA-256 checksum (expected ${want}, got ${got}). TurboLLM refused ` +
    'to apply an unverified patch — the remote file may have changed or been tampered with. The build was stopped ' +
    'before any patch was applied.'
  )
}

// CMAKE_CONFIGURE_ARGS now lives in build-prereqs.ts (re-exported below) — it's shared with
// that module's `buildCommands`, the manual-build command list, so the two can never drift.
export { CMAKE_CONFIGURE_ARGS }

/** PURE: a Windows .bat that enters the MSVC dev env (vcvars x64) then runs one cmake step.
 *  All paths are quoted (vcvars/src/build dirs can contain spaces); the cmake exit code is
 *  propagated so a non-zero build fails the step. `cmakeArgs` is the full cmake argv. */
export function vcvarsBatch(vcvars: string, cmakeArgs: string[]): string {
  const quoted = cmakeArgs.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')
  return [
    '@echo off',
    `call "${vcvars}" x64`,
    'if errorlevel 1 exit /b 1',
    `cmake ${quoted}`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** True if `exe` is reachable from any directory on the env's PATH. */
function onPath(env: NodeJS.ProcessEnv, exe: string): boolean {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  return (env[key] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        return existsSync(join(dir, exe))
      } catch {
        return false
      }
    })
}

/** Find the directories that hold the CUDA toolkit's runtime DLLs, version-matched to the
 *  build by anchoring on the toolkit that owns `nvcc` (NOT a stray cudart from an unrelated
 *  app on PATH — e.g. a PyTorch install, which would bundle the wrong version). CUDA 13 ships
 *  the runtime DLLs in `<bin>\x64`; CUDA 12 in `<bin>` itself, so we return both when present.
 *  The build already required nvcc on PATH, so it is found here by construction. */
function cudaDllSourceDirs(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const pathDirs = (env[key] ?? '').split(delimiter).filter(Boolean)
  const nvccDir = pathDirs.find((dir) => {
    try {
      return existsSync(join(dir, 'nvcc.exe'))
    } catch {
      return false
    }
  })
  if (!nvccDir) return []
  return [nvccDir, join(nvccDir, 'x64')].filter((d) => {
    try {
      return existsSync(d)
    } catch {
      return false
    }
  })
}

/** Copy the CUDA runtime DLLs from the build's CUDA toolkit into `destDir`, so the produced
 *  exe is self-contained (a source build doesn't bundle them, unlike the prebuilt release
 *  zips). Each DLL name is copied at most once (first/toolkit source wins). Returns the count. */
function copyCudaRuntimeDlls(env: NodeJS.ProcessEnv, destDir: string, log: (l: string) => void): number {
  const sources = cudaDllSourceDirs(env)
  if (sources.length === 0) {
    log('Note: could not find the CUDA toolkit DLLs to bundle — the engine may need the CUDA bin on PATH to run.')
    return 0
  }
  const seen = new Set<string>()
  let copied = 0
  for (const dir of sources) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      if (!lower.endsWith('.dll')) continue
      if (seen.has(lower)) continue
      if (!CUDA_RUNTIME_DLL_PREFIXES.some((p) => lower.startsWith(p))) continue
      try {
        copyFileSync(join(dir, name), join(destDir, name))
        seen.add(lower)
        copied++
      } catch {
        /* skip a locked/unreadable DLL — best effort */
      }
    }
  }
  if (copied > 0) log(`Bundled ${copied} CUDA runtime DLL(s) next to the binary so the engine is self-contained.`)
  return copied
}

/** Linux equivalent of {@link cudaDllSourceDirs}: anchor on the toolkit that owns `nvcc` on
 *  PATH, then look at the layouts CUDA installs actually use for the runtime libs — `lib64`
 *  or `lib` beside `bin`, and the `targets/x86_64-linux/lib` layout some installers use. */
function cudaSoSourceDirs(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const pathDirs = (env[key] ?? '').split(delimiter).filter(Boolean)
  const nvccDir = pathDirs.find((dir) => {
    try {
      return existsSync(join(dir, 'nvcc'))
    } catch {
      return false
    }
  })
  if (!nvccDir) return []
  const toolkitRoot = dirname(nvccDir)
  return [join(toolkitRoot, 'lib64'), join(toolkitRoot, 'lib'), join(toolkitRoot, 'targets', 'x86_64-linux', 'lib')].filter((d) => {
    try {
      return existsSync(d)
    } catch {
      return false
    }
  })
}

/** Copy the CUDA runtime `.so` files from the build's CUDA toolkit into `destDir` (Linux
 *  equivalent of {@link copyCudaRuntimeDlls}). The binary still needs `LD_LIBRARY_PATH`
 *  pointed at its own directory to find them at runtime (the loader doesn't search the
 *  executable's directory by default, unlike Windows) — the engine launcher does this. */
function copyCudaRuntimeLibs(env: NodeJS.ProcessEnv, destDir: string, log: (l: string) => void): number {
  const sources = cudaSoSourceDirs(env)
  if (sources.length === 0) {
    log('Note: could not find the CUDA toolkit shared libraries to bundle — the engine may need LD_LIBRARY_PATH set to run.')
    return 0
  }
  const seen = new Set<string>()
  let copied = 0
  for (const dir of sources) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (seen.has(name)) continue
      if (!CUDA_RUNTIME_SO_PREFIXES.some((p) => name.startsWith(p))) continue
      try {
        copyFileSync(join(dir, name), join(destDir, name))
        seen.add(name)
        copied++
      } catch {
        /* skip a locked/unreadable lib — best effort */
      }
    }
  }
  if (copied > 0) log(`Bundled ${copied} CUDA runtime librar${copied === 1 ? 'y' : 'ies'} next to the binary so the engine is self-contained.`)
  return copied
}

/** Locate vcvarsall.bat via vswhere (ships with VS / Build Tools). Returns null if VS with
 *  the C++ tools isn't installed or vswhere can't find it. */
async function findVcvarsall(): Promise<string | null> {
  try {
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const { stdout } = await execFileP(
      vswhere,
      ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'VC\\Auxiliary\\Build\\vcvarsall.bat'],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    const p = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

/** The Windows command interpreter to spawn for our vcvars `.bat` steps. Windows always sets
 *  `ComSpec` to the full path of cmd.exe (e.g. `C:\Windows\System32\cmd.exe`), which is the
 *  portable, drive-agnostic way to reach it (Windows may not be on C:). Spawning the bare string
 *  `'cmd.exe'` instead relies on PATH resolution, which can fail with `spawn cmd.exe ENOENT` if
 *  PATH is malformed. The bare-string fallback is defensive only (ComSpec should always be set). */
function winComSpec(): string {
  return process.env.ComSpec || 'cmd.exe'
}

/** Run one child process, streaming combined stdout+stderr line-by-line to `onLine` and
 *  resolving with the full stdout text. Rejects with a clear message on a non-zero exit or
 *  spawn error; aborting `signal` kills the child (Node throws AbortError, name preserved). */
function runStep(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLine: (line: string) => void },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let outBuf = ''
    let errBuf = ''
    const pump = (chunk: string, isErr: boolean) => {
      if (!isErr) stdout += chunk
      let buf = isErr ? errBuf + chunk : outBuf + chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        opts.onLine(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
      }
      if (isErr) errBuf = buf
      else outBuf = buf
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => pump(c, false))
    child.stderr.on('data', (c: string) => pump(c, true))
    child.on('error', (e) => reject(e)) // includes AbortError when signal fires
    child.on('close', (code) => {
      if (outBuf) opts.onLine(outBuf.replace(/\r$/, ''))
      if (errBuf) opts.onLine(errBuf.replace(/\r$/, ''))
      if (code === 0) resolve(stdout)
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

/** True if `dir` (recursively) contains any assembly source the build could compile. We skip
 *  VCS / build / dep dirs. Used to decide whether an enabled CMake `ASM` language is real or
 *  gratuitous. */
function hasAssemblySources(dir: string): boolean {
  const SKIP = new Set(['.git', 'build', 'node_modules', '.cache', 'vendor'])
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name.toLowerCase()) && !e.name.startsWith('.')) stack.push(join(d, e.name))
      } else if (/\.(s|asm)$/i.test(e.name)) {
        return true
      }
    }
  }
  return false
}

/** PURE: remove the generic CMake `ASM` language enablement from one CMakeLists' text. Strips
 *  the `ASM` token from `project(... ASM ...)` and comments out standalone `enable_language(ASM)`
 *  lines. Returns the new text + whether anything changed. Only safe to apply when the repo has
 *  NO assembly sources (nothing to actually assemble). */
export function stripGenericAsmLanguage(text: string): { text: string; changed: boolean } {
  let changed = false
  const out = text.split(/\r?\n/).map((line) => {
    if (/\bproject\s*\(/i.test(line) && /\bASM\b/.test(line)) {
      const next = line.replace(/\s+ASM\b/g, '')
      if (next !== line) {
        changed = true
        return next
      }
    }
    if (/^\s*enable_language\s*\(\s*ASM\s*\)/i.test(line)) {
      changed = true
      return `# ${line}  # neutralized by TurboLLM (no assembly sources)`
    }
    return line
  })
  return { text: out.join('\n'), changed }
}

/** Some llama.cpp forks (e.g. TurboQuant) enable CMake's generic `ASM` language in their ggml
 *  project even though they ship NO assembly sources. On modern CMake (CMP0194 NEW) MSVC isn't
 *  accepted as an ASM assembler, so configure dies with "No CMAKE_ASM_COMPILER could be found"
 *  for a language nothing uses. When the repo genuinely has no `.s`/`.asm` files, strip that
 *  unused declaration from its CMakeLists so the MSVC build can proceed — provably a no-op
 *  (there is no assembly to compile). If real assembly exists, we leave it alone. */
function neutralizeGratuitousAsm(srcDir: string, log: (l: string) => void): void {
  if (hasAssemblySources(srcDir)) return // real assembly — needs a real assembler; don't touch
  // The CMakeLists files that can enable the generic ASM language for our Windows+CUDA config.
  const candidates = [join(srcDir, 'CMakeLists.txt'), join(srcDir, 'ggml', 'CMakeLists.txt')]
  let patched = 0
  for (const file of candidates) {
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { text: next, changed } = stripGenericAsmLanguage(text)
    if (changed) {
      try {
        writeFileSync(file, next)
        patched++
      } catch {
        /* best effort */
      }
    }
  }
  if (patched > 0) {
    log(
      'Removed an unused CMake ASM-language declaration (the repo ships no assembly sources) so ' +
        'the build works with MSVC — this fork enables ASM gratuitously, which modern CMake rejects with MSVC.',
    )
  }
}

/** Run the full clone → configure → compile → locate flow. Throws on any failure (the
 *  caller surfaces it via BuildState.fail); on success returns the built binary + commit. */
export async function runBuild(req: BuildRequest, hooks: BuildHooks, signal: AbortSignal): Promise<BuildOutput> {
  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  // Force git to FAIL fast instead of blocking on an interactive credential prompt (a
  // private/typo'd URL would otherwise hang the build with stdin ignored). GCM_INTERACTIVE
  // disables the Git Credential Manager GUI on Windows.
  const env = { ...buildEnv(req.toolchainDirs), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

  // Fail fast with actionable guidance if the toolchain isn't usable, rather than a deep
  // cryptic cmake error. CUDA is required on Windows/Linux (-DGGML_CUDA=ON); macOS builds
  // with Metal instead, a system framework with no separate toolkit to check for.
  hooks.phase('preparing')
  const prereqs = await checkBuildPrereqs(req.toolchainDirs)
  if (!prereqs.supported) throw new Error('In-app build is currently Windows, Linux, or macOS only.')
  const missing = prereqs.tools.filter((t) => (t.id === 'git' || t.id === 'cmake' || t.id === 'cuda') && !t.found)
  if (missing.length > 0) {
    const names = missing.map((t) => t.name).join(', ')
    throw new Error(
      `Missing build prerequisite(s): ${names}. Install them, or — if they live in a conda env / custom path — ` +
        `add that folder under Build environment so TurboLLM can find them.`,
    )
  }
  // Windows: we compile with Ninja/NMake (not the VS generator), so we need the MSVC dev env.
  // Linux/macOS: cmake is invoked directly, so we just need a C++ compiler on PATH.
  let vcvars: string | null = null
  if (isWindows) {
    vcvars = await findVcvarsall()
    if (!vcvars) {
      throw new Error(
        'Could not locate the Visual Studio C++ build environment (vcvarsall.bat). Install the ' +
          '"Desktop development with C++" workload from the Visual Studio Build Tools.',
      )
    }
  } else if (!prereqs.tools.some((t) => t.id === 'gcc' && t.found)) {
    throw new Error(
      isMac
        ? 'Could not find a C++ compiler. Install the Xcode Command Line Tools (`xcode-select --install`) and retry.'
        : 'Could not find a C++ compiler. Install one (e.g. `sudo apt install build-essential` on Debian/Ubuntu) and retry.',
    )
  }

  const buildRoot = join(req.enginesRoot, 'build', buildDirName(req.repoUrl, req.branch, req.commit))
  const srcDir = join(buildRoot, 'src')
  const buildSubdir = join(buildRoot, 'build')
  // Start clean so a rebuild never mixes old + new objects.
  rmSync(buildRoot, { recursive: true, force: true })
  mkdirSync(buildRoot, { recursive: true })

  // 1) Shallow clone — a branch tip, or (when `req.commit` is set) an exact historical SHA.
  hooks.phase('cloning')
  const pinnedCommit = (req.commit ?? '').trim()
  // Windows' default ~260-char MAX_PATH breaks a checkout of any repo with deeply-nested paths
  // (llama.cpp itself ships some, e.g. tools/ui's Svelte components and examples/llama.swiftui's
  // Xcode project) with "Filename too long" / "cannot create directory" — not an edge case, this
  // is the official repo. `core.longpaths` lifts that limit; harmless no-op on Linux/macOS.
  if (pinnedCommit) {
    // A plain `clone --branch` can't check out an arbitrary SHA (shallow history only has the
    // tip). Init + fetch that one commit by SHA instead — GitHub allows fetching any reachable
    // SHA, not just refs.
    mkdirSync(srcDir, { recursive: true })
    await runStep('git', ['init'], { cwd: srcDir, env, signal, onLine: hooks.log })
    if (isWindows) await runStep('git', ['config', 'core.longpaths', 'true'], { cwd: srcDir, env, signal, onLine: hooks.log })
    await runStep('git', ['remote', 'add', 'origin', req.repoUrl], { cwd: srcDir, env, signal, onLine: hooks.log })
    await runStep('git', ['fetch', '--depth', '1', 'origin', pinnedCommit], { cwd: srcDir, env, signal, onLine: hooks.log })
    await runStep('git', ['checkout', 'FETCH_HEAD'], { cwd: srcDir, env, signal, onLine: hooks.log })
  } else {
    const cloneArgs = isWindows ? ['-c', 'core.longpaths=true', 'clone', '--depth', '1'] : ['clone', '--depth', '1']
    if ((req.branch ?? '').trim()) cloneArgs.push('--branch', req.branch!.trim())
    cloneArgs.push(req.repoUrl, srcDir)
    await runStep('git', cloneArgs, { env, signal, onLine: hooks.log })
  }

  // Record the built commit (ADR-088 provenance / rebuild comparison).
  const commit = (await runStep('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { env, signal, onLine: () => {} })).trim()

  // 1b) Apply a pinned, checksum-verified third-party patch on top of the checked-out commit,
  // when the catalog entry ships one — for an architecture not yet in the repo's mainline that
  // needs a patch to compile (e.g. solar_open2). OPT-IN: with no `patchUrl` the build below is
  // byte-for-byte unchanged. The load-bearing safety property is verification: a patch is applied
  // ONLY after its downloaded bytes match a SHA-256 pinned in app code — no pin refuses (before
  // any network call), a byte mismatch hard-fails, so a mutated/compromised remote diff is never
  // silently applied.
  const patchUrl = (req.patchUrl ?? '').trim()
  if (patchUrl) {
    const expectedSha = (req.patchSha256 ?? '').trim()
    const guard = missingPatchShaError(patchUrl, expectedSha)
    if (guard) throw new Error(guard)
    hooks.log(`Downloading build patch from ${patchUrl} …`)
    const res = await fetch(patchUrl, { signal })
    if (!res.ok) throw new Error(`Failed to download the build patch (HTTP ${res.status} ${res.statusText}) from ${patchUrl}.`)
    const patchBytes = Buffer.from(await res.arrayBuffer())
    const actualSha = sha256Hex(patchBytes)
    const mismatch = patchChecksumMismatchError(expectedSha, actualSha)
    if (mismatch) throw new Error(mismatch)
    const patchFile = join(buildRoot, '_tllm_patch.diff')
    writeFileSync(patchFile, patchBytes)
    hooks.log(`Patch verified against its pinned checksum (sha256 ${actualSha.slice(0, 12)}…).`)
    // --check first so a patch that has drifted from the pinned commit fails with a clear reason
    // BEFORE we mutate the working tree, rather than leaving a half-applied source dir behind.
    try {
      await runStep('git', ['-C', srcDir, 'apply', '--check', patchFile], { env, signal, onLine: hooks.log })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      throw new Error(
        'The verified patch does not apply cleanly against the checked-out commit — it may have drifted from the ' +
          'commit it was authored against. ' + (e instanceof Error ? e.message : String(e)),
      )
    }
    await runStep('git', ['-C', srcDir, 'apply', patchFile], { env, signal, onLine: hooks.log })
    hooks.log(`Applied verified patch (sha256 ${actualSha.slice(0, 12)}…) on top of ${commit.slice(0, 8)}.`)
  }

  // Fail fast with an actionable reason when this isn't a llama.cpp-family CMake project at all
  // (GitHub #61) — before sinking minutes into a configure/compile that can only die cryptically.
  const notCmake = notCmakeProjectError(existsSync(join(srcDir, 'CMakeLists.txt')))
  if (notCmake) throw new Error(notCmake)

  // Drop a gratuitous ASM-language declaration some forks ship (no assembly sources) so the
  // MSVC build doesn't die on "No CMAKE_ASM_COMPILER could be found" for a language nothing uses.
  neutralizeGratuitousAsm(srcDir, hooks.log)

  // Pick the generator from what's reachable on PATH (incl. the user's toolchain dirs).
  const generator = pickGenerator(onPath(env, isWindows ? 'ninja.exe' : 'ninja'), isWindows)
  hooks.log(
    generator === 'Ninja'
      ? isWindows
        ? 'Using the Ninja generator (drives nvcc directly — no Visual Studio CUDA integration needed).'
        : 'Using the Ninja generator.'
      : isWindows
      ? 'Ninja not found on PATH — using the NMake generator (works, but single-threaded and slower; ' +
          'add a folder containing ninja.exe under Build environment for much faster builds).'
      : 'Ninja not found on PATH — using Unix Makefiles (works, but single-threaded and slower; ' +
          'add a folder containing ninja under Build environment for much faster builds).',
  )

  // 2) Configure + 3) compile. Windows: inside the MSVC dev env so cl/ml64/INCLUDE/LIB are set
  // (nvcc comes off PATH). Linux/macOS: cmake runs directly — no dev-env shell needed.
  const configureAndCompile = async (cmakeArgs: string[], log: string[]) => {
    const captureLog = (line: string) => { log.push(line); hooks.log(line) }
    hooks.phase('configuring')
    const configureArgs = ['-G', generator, '-B', buildSubdir, '-S', srcDir, ...cmakeArgs]
    if (isWindows) {
      const configureBat = join(buildRoot, '_tllm_configure.bat')
      writeFileSync(configureBat, vcvarsBatch(vcvars!, configureArgs))
      await runStep(winComSpec(), ['/c', configureBat], { cwd: buildRoot, env, signal, onLine: captureLog })
    } else {
      await runStep('cmake', configureArgs, { cwd: buildRoot, env, signal, onLine: captureLog })
    }

    // Compile just the server target (Ninja/Makefiles parallelize with -j; NMake ignores it).
    hooks.phase('compiling')
    const compileArgs = ['--build', buildSubdir, '-j', '--target', 'llama-server']
    if (isWindows) {
      const compileBat = join(buildRoot, '_tllm_build.bat')
      writeFileSync(compileBat, vcvarsBatch(vcvars!, compileArgs))
      await runStep(winComSpec(), ['/c', compileBat], { cwd: buildRoot, env, signal, onLine: captureLog })
    } else {
      await runStep('cmake', compileArgs, { cwd: buildRoot, env, signal, onLine: captureLog })
    }
  }

  const buildLog: string[] = []
  try {
    await configureAndCompile(isMac ? CMAKE_CONFIGURE_ARGS_MACOS : CMAKE_CONFIGURE_ARGS, buildLog)
  } catch (e) {
    // Some forks reference Metal-backend symbols their own vendored ggml doesn't implement
    // (their Metal support is incomplete, not TurboLLM's build config) — retry CPU-only rather
    // than just failing. Not a concern on Windows/Linux, which don't attempt Metal at all.
    if (!isMac || !isIncompleteMetalBackendError(buildLog)) throw e
    hooks.log(
      "This fork's Metal backend looks incomplete (references ggml_backend_metal_* symbols its " +
        'own ggml build doesn\'t implement) — retrying as a CPU-only build.',
    )
    rmSync(buildSubdir, { recursive: true, force: true })
    buildLog.length = 0
    await configureAndCompile(CMAKE_CONFIGURE_ARGS_MACOS_CPU, buildLog)
  }

  // 4) Locate the produced binary (Ninja: build/bin/llama-server[.exe]; layouts vary).
  hooks.phase('registering')
  const binPath = resolveServerBinary(buildSubdir) ?? resolveServerBinary(buildRoot)
  if (!binPath) {
    throw new Error('Build finished but no llama-server binary was found in the output — see the log above.')
  }
  // Make the engine self-contained: a source build doesn't bundle the CUDA runtime
  // DLLs/.so's, so copy them next to the binary (else the probe + every launch fail to
  // start with missing libs). On Linux the engine launcher also points LD_LIBRARY_PATH
  // at the binary's own directory so these bundled .so's are actually found at runtime.
  // macOS builds link Metal (a system framework), so there's nothing to bundle.
  if (isWindows) copyCudaRuntimeDlls(env, dirname(binPath), hooks.log)
  else if (!isMac) copyCudaRuntimeLibs(env, dirname(binPath), hooks.log)
  return { binPath, commit, buildRoot }
}
