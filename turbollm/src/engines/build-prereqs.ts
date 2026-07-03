// Compile-from-source (Windows or Linux + CUDA) — prerequisite checker + build commands
// (ADR-089, Linux port). Detects the build toolchain (git/cmake/CUDA/compiler), tells the
// user what's missing (with install links), and the in-app 1-click build (ADR-100,
// build-runner.ts) runs the exact commands here. macOS is parked — `checkBuildPrereqs`
// reports `supported:false` there (no CUDA on macOS).
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
}

export interface BuildPrereqs {
  /** Guided build is Windows/Linux + CUDA only for now. False on macOS (parked). */
  supported: boolean
  /** Which toolchain shape `tools`/`buildCommands` reflect. 'other' when unsupported. */
  os: 'windows' | 'linux' | 'other'
  tools: BuildPrereqTool[]
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

/** Detect the Windows or Linux + CUDA build toolchain. On macOS the guided build is parked,
 *  so this returns `{ supported:false, os:'other', tools:[] }` without probing anything.
 *  `toolchainDirs` (ADR-100) are prepended to PATH so a conda-env / custom-path CUDA Toolkit
 *  is detected. */
export async function checkBuildPrereqs(toolchainDirs: string[] = []): Promise<BuildPrereqs> {
  const platform = process.platform
  if (platform !== 'win32' && platform !== 'linux') {
    return { supported: false, os: 'other', tools: [] }
  }
  const env = buildEnv(toolchainDirs)
  const tools = platform === 'win32'
    ? await Promise.all([checkGit(env), checkCmake(env), checkCuda(env), checkMsvc(env)])
    : await Promise.all([checkGit(env), checkCmake(env), checkCuda(env), checkGcc(env)])
  return { supported: true, os: platform === 'win32' ? 'windows' : 'linux', tools }
}

/** PURE: the exact build command list for `repoUrl` (optional `branch`) on `os`. Used by
 *  the guide's copy-able command block. The trailing comment notes where the binary lands
 *  so the user knows what to point "Add your own engine" at. Defaults to the host's own
 *  platform when `os` is omitted (matches what the 1-click build actually runs here). */
export function buildCommands(
  repoUrl: string,
  branch?: string,
  os: 'windows' | 'linux' = process.platform === 'win32' ? 'windows' : 'linux',
): string[] {
  const b = (branch ?? '').trim()
  // Quote the branch + URL so the copy-pasted command survives a space/special char
  // in either (display-only; values come from the catalog, but the user pastes this).
  const clone = b
    ? `git clone --branch "${b}" --depth 1 "${repoUrl}" turbo-build`
    : `git clone --depth 1 "${repoUrl}" turbo-build`
  if (os === 'linux') {
    return [
      clone,
      'cd turbo-build',
      'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
      'cmake --build build -j --target llama-server',
      '# Built binary: build/bin/llama-server — add it via "Add your own engine".',
    ]
  }
  return [
    clone,
    'cd turbo-build',
    'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
    'cmake --build build --config Release -j --target llama-server',
    '# Built binary: build\\bin\\Release\\llama-server.exe — add it via "Add your own engine".',
  ]
}
