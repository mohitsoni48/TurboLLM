// Custom-engine install from an uploaded .zip — the third Add-engine source, next to
// "choose a folder on disk" (scan.ts) and "build from a git repo" (build-runner.ts). A
// fork's release zip can bury the server binary and its runtime libraries at ANY depth
// (bin/Release/…, per-backend dirs, a nested dist/), and archives made on Windows lose the
// POSIX exec bit, so "unzip it yourself and point the folder scan at it" asks the user to
// do that archaeology by hand. This module searches the archive's central directory
// instead: it picks one server binary (shallowest first), then flattens everything from the
// binary's OWN directory plus this platform's shared libraries from anywhere else into ONE
// directory under {enginesRoot}/build/<slug>/ — the same root the 1-click build uses, so
// DELETE /engines/:id?purge=1 (engineInstallDir → sourceBuildDirOf) removes the files with
// no new delete path, and isManagedBuild never auto-cleans it. The flat layout is also what
// makes the result launchable everywhere: Windows' loader searches the exe's own directory,
// and probe.ts/manager.ts already point the library path at dirname(bin) on every
// non-Windows platform — LD_LIBRARY_PATH on Linux and Android/Termux (which ships
// llama.cpp builds with no RPATH at all, GitHub #52 / ADR-390/391) and DYLD_LIBRARY_PATH
// on macOS, where dyld ignores LD_LIBRARY_PATH.
//
// The install is transactional: extraction and the probe happen in a hidden temporary
// sibling of the target dir, which is swapped in only after the probe succeeded — a failed
// or wrong-platform re-upload can never destroy the working install it was meant to
// replace. A marker file inside the dir records that this flow created it (routes.ts
// refuses to overwrite a build folder any registered engine or remembered custom source
// still claims unless it carries one) and lets the GC sweep recognize orphans.
//
// Extraction is dependency-free pure Node (zlib raw-inflate over a central-directory parser
// with Zip64 support): the download pipeline's PowerShell/tar split doesn't apply here — a
// user zip arrives as .zip on every platform, and GNU tar (plain Linux, Termux) cannot read
// zip, while `unzip` is an optional package there.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { asDirName, isEngineInBuildDir } from './build-runner'
import { serverBinNameFor } from './download'
import { suggestEngineName } from './scan'
import { probe, type ProbeResult } from './probe'
import { inflateEntry, isInstallMarkerName, readZipEntries, RELEASE_INSTALL_MARKER, ZIP_BUILD_MARKER, ZipError, type ArchiveMember, type ZipEntry } from './zip-reader'

export { crc32, extractZipAll, inflateEntry, readZipEntries, RELEASE_INSTALL_MARKER, ZIP_BUILD_MARKER, ZipError } from './zip-reader'
export type { ArchiveMember, ZipEntry, ZipErrorCode } from './zip-reader'

/** Hard cap on an uploaded zip's compressed bytes. Enforced three times: while the body
 *  streams in (hono/body-limit, routes.ts), on the parsed File, and here on the buffer —
 *  so a lying Content-Length or a chunked request can't buffer an unbounded blob. Real
 *  llama.cpp builds land well under this even with CUDA runtimes. */
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024

/** A zip install newer than this survives the GC sweep — another tab may still be sitting
 *  on its confirm step. */
const ZIP_GC_GRACE_MS = 24 * 60 * 60 * 1000

/** A shared-library member for the given platform (the "libs it needs" half of the search):
 *  .dll beside the exe on Windows, .dylib on macOS, and .so / .so.N versioned sonames on
 *  Linux and Android/Termux (libggml.so, libcudart.so.12). */
export function isPlatformLib(fileName: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /\.dll$/i.test(fileName)
  if (platform === 'darwin') return /\.dylib$/i.test(fileName)
  return /\.so(\.\d+)*$/i.test(fileName)
}

function dirOf(name: string): string {
  const parts = name.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/')
}

function baseOf(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name
}

function depthOf(name: string): number {
  return name.replace(/\\/g, '/').split('/').filter(Boolean).length - 1
}

/** Number of leading path segments two archive directories share ("a/b" vs "a/c" → 1). */
function sharedPrefixLen(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return n
}

/** A basename that can never be written as a file: path steps, empty, or containing
 *  control characters (a hostile archive member like "con", NUL, or "\n" would otherwise
 *  make writeFileSync throw mid-extraction). */
function unwritableBase(base: string): boolean {
  return base === '' || base === '.' || base === '..' || /[\x00-\x1f]/.test(base)
}

export interface InstallSelection<T extends ArchiveMember> {
  /** The chosen llama-server member (shallowest, then archive order — deterministic for
   *  multi-variant zips that ship one binary per backend folder). */
  binary: T
  /** Members to extract, keyed by lowercased destination basename (case-insensitive
   *  dedupe: the binary's own directory always wins); the written filename is the entry's
   *  own basename. Flattening is what makes the result loadable — see the module header. */
  files: Map<string, T>
}

export type ZipSelection = InstallSelection<ZipEntry>

/** PURE: choose what to extract. (1) every member of the binary's own directory rides
 *  along — that directory is the build's real unit (runtime DLLs/so's, plus resource files
 *  like ggml-metal.metal that must sit next to the binary); (2) shared libraries found at
 *  ANY other depth are added when their basename isn't already taken AND they belong to
 *  the chosen binary rather than a rival: an archive that ships one build per backend
 *  folder (cuda/ + vulkan/, each with its own llama-server) must not contribute the rival
 *  variant's libraries, because ggml's dynamic backend loader loads every ggml-<backend>*
 *  it finds beside the binary. Ownership is measured as the longest shared path prefix
 *  with the chosen binary's directory versus each rival's, so a bin/ + lib/ split still
 *  assembles while sibling variants are skipped. Returns null when the archive holds no
 *  server binary. */
export function pickInstallFiles<T extends ArchiveMember>(
  entries: T[],
  platform: NodeJS.Platform = process.platform,
  // The name to look for follows the platform being SELECTED FOR, not the host's: callers pass
  // a platform to answer "what would run there", and defaulting the name to the machine's own
  // (`llama-server.exe` on Windows) made `pickInstallFiles(entries, 'linux')` search a Linux
  // archive for a Windows binary and find nothing.
  binName = serverBinNameFor(platform),
): InstallSelection<T> | null {
  const binKey = binName.toLowerCase()
  const candidates = entries.filter((e) => !e.isDir && baseOf(e.name).toLowerCase() === binKey)
  if (candidates.length === 0) return null
  const binary = [...candidates].sort(
    (a, b) => depthOf(a.name) - depthOf(b.name) || entries.indexOf(a) - entries.indexOf(b),
  )[0]!
  const binDir = dirOf(binary.name)
  const rivalDirs = new Set(candidates.filter((e) => e !== binary && dirOf(e.name) !== binDir).map((e) => dirOf(e.name)))
  const nearerThanAnyRival = (name: string): boolean => {
    const d = dirOf(name)
    const mine = sharedPrefixLen(d, binDir)
    return [...rivalDirs].every((r) => mine >= sharedPrefixLen(d, r))
  }

  const files = new Map<string, T>()
  const add = (e: T) => {
    const base = baseOf(e.name)
    if (unwritableBase(base) || isInstallMarkerName(base)) return
    const key = base.toLowerCase()
    if (!files.has(key)) files.set(key, e)
  }
  for (const e of entries) if (!e.isDir && dirOf(e.name) === binDir) add(e)
  for (const e of entries)
    if (!e.isDir && dirOf(e.name) !== binDir && isPlatformLib(baseOf(e.name), platform) && nearerThanAnyRival(e.name)) add(e)
  return { binary, files }
}

export const pickZipFiles = (entries: ZipEntry[], platform?: NodeJS.Platform, binName?: string): ZipSelection | null =>
  pickInstallFiles(entries, platform, binName)

/** The install dir slug under {enginesRoot}/build/ — the uploaded zip's filename stem,
 *  collapsed to a safe single path step by build-runner's asDirName (the one path-safety
 *  rule every other build dir follows), with this flow's own fallback for a stem that
 *  reduces to a path step ("..", "." — or empty). */
export function zipBuildDirName(fileName: string): string {
  return asDirName(basename(fileName.trim()).replace(/\.zip$/i, ''), 'zip-build')
}

/** Resolve a symlink member to the real member its (validated) link text points at within
 *  the flat selection, following chains and refusing cycles. Null when the selection
 *  doesn't carry the target. */
function followLink(buf: Buffer, selection: ZipSelection, link: ZipEntry, depth: number): ZipEntry | null {
  if (depth > 8) return null
  const target = selection.files.get(baseOf(inflateEntry(buf, link).toString('utf8')).toLowerCase())
  if (!target || target === link) return null
  return target.symlink ? followLink(buf, selection, target, depth + 1) : target
}

/** List the files of an already-extracted archive tree as members, with posix-relative names,
 *  so a tar.gz extraction can go through the same selector as a zip. `tar` recreates the
 *  archive's symlinks (macOS dylib chains: libllama.0.dylib -> libllama.0.4.7.dylib); one that
 *  resolves to a regular file INSIDE the tree is reported as an ordinary member, because the
 *  flat copy dereferences it exactly as the zip path does for `zip -y` links. One that dangles
 *  or resolves outside the tree is dropped: a hostile tarball must not get a file from
 *  elsewhere on the disk copied into an engine dir. */
export function walkArchiveMembers(root: string): ArchiveMember[] {
  const realRoot = realpathSync(root)
  const members: ArchiveMember[] = []
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const name = prefix + entry.name
      if (entry.isDirectory()) visit(full, name + '/')
      else if (entry.isFile() || isLinkToFileInside(full, realRoot)) members.push({ name, isDir: false, symlink: false })
    }
  }
  visit(root, '')
  return members
}

function isLinkToFileInside(path: string, realRoot: string): boolean {
  try {
    const target = realpathSync(path)
    return target.startsWith(realRoot + sep) && statSync(target).isFile()
  } catch {
    return false
  }
}

/** Extract a selection into destDir and return the server binary's path. Every member is
 *  CRC-32-verified before it is written, so a corrupt archive leaves nothing behind (the
 *  caller GCs destDir on any throw). On POSIX the binary gets the exec bit — zips created
 *  on Windows carry no mode bits, and execve() would fail with EACCES otherwise.
 *
 *  `zip -y` archives store versioned-library chains as symlink members; the flat layout
 *  puts every member in ONE directory, so a link resolves to its target's basename within
 *  the selection and is written out as a COPY of the target's bytes — the loader sees real
 *  content instead of a text file holding the link path, and no symlink privilege is
 *  needed on Windows. A link whose target the selection doesn't carry is skipped: nothing
 *  honest can be written, and a genuinely needed library then fails the probe by name. */
export function extractZipFiles(buf: Buffer, selection: ZipSelection, destDir: string): string {
  mkdirSync(destDir, { recursive: true })
  for (const entry of selection.files.values()) {
    if (entry.symlink) continue
    writeFileSync(join(destDir, baseOf(entry.name)), inflateEntry(buf, entry))
  }
  for (const entry of selection.files.values()) {
    if (!entry.symlink) continue
    const target = followLink(buf, selection, entry, 0)
    if (target) writeFileSync(join(destDir, baseOf(entry.name)), inflateEntry(buf, target))
  }
  const binPath = join(destDir, baseOf(selection.binary.name))
  if (process.platform !== 'win32') {
    try {
      chmodSync(binPath, 0o755)
    } catch {
      // best-effort — some filesystems reject chmod; the probe surfaces a real error then
    }
  }
  return binPath
}

/** Non-blocking install caveat carried to the dialog's confirm step, mirroring POST
 *  /engines' `warning: 'no_version'`: something the user should know that doesn't stop
 *  the install. */
export interface ZipInstallWarning {
  code: 'missing_cudart'
  message: string
}

/** Official llama.cpp Windows CUDA zips ship the CUDA backend (ggml-cuda.dll) but NOT the
 *  CUDA runtime, which lives in the separate cudart-…-x64.zip the managed downloader
 *  fetches as a second asset (download.ts's hasCudartRuntime). An upload like that probes
 *  and registers fine, then quietly runs on the CPU on any machine without a CUDA toolkit
 *  — surfaced as a warning instead. Null when there is nothing to warn about. */
export function missingCudartWarning(fileNames: string[], platform: NodeJS.Platform = process.platform): ZipInstallWarning | null {
  if (platform !== 'win32') return null
  if (!fileNames.some((n) => /^ggml-cuda.*\.dll$/i.test(n))) return null
  if (fileNames.some((n) => /^cudart64_\d+\.dll$/i.test(n))) return null
  return {
    code: 'missing_cudart',
    message:
      'This CUDA build does not bundle the CUDA runtime (cudart64_*.dll) — llama.cpp ships it as a separate cudart zip. ' +
      'Without it, or a CUDA toolkit installed on this machine, the engine will fall back to the CPU.',
  }
}

/** Remove archive installs that nothing owns anymore: a marker says a flow created the dir,
 *  but no registered engine and no remembered custom source points into it — the Add-engine
 *  dialog was closed (or its Add failed) between extraction and registration, leaving files
 *  that only Delete-on-a-registered-engine would ever clean. Also sweeps hidden `.<slug>-<id>.stage`
 *  staging dirs a crashed release install left behind; those never hold a registered binary
 *  (it only becomes visible after the final rename), so age alone decides. Runs at the start of
 *  every upload; a dir newer than the grace period survives, since another tab may still be
 *  sitting on its confirm step. */
export function gcAbandonedZipInstalls(
  enginesRoot: string,
  claimedBinPaths: string[],
  opts: { maxAgeMs?: number; markers?: string[] } = {},
): void {
  const buildRoot = join(enginesRoot, 'build')
  const maxAgeMs = opts.maxAgeMs ?? ZIP_GC_GRACE_MS
  const markers = opts.markers ?? [ZIP_BUILD_MARKER, RELEASE_INSTALL_MARKER]
  try {
    for (const d of readdirSync(buildRoot)) {
      const dir = join(buildRoot, d)
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
      if (!isStagingDir(d) && !isMarkedUnclaimed(dir, markers, claimedBinPaths)) continue
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    /* unreadable build root or a dir vanished mid-sweep — the next upload tries again */
  }
}

function isStagingDir(dirName: string): boolean {
  return dirName.startsWith('.') && dirName.endsWith('.stage')
}

function isMarkedUnclaimed(dir: string, markers: string[], claimedBinPaths: string[]): boolean {
  if (!markers.some((marker) => existsSync(join(dir, marker)))) return false
  return !claimedBinPaths.some((p) => isEngineInBuildDir(p, dir))
}

export type ZipScanResult =
  | { found: false }
  | { found: true; binPath: string; version: string; capabilities: ProbeResult['capabilities']; suggestedName: string; warning?: ZipInstallWarning }

/** Thrown when installZipEngine's blockSwap guard refuses the final swap — typically the
 *  engine whose files the upload replaces was started while the archive was still
 *  extracting. The prior install is left untouched. */
export class SwapBlockedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'SwapBlockedError'
  }
}

/** Probe a staged install, then swap it in as build/<slug>. The probe runs against the TMP
 *  path, and the swap happens only after it succeeded, so a failed probe never touches the
 *  prior install. `blockSwap` re-runs right before the replacement. Callers own removing
 *  `tmpDir` (a no-op once it was renamed into place). */
export async function promoteProbedInstall(o: {
  enginesRoot: string
  slug: string
  tmpDir: string
  binFileName: string
  probeFn: (bin: string) => Promise<ProbeResult>
  blockSwap?: () => string | null
}): Promise<{ finalBin: string; probe: ProbeResult }> {
  const { enginesRoot, slug, tmpDir } = o
  const destDir = join(enginesRoot, 'build', slug)
  const pr = await o.probeFn(join(tmpDir, o.binFileName))
  const blocked = o.blockSwap?.()
  if (blocked) throw new SwapBlockedError(blocked)
  // Never leave a moment where neither install exists: park the old dir, move the new one
  // in, and delete the old one only once that worked — moving it back if the rename failed
  // (on Windows a just-probed .exe can stay locked by antivirus for a moment: EPERM/EBUSY).
  const parked = existsSync(destDir) ? join(enginesRoot, 'build', `.${slug}-${randomUUID().slice(0, 8)}.old`) : null
  if (parked) renameSync(destDir, parked)
  try {
    renameSync(tmpDir, destDir)
  } catch (e) {
    if (parked) renameSync(parked, destDir)
    throw e
  }
  if (parked) {
    try {
      rmSync(parked, { recursive: true, force: true })
    } catch {
      /* best effort — the new install is already in place; the GC sweep retries */
    }
  }
  return { finalBin: join(destDir, o.binFileName), probe: pr }
}

/** Upload → install → probe, as a swap. The archive is extracted into a hidden temporary
 *  sibling of the target dir and PROBED there; only a successful probe promotes it by
 *  replacing the target dir with one rename, so a failed re-upload (wrong platform, a
 *  truncated download, a CRC error, a missing library) removes only the temporary dir and
 *  never the working install a registered engine points at. `blockSwap` re-runs right
 *  before the replacement, closing the window where an engine could be started mid-upload
 *  onto the files being replaced. The binary is probed under its temporary path, but the
 *  result reports (and suggestEngineName sees) the FINAL path, which is where the engine
 *  will actually run from. Returns the same shape as POST /engines/scan so the Add-engine
 *  dialog's confirm step works unchanged; registration still goes through POST /engines
 *  (which records the custom-source identity). */
export async function installZipEngine(
  enginesRoot: string,
  zipFileName: string,
  bytes: Buffer,
  opts: { probeFn?: (bin: string) => Promise<ProbeResult>; blockSwap?: () => string | null } = {},
): Promise<ZipScanResult> {
  if (bytes.length > MAX_ZIP_BYTES)
    throw new ZipError('zip_too_large', `Engine zips are capped at ${MAX_ZIP_BYTES / (1024 * 1024 * 1024)} GiB.`)
  const entries = readZipEntries(bytes)
  const selection = pickZipFiles(entries)
  if (!selection) return { found: false }
  const slug = zipBuildDirName(zipFileName)
  const tmpDir = join(enginesRoot, 'build', `.${slug}-${randomUUID().slice(0, 8)}.tmp`)
  try {
    const binPath = extractZipFiles(bytes, selection, tmpDir)
    writeFileSync(join(tmpDir, ZIP_BUILD_MARKER), `${zipFileName}\n${new Date().toISOString()}\n`)
    const { finalBin, probe: pr } = await promoteProbedInstall({
      enginesRoot,
      slug,
      tmpDir,
      binFileName: basename(binPath),
      probeFn: opts.probeFn ?? probe,
      blockSwap: opts.blockSwap,
    })
    const warning = missingCudartWarning([...selection.files.keys()])
    return {
      found: true,
      binPath: finalBin,
      version: pr.version,
      capabilities: pr.capabilities,
      suggestedName: suggestEngineName(finalBin, pr.version),
      ...(warning ? { warning } : {}),
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true }) // no-op once renamed into place
  }
}

/** True inside the packaged Android app (nodejs-mobile), where W^X hardening forbids
 *  execve() of anything outside the APK's nativeLibraryDir — an uploaded zip would extract
 *  fine but its binary could never run. Termux (also process.platform 'android', but
 *  without MainActivity.kt's env var) can exec from its home, so uploads stay allowed
 *  there. Mirrors sysinfo's bundledEnginesOnly. */
export function packagedAndroidApp(platform: NodeJS.Platform = process.platform, env: { TURBOLLM_ANDROID_NATIVE_LIB_DIR?: string } = process.env): boolean {
  return platform === 'android' && !!env.TURBOLLM_ANDROID_NATIVE_LIB_DIR
}
