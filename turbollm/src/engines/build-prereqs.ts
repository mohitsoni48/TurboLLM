// Compile-from-source (Windows/Linux + CUDA, or macOS + Metal) — prerequisite checker + build
// commands (ADR-089, Linux port; macOS/Metal port). Detects the build toolchain
// (git/cmake/CUDA-or-compiler), tells the user what's missing (with install links), and the
// in-app 1-click build (ADR-100, build-runner.ts) runs the exact commands here. macOS has no
// CUDA, so it builds with Metal instead — no GPU-toolkit prereq, just git/cmake/clang++.
//
// Toolchain dirs (ADR-100): the daemon inherits the system PATH, so a CUDA Toolkit /
// compiler installed in a conda env or a custom location isn't found. {@link buildEnv}
// prepends user-configured dirs to PATH for BOTH the probe below and the real build, so
// pointing at e.g. a conda env's bin makes `nvcc` resolve.
import { execFile } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Build a child-process env with `toolchainDirs` prepended to PATH. Empty/blank dirs are
 *  dropped. PATH is matched case-insensitively (Windows uses `Path`); we write back to the
 *  same key name the parent used so we never end up with a duplicate `PATH`/`Path` pair.
 *
 *  IMPORTANT (Windows `spawn cmd.exe ENOENT`): the returned env is a FULL copy of the parent
 *  `process.env`, so the OS-critical vars Windows needs to resolve a bare command — `SystemRoot`
 *  / `windir` (System32 location), `PATHEXT`, and `ComSpec` (cmd.exe path) — are always carried
 *  through. We also split each PATH segment individually and drop empty ones, so a stray
 *  leading/trailing/doubled delimiter (`;` on Windows) can never survive into the child's PATH —
 *  a malformed PATH is one way Windows fails to resolve `cmd.exe`. */
export function buildEnv(toolchainDirs: string[] = []): NodeJS.ProcessEnv {
  const dirs = toolchainDirs.map((d) => d.trim()).filter(Boolean)
  const env = { ...process.env }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  // Rebuild PATH from the toolchain dirs + every non-empty existing segment. Splitting and
  // re-filtering guarantees no empty/blank segments (i.e. no leading/trailing/doubled delimiter),
  // which is what can otherwise break command resolution on Windows.
  const existing = (env[key] ?? '').split(delimiter)
  const segments = [...dirs, ...existing].map((s) => s.trim()).filter(Boolean)
  // Only touch PATH if the parent had one (or we're adding dirs); write back the cleaned value
  // even when it collapses to empty, so a parent PATH of only delimiters can't survive malformed.
  if (env[key] !== undefined || dirs.length > 0) env[key] = segments.join(delimiter)
  return env
}

/** One build-toolchain prerequisite (git / cmake / CUDA / MSVC or gcc). */
export interface BuildPrereqTool {
  id: 'git' | 'cmake' | 'cuda' | 'msvc' | 'gcc'
  name: string
  found: boolean
  version?: string
  installUrl: string
  /** The ordered package-manager steps that would actually install this tool ON THIS HOST
   *  (each entry is an argv: `[cmd, ...args]`), or undefined when there's no clean one-command
   *  install and the {@link installUrl} website is the only realistic path.
   *
   *  Why this exists: `installUrl` is a DEAD END for anyone self-hosting headlessly (a Docker
   *  container / remote Linux box with no local browser) — clicking that link in the web UI
   *  opens a page in the *operator's own* browser, which installs nothing on the server that
   *  actually needs the toolchain. These commands let the daemon install the prereq on the
   *  machine that needs it (POST /api/v1/build/install-prereq → build-runner.ts's
   *  `runPrereqInstall`), gated to the local host exactly like the 1-click build. Only ever
   *  populated for a tool that is missing. */
  installCommands?: string[][]
}

export interface BuildPrereqs {
  /** Guided build supports Windows, Linux (both + CUDA), macOS (+ Metal), and Android/Termux
   *  (+ CPU only — see CMAKE_CONFIGURE_ARGS_ANDROID). */
  supported: boolean
  /** Which toolchain shape `tools`/`buildCommands` reflect. 'other' when unsupported. */
  os: 'windows' | 'linux' | 'macos' | 'android' | 'other'
  tools: BuildPrereqTool[]
  /** The host package manager the `installCommands` above were generated for, or null when
   *  none was detected (or on Windows, where these tools need GUI installers). Surfaced so
   *  the UI can say WHICH manager it would use rather than just showing a bare button. */
  packageManager: PackageManager | null
}

/** A package manager we know how to drive non-interactively for the build prereqs.
 *  Windows is deliberately absent — MSVC and the CUDA Toolkit need GUI installers there, so
 *  Windows keeps the website-link behavior. */
export type PackageManager = 'apt-get' | 'dnf' | 'pacman' | 'zypper' | 'brew'

/** Linux managers, probed in this order (first one present wins). */
const LINUX_PACKAGE_MANAGERS: PackageManager[] = ['apt-get', 'dnf', 'pacman', 'zypper']

/** Which distro package(s) provide each prereq, per manager. A missing entry means there is no
 *  clean one-command install for that tool with that manager — the website link stays the only
 *  option (notably CUDA on dnf/zypper, which realistically needs NVIDIA's own repo bootstrap
 *  rather than a single install, and every compiler/toolkit on macOS other than via Homebrew). */
const PACKAGES: Record<PackageManager, Partial<Record<BuildPrereqTool['id'], string[]>>> = {
  'apt-get': { git: ['git'], cmake: ['cmake'], gcc: ['build-essential'], cuda: ['nvidia-cuda-toolkit'] },
  dnf: { git: ['git'], cmake: ['cmake'], gcc: ['gcc-c++', 'make'] },
  pacman: { git: ['git'], cmake: ['cmake'], gcc: ['base-devel'], cuda: ['cuda'] },
  zypper: { git: ['git'], cmake: ['cmake'], gcc: ['gcc-c++', 'make'] },
  // macOS: the compiler is the Xcode Command Line Tools (`xcode-select --install` opens a GUI
  // prompt, so it isn't something to run for the user headlessly) and there is no CUDA at all.
  brew: { git: ['git'], cmake: ['cmake'] },
}

/** PURE: the privilege prefix for a system package manager. Running as root (the normal case
 *  inside a Docker container — exactly the headless setup this is for) needs none. Otherwise
 *  `sudo -n`: NON-interactive on purpose, so a box that would prompt for a password fails fast
 *  with a clear error instead of hanging forever on a stdin nothing is attached to. Homebrew
 *  must never be run under sudo, so it passes `sudo:false`. */
function privilegePrefix(asRoot: boolean): string[] {
  return asRoot ? [] : ['sudo', '-n']
}

/** PURE: the ordered argv steps that install `id` with `pm`, or undefined when that
 *  combination has no clean one-command install (→ the caller keeps the website link).
 *  `asRoot` skips the sudo prefix (see {@link privilegePrefix}).
 *
 *  The package-list refresh matters, it isn't belt-and-braces: a fresh Debian/Ubuntu container
 *  ships with NO apt lists, so `apt-get install` there fails with "Unable to locate package"
 *  every time — which is precisely the environment this feature exists for. */
export function prereqInstallCommands(
  pm: PackageManager,
  id: BuildPrereqTool['id'],
  asRoot: boolean,
): string[][] | undefined {
  const pkgs = PACKAGES[pm][id]
  if (!pkgs || pkgs.length === 0) return undefined
  if (pm === 'brew') return [['brew', 'install', ...pkgs]] // never under sudo
  const sudo = privilegePrefix(asRoot)
  switch (pm) {
    case 'apt-get':
      return [[...sudo, 'apt-get', 'update'], [...sudo, 'apt-get', 'install', '-y', ...pkgs]]
    case 'dnf':
      return [[...sudo, 'dnf', 'install', '-y', ...pkgs]]
    case 'pacman':
      // -Sy (not -S): a container's pacman db is typically empty/stale, which fails the install.
      return [[...sudo, 'pacman', '-Sy', '--noconfirm', ...pkgs]]
    case 'zypper':
      return [[...sudo, 'zypper', '--non-interactive', 'install', ...pkgs]]
  }
}

/** True when this process can install system packages without sudo. `process.getuid` is
 *  POSIX-only (undefined on Windows) — the optional call keeps this cross-platform. */
function runningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

/** Which package manager this host actually has, probed the same way the tools above are —
 *  by running it and seeing whether it's there. Linux tries the known managers in order;
 *  macOS only has Homebrew; Windows has none (its prereqs need GUI installers). */
export async function detectPackageManager(env: NodeJS.ProcessEnv): Promise<PackageManager | null> {
  const candidates: PackageManager[] =
    process.platform === 'linux' ? LINUX_PACKAGE_MANAGERS : process.platform === 'darwin' ? ['brew'] : []
  for (const pm of candidates) {
    try {
      await runVersion(pm, ['--version'], env)
      return pm
    } catch {
      // not installed / not on PATH — try the next one
    }
  }
  return null
}

const INSTALL_URLS: Record<BuildPrereqTool['id'], string> = {
  git: 'https://git-scm.com/downloads',
  cmake: 'https://cmake.org/download/',
  cuda: 'https://developer.nvidia.com/cuda-downloads',
  // The "Desktop development with C++" workload from the VS Build Tools installer.
  msvc: 'https://visualstudio.microsoft.com/downloads/',
  gcc: 'https://gcc.gnu.org/install/',
}

/** Run a version command with a short timeout; return its trimmed stdout (or stderr —
 *  some tools, e.g. nvcc, print to stdout; vswhere to stdout too). Throws if the tool
 *  is missing or errors, which the caller turns into `found:false`. `env` carries the
 *  PATH override (ADR-100) so tools in a conda env / custom dir are found. */
async function runVersion(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout, stderr } = await execFileP(cmd, args, {
    timeout: 8000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env,
  })
  return (stdout || stderr || '').trim()
}

/** Parse `git --version` → the bare version (e.g. "2.45.1"), or '' if unparseable. */
function parseGitVersion(out: string): string {
  // Windows git reports "git version 2.52.0.windows.1" — take only the numeric release.
  const m = out.match(/git version\s+(\d+(?:\.\d+)*)/i)
  return m ? m[1] : ''
}

/** Parse `cmake --version` → the bare version (e.g. "3.30.2"), or '' if unparseable. */
function parseCmakeVersion(out: string): string {
  const m = out.match(/cmake version\s+([\d.]+)/i)
  return m ? m[1] : ''
}

/** Parse `nvcc --version` → the CUDA release version (e.g. "12.6"), or '' if unparseable. */
function parseNvccVersion(out: string): string {
  // e.g. "Cuda compilation tools, release 12.6, V12.6.20"
  const m = out.match(/release\s+([\d.]+)/i)
  return m ? m[1] : ''
}

/** Parse `g++ --version` / `clang++ --version` → the bare version, or '' if unparseable.
 *  e.g. "g++ (Ubuntu 13.2.0-4ubuntu3) 13.2.0" or "Ubuntu clang version 18.1.3 (…)". */
function parseCompilerVersion(out: string): string {
  const m = out.match(/(?:g\+\+|gcc|clang(?:\+\+)?)[^\d]*(\d+(?:\.\d+)*)/i)
  return m ? m[1] : ''
}

async function checkGit(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseGitVersion(await runVersion('git', ['--version'], env)) || undefined
    found = true
  } catch {
    found = false
  }
  return { id: 'git', name: 'Git', found, version, installUrl: INSTALL_URLS.git }
}

async function checkCmake(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseCmakeVersion(await runVersion('cmake', ['--version'], env)) || undefined
    found = true
  } catch {
    found = false
  }
  return { id: 'cmake', name: 'CMake', found, version, installUrl: INSTALL_URLS.cmake }
}

async function checkCuda(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseNvccVersion(await runVersion('nvcc', ['--version'], env)) || undefined
    found = true
  } catch {
    found = false
  }
  return { id: 'cuda', name: 'CUDA Toolkit', found, version, installUrl: INSTALL_URLS.cuda }
}

/** Detect the MSVC C++ Build Tools via vswhere.exe (ships with VS / Build Tools). We ask
 *  it for the latest install that has the C++ x64/x86 tools component and return its
 *  installationVersion. A missing component (no version printed) or a missing vswhere →
 *  not found. */
async function checkMsvc(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const out = await runVersion(vswhere, [
      '-latest',
      '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationVersion',
    ], env)
    version = out.split(/\r?\n/)[0]?.trim() || undefined
    found = !!version
  } catch {
    found = false
  }
  return {
    id: 'msvc',
    name: 'Visual Studio C++ Build Tools',
    found,
    version,
    installUrl: INSTALL_URLS.msvc,
  }
}

/** Detect a C++ compiler on Linux via `g++`, falling back to `clang++` if g++ isn't on PATH. */
async function checkGcc(env: NodeJS.ProcessEnv): Promise<BuildPrereqTool> {
  let found = false
  let version: string | undefined
  try {
    version = parseCompilerVersion(await runVersion('g++', ['--version'], env)) || undefined
    found = true
  } catch {
    try {
      version = parseCompilerVersion(await runVersion('clang++', ['--version'], env)) || undefined
      found = true
    } catch {
      found = false
    }
  }
  return { id: 'gcc', name: 'C++ compiler (g++/clang++)', found, version, installUrl: INSTALL_URLS.gcc }
}

/** Detect the build toolchain: Windows/Linux + CUDA, macOS + Metal, or Android/Termux + CPU
 *  (no GPU toolkit needed for macOS/Android — Metal is a system framework and Android v1 is
 *  CPU-only, so both only need git/cmake/a C++ compiler; `checkGcc` already falls back to
 *  `clang++`, which is what Termux's `pkg install clang` provides). `toolchainDirs` (ADR-100)
 *  are prepended to PATH so a conda-env / custom-path CUDA Toolkit is detected. */
export async function checkBuildPrereqs(toolchainDirs: string[] = []): Promise<BuildPrereqs> {
  const platform = process.platform
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin' && platform !== 'android') {
    return { supported: false, os: 'other', tools: [], packageManager: null }
  }
  const env = buildEnv(toolchainDirs)
  // Android/Termux: CPU-only, no package-manager-driven prereq install (Termux uses `pkg`,
  // outside the PackageManager union above) — buildCommands()'s android branch leads with
  // `pkg install` directly instead.
  if (platform === 'android') {
    const tools = await Promise.all([checkGit(env), checkCmake(env), checkGcc(env)])
    return { supported: true, os: 'android', tools, packageManager: null }
  }
  const [tools, packageManager] = await Promise.all([
    platform === 'darwin'
      ? Promise.all([checkGit(env), checkCmake(env), checkGcc(env)])
      : platform === 'win32'
      ? Promise.all([checkGit(env), checkCmake(env), checkCuda(env), checkMsvc(env)])
      : Promise.all([checkGit(env), checkCmake(env), checkCuda(env), checkGcc(env)]),
    detectPackageManager(env),
  ])
  return {
    supported: true,
    os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux',
    tools: withInstallCommands(tools, packageManager),
    packageManager,
  }
}

/** PURE: attach the host install command(s) to every MISSING tool (a tool that's already there
 *  never needs one). Tools with no clean package-manager install keep only their website link. */
export function withInstallCommands(tools: BuildPrereqTool[], pm: PackageManager | null): BuildPrereqTool[] {
  if (!pm) return tools
  const asRoot = runningAsRoot()
  return tools.map((t) => {
    if (t.found) return t
    const installCommands = prereqInstallCommands(pm, t.id, asRoot)
    return installCommands ? { ...t, installCommands } : t
  })
}

/** The cmake CUDA configure flags — shared with the 1-click build (build-runner.ts imports
 *  this) so the manual path below can never drift from what the in-app builder actually runs.
 *  `-allow-unsupported-compiler` works around nvcc's hardcoded host-compiler allowlist (e.g.
 *  CUDA 13.0 only recognizes MSVC toolsets up to VS2022): a new VS/GCC release routinely ships
 *  before NVIDIA updates that list, and CMake's own CUDA compiler-id trial-compile dies on it
 *  before any real compilation happens. The flag only skips that version *check* — a no-op when
 *  the host compiler is already allowlisted — so it's safe to pass unconditionally. */
export const CMAKE_CONFIGURE_ARGS = ['-DGGML_CUDA=ON', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler']

/** The cmake Metal configure flags for a macOS build — no CUDA-style unsupported-compiler
 *  escape hatch needed (Metal is built via the system Xcode toolchain, not a separately
 *  versioned GPU toolkit). */
export const CMAKE_CONFIGURE_ARGS_MACOS = ['-DGGML_METAL=ON', '-DCMAKE_BUILD_TYPE=Release']

/** CPU-only fallback for a macOS build whose fork references Metal-backend symbols its own
 *  vendored ggml doesn't implement (build-runner.ts retries with this after detecting that
 *  specific failure — see isIncompleteMetalBackendError). */
export const CMAKE_CONFIGURE_ARGS_MACOS_CPU = ['-DGGML_METAL=OFF', '-DCMAKE_BUILD_TYPE=Release']

/** Android/Termux v1 is CPU-only (ggml's CPU backend needs no extra flags to build) —
 *  no Vulkan here yet, unlike desktop Linux/Windows, since llama.cpp's Vulkan backend on
 *  Android is real but device-dependent and unverified on real hardware so far. Revisit once
 *  the CPU path has real-device confirmation (GitHub #52 item 6). */
export const CMAKE_CONFIGURE_ARGS_ANDROID = ['-DCMAKE_BUILD_TYPE=Release']

/** CUDA runtime DLLs (Windows) / shared libs (Linux) a llama.cpp CUDA build links against at
 *  runtime. A build does NOT bundle these, so without copying them next to the binary the
 *  engine silently falls back to CPU. Shared with build-runner.ts's 1-click-build copy step. */
export const CUDA_RUNTIME_DLL_PREFIXES = ['cudart64_', 'cublas64_', 'cublaslt64_', 'nvrtc64_', 'nvrtc-builtins64_', 'nvjitlink_']
export const CUDA_RUNTIME_SO_PREFIXES = ['libcudart.so', 'libcublas.so', 'libcublasLt.so', 'libnvrtc.so', 'libnvrtc-builtins.so', 'libnvJitLink.so']

/** PURE: the exact build command list for `repoUrl` (optional `branch`) on `os`. Used by
 *  the guide's copy-able command block. The trailing comment notes where the binary lands
 *  so the user knows what to point "Add your own engine" at. Defaults to the host's own
 *  platform when `os` is omitted (matches what the 1-click build actually runs here). A
 *  CUDA source build doesn't bundle the CUDA runtime, so — mirroring build-runner.ts's own
 *  post-build copy — we add a step that bundles it next to the binary; otherwise the built
 *  engine runs (CPU-only) with no indication it silently skipped the GPU. Metal needs no such
 *  step — it's a system framework, always present, nothing to bundle. */
export function buildCommands(
  repoUrl: string,
  branch?: string,
  os: 'windows' | 'linux' | 'macos' | 'android' = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
    ? 'macos'
    : process.platform === 'android'
    ? 'android'
    : 'linux',
): string[] {
  const b = (branch ?? '').trim()
  // Quote the branch + URL so the copy-pasted command survives a space/special char
  // in either (display-only; values come from the catalog, but the user pastes this).
  const clone = b
    ? `git clone --branch "${b}" --depth 1 "${repoUrl}" turbo-build`
    : `git clone --depth 1 "${repoUrl}" turbo-build`
  if (os === 'macos') {
    return [
      clone,
      'cd turbo-build',
      `cmake -B build ${CMAKE_CONFIGURE_ARGS_MACOS.join(' ')}`,
      'cmake --build build -j --target llama-server',
      '# Built binary: build/bin/llama-server — add it via "Add your own engine".',
    ]
  }
  if (os === 'android') {
    // Termux ships none of git/cmake/clang by default — unlike the desktop OSes, where a
    // compiler is a reasonable baseline assumption, so the command list leads with the pkg
    // install step rather than pointing at an external download page.
    return [
      'pkg install -y git cmake clang',
      clone,
      'cd turbo-build',
      `cmake -B build ${CMAKE_CONFIGURE_ARGS_ANDROID.join(' ')}`,
      'cmake --build build -j --target llama-server',
      '# Built binary: build/bin/llama-server — add it via "Add your own engine".',
    ]
  }
  const configure = `cmake -B build ${CMAKE_CONFIGURE_ARGS.join(' ')}`
  if (os === 'linux') {
    // CUDA 13 vs 12 lay the runtime libs out differently (lib64 vs lib vs the
    // targets/x86_64-linux/lib some installers use) — try all three; a glob that matches
    // nothing just makes cp emit a (silenced) "no such file" for that one literal token.
    const libGlobs = ['lib64', 'lib', 'targets/x86_64-linux/lib']
      .flatMap((dir) => CUDA_RUNTIME_SO_PREFIXES.map((p) => `$CUDA_ROOT/${dir}/${p}*`))
      .join(' ')
    return [
      clone,
      'cd turbo-build',
      configure,
      'cmake --build build -j --target llama-server',
      'CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"',
      `cp ${libGlobs} build/bin/ 2>/dev/null`,
      '# Built binary + its CUDA runtime libs: build/bin/llama-server — add it via "Add your own engine".',
    ]
  }
  // CUDA 13 ships the runtime DLLs under bin\x64; CUDA 12 puts them in bin itself — check both.
  const dllGlobs = ['bin', 'bin\\x64']
    .flatMap((dir) => CUDA_RUNTIME_DLL_PREFIXES.map((p) => `"%CUDA_PATH%\\${dir}\\${p}*.dll"`))
    .join(' ')
  return [
    clone,
    'cd turbo-build',
    configure,
    'cmake --build build --config Release -j --target llama-server',
    `for %f in (${dllGlobs}) do copy /y "%f" "build\\bin\\Release\\" >nul 2>&1`,
    '# Built binary + its CUDA runtime DLLs: build\\bin\\Release\\llama-server.exe — add it via "Add your own engine".',
  ]
}
