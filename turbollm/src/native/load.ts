// Finds, opens and version-checks TurboLLM's native core (architecture 2.3 and 5.3 of the
// rust-core run). There is no TypeScript fallback (B-1) and nothing is compiled on install
// (ADR-302): when no binary loads, the daemon stops with one actionable error.
//
// Binaries are opened with process.dlopen, never require(path): require parses any file not
// ending in .js/.json/.node as JavaScript, and the Android library is a .so (plan P-3).
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one table of systems the core ships for: system label -> npm target suffix. Same suffixes, same order, as
 * core/scripts/targets.mjs (load.test.ts checks).
 */
const TARGET_BY_SYSTEM = {
  'win32-x64': 'win32-x64-msvc',
  'win32-arm64': 'win32-arm64-msvc',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64-gnu': 'linux-x64-gnu',
  'linux-arm64-gnu': 'linux-arm64-gnu',
  'linux-x64-musl': 'linux-x64-musl',
  'linux-arm64-musl': 'linux-arm64-musl',
  'android-arm64': 'android-arm64',
} as const satisfies Record<string, string>

export type NativeTarget = (typeof TARGET_BY_SYSTEM)[keyof typeof TARGET_BY_SYSTEM]

export const SUPPORTED_TARGETS: readonly NativeTarget[] = Object.freeze(Object.values(TARGET_BY_SYSTEM))

/** The systems of SUPPORTED_TARGETS in words, for every message that tells a user where TurboLLM runs. */
export const SUPPORTED_SYSTEMS =
  'Windows x64 and arm64, macOS x64 and arm64, Linux x64 and arm64 (glibc 2.28 or newer, or musl), ' +
  'Android arm64 (Termux)'

/** The addon's exports, as core/scripts/build-node.mjs generates them from the Rust crate. */
export type CoreBinding = typeof import('./binding.generated')

type Libc = 'gnu' | 'musl'

/** Everything the search touches outside this module, so tests can drive it with fakes (plan P-4). */
export interface LoaderIo {
  env: { readonly TURBOLLM_CORE_PATH?: string }
  platform: NodeJS.Platform
  arch: string
  libc: Libc | null
  nodeVersion: string
  packageVersion: string
  sourceMode: boolean
  bundleDir: string
  exists(path: string): boolean
  dlopen(path: string): CoreBinding
  resolvePackage(name: string): string
  warn(message: string): void
}

export interface LoadAttempt {
  source: string
  error: string
}

export class CoreLoadError extends Error {
  readonly code: 'core_unavailable' | 'core_version_mismatch'
  readonly attempts: ReadonlyArray<LoadAttempt>

  constructor(code: CoreLoadError['code'], message: string, attempts: ReadonlyArray<LoadAttempt>) {
    super(message)
    this.name = 'CoreLoadError'
    this.code = code
    this.attempts = attempts
  }
}

let loadedCore: CoreBinding | undefined

export function loadCore(): CoreBinding {
  loadedCore ??= resolveCore(realIo())
  return loadedCore
}

export function resolveCore(io: LoaderIo): CoreBinding {
  const attempts: LoadAttempt[] = []
  for (const candidate of searchOrder(io)) {
    let core: CoreBinding
    try {
      core = io.dlopen(candidate.locate())
    } catch (error) {
      attempts.push({ source: candidate.source, error: reasonOf(error) })
      continue
    }
    return acceptVersion(io, core, candidate.source)
  }
  throw coreUnavailable(io, attempts)
}

export function nativeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libc?: Libc | null,
): NativeTarget | null {
  const systemLibc = platform === 'linux' && libc === undefined ? detectLibc() : libc
  const targets: Readonly<Record<string, NativeTarget | undefined>> = TARGET_BY_SYSTEM
  return targets[systemLabel(platform, arch, systemLibc ?? null)] ?? null
}

interface Candidate {
  source: string
  /** The absolute path to open; throws the reason this source has nothing to open. */
  locate(): string
}

/** An explicit override is the only candidate, so its failure never falls through (arch 2.3 step 1). */
function searchOrder(io: LoaderIo): Candidate[] {
  const override = io.env.TURBOLLM_CORE_PATH
  if (override) return [{ source: `TURBOLLM_CORE_PATH ${override}`, locate: () => override }]
  const target = nativeTarget(io.platform, io.arch, io.libc)
  if (target === null) return [noTargetFor(io)]
  return installedCandidates(io, target)
}

function installedCandidates(io: LoaderIo, target: NativeTarget): Candidate[] {
  // The naming rule of binaryFileName() in core/scripts/targets.mjs (an .mjs this bundle does not import).
  const fileName = `turbollm-core.${target}.node`
  const packageName = `@turbollm/core-${target}`
  const candidates = [
    fileCandidate(io, 'bundled', join(io.bundleDir, 'native', fileName)),
    { source: `package ${packageName}`, locate: () => io.resolvePackage(packageName) },
  ]
  if (io.sourceMode) {
    const sourceBuild = join(io.bundleDir, '..', '..', 'core', 'bindings', 'node', fileName)
    candidates.push(fileCandidate(io, 'source build', sourceBuild))
  }
  return candidates
}

function fileCandidate(io: LoaderIo, kind: string, path: string): Candidate {
  return {
    source: `${kind} ${path}`,
    locate: () => {
      if (!io.exists(path)) throw new Error('not found')
      return path
    },
  }
}

function noTargetFor(io: LoaderIo): Candidate {
  return {
    source: 'native target',
    locate: () => {
      throw new Error(`no TurboLLM native core is built for ${ioSystemLabel(io)}`)
    },
  }
}

function acceptVersion(io: LoaderIo, core: CoreBinding, source: string): CoreBinding {
  const coreVersion = core.coreInfo().version
  if (coreVersion === io.packageVersion) return core
  if (io.sourceMode) {
    io.warn(
      `TurboLLM's native core (${source}) is version ${coreVersion} but this source tree is ` +
        `${io.packageVersion}. Rebuild it with npm run build:core.`,
    )
    return core
  }
  throw new CoreLoadError(
    'core_version_mismatch',
    `TurboLLM ${io.packageVersion} found native core version ${coreVersion} (${source}); the two must match.\n` +
      'Reinstall with `npm install -g turbollm`.',
    [{ source, error: `version ${coreVersion}, expected ${io.packageVersion}` }],
  )
}

function coreUnavailable(io: LoaderIo, attempts: ReadonlyArray<LoadAttempt>): CoreLoadError {
  const message = [
    `TurboLLM's native core is not available for this system (${ioSystemLabel(io)}, Node ${io.nodeVersion}).`,
    `It ships for: ${SUPPORTED_SYSTEMS}.`,
    '- If your system is in that list, the platform package was not installed. Reinstall with',
    '  `npm install -g turbollm` and without --omit=optional or --no-optional.',
    '- Otherwise, please open an issue at https://github.com/mohitsoni48/TurboLLM/issues and include this message.',
    'Tried:',
    ...attempts.map((attempt) => `  ${attempt.source}: ${attempt.error}`),
  ].join('\n')
  return new CoreLoadError('core_unavailable', message, attempts)
}

function ioSystemLabel(io: LoaderIo): string {
  return systemLabel(io.platform, io.arch, io.libc)
}

function systemLabel(platform: NodeJS.Platform, arch: string, libc: Libc | null): string {
  const parts: string[] = [platform, arch]
  if (platform === 'linux' && libc !== null) parts.push(libc)
  return parts.join('-')
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The only place this module reads the process: environment, platform and files (plan T9). */
function realIo(): LoaderIo {
  const bundleDir = dirname(fileURLToPath(import.meta.url))
  return {
    env: { TURBOLLM_CORE_PATH: process.env.TURBOLLM_CORE_PATH },
    platform: process.platform,
    arch: process.arch,
    libc: process.platform === 'linux' ? detectLibc() : null,
    nodeVersion: process.versions.node,
    packageVersion: installedPackageVersion(bundleDir),
    sourceMode: import.meta.url.endsWith('.ts'),
    bundleDir,
    exists: existsSync,
    dlopen: openNativeLibrary,
    resolvePackage: (name) => createRequire(import.meta.url).resolve(name),
    warn: (message) => console.warn(message),
  }
}

function detectLibc(): Libc {
  const report = process.report.getReport() as unknown as { header: { glibcVersionRuntime?: string } }
  return report.header.glibcVersionRuntime ? 'gnu' : 'musl'
}

function openNativeLibrary(path: string): CoreBinding {
  const nativeModule = { exports: {} }
  process.dlopen(nativeModule, path)
  return nativeModule.exports as CoreBinding
}

/**
 * The version of the install that holds this bundle: the nearest package.json above it that has a version. The
 * build's dist/package.json has none and is skipped; the npm package's manifest is named turbollm, the Android app's
 * staged one is not, so the name is not checked. Any failure is the core being unavailable, so the daemon's
 * CoreLoadError handling reports it.
 */
export function installedPackageVersion(bundleDir: string): string {
  for (let dir = bundleDir; ; dir = dirname(dir)) {
    const version = manifestVersion(join(dir, 'package.json'))
    if (version !== undefined) return version
    if (dirname(dir) === dir) throw versionUnavailable(bundleDir, 'no package.json with a version was found')
  }
}

function manifestVersion(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof version === 'string' ? version : undefined
  } catch (error) {
    throw versionUnavailable(path, reasonOf(error))
  }
}

function versionUnavailable(path: string, reason: string): CoreLoadError {
  const attempt = { source: `package version ${path}`, error: reason }
  return new CoreLoadError(
    'core_unavailable',
    `TurboLLM could not read its own version, which its native core must match (${attempt.source}: ${reason}).\n` +
      'Reinstall with `npm install -g turbollm`.',
    [attempt],
  )
}
