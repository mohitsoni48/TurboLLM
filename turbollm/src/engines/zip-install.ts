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
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import * as nodeZlib from 'node:zlib'
import { asDirName, isEngineInBuildDir } from './build-runner'
import { serverBinName, suggestEngineName } from './scan'
import { probe, type ProbeResult } from './probe'

/** Hard cap on an uploaded zip's compressed bytes. Enforced three times: while the body
 *  streams in (hono/body-limit, routes.ts), on the parsed File, and here on the buffer —
 *  so a lying Content-Length or a chunked request can't buffer an unbounded blob. Real
 *  llama.cpp builds land well under this even with CUDA runtimes. */
export const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024

/** Central-directory-declared uncompressed-size guards (zip-bomb class). Checked BEFORE any
 *  inflate, and the inflate itself is capped at the declared size, so an under-declaring
 *  member can't get its bytes allocated first. */
const MAX_ENTRY_UNCOMPRESSED = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024
const MAX_ENTRIES = 10_000

/** Written into every dir this flow creates: routes.ts only replaces an OCCUPIED build
 *  folder that carries it (it is the proof the folder is this flow's own prior install,
 *  not a 1-click git build whose directory name happens to collide), and the GC sweep only
 *  removes unclaimed dirs that do. Nothing loads it. */
export const ZIP_BUILD_MARKER = '.turbollm-zip-install'

/** A zip install newer than this survives the GC sweep — another tab may still be sitting
 *  on its confirm step. */
const ZIP_GC_GRACE_MS = 24 * 60 * 60 * 1000

export type ZipErrorCode =
  | 'bad_zip' // not a zip archive, or a structurally corrupt one
  | 'encrypted_zip'
  | 'unsupported_compression'
  | 'zip_too_large' // declared or actual sizes over the caps above
  | 'zip_crc_mismatch' // a member failed its CRC-32 check

export class ZipError extends Error {
  constructor(
    public code: ZipErrorCode,
    msg: string,
  ) {
    super(msg)
    this.name = 'ZipError'
  }
}

/** One central-directory member. `dataOffset` is the absolute offset of the compressed
 *  bytes, resolved through the LOCAL header (whose name/extra lengths may differ from the
 *  central directory's — reading them from the CD instead mislocates the data). `symlink`
 *  is set for Unix S_IFLNK members (`zip -y`): their bytes are the link TARGET path, not
 *  file content. */
export interface ZipEntry {
  name: string // archive path, forward slashes
  isDir: boolean
  symlink: boolean
  crc32: number
  method: number // 0 = stored, 8 = deflate
  compSize: number
  size: number // uncompressed
  dataOffset: number
}

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD64_SIG = 0x06064b50
const CD_ENTRY_SIG = 0x02014b50
const LOCAL_HEADER_SIG = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const UTF8_NAME_FLAG = 0x0800
const ENCRYPTED_FLAG = 0x0001

/** Parse every member out of a zip's central directory. Zip64 is honored when the EOCD
 *  overflows (0xFFFFFFFF offsets / 0xFFFF counts). Throws ZipError('bad_zip' |
 *  'encrypted_zip' | 'unsupported_compression' | 'zip_too_large') on anything malformed —
 *  never returns a half-parsed list. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (buf.length < 22 || eocd === null) throw new ZipError('bad_zip', 'This file is not a zip archive.')
  let entryCount = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  // Zip64: the EOCD's 32-bit fields saturate; the real values live in the EOCD64 record a
  // back-reference (the locator) points at.
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20
    if (locator < 0 || buf.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG)
      throw new ZipError('bad_zip', 'Zip64 archive is missing its EOCD64 locator.')
    const eocd64 = readU64asNumber(buf, locator + 8)
    if (eocd64 + 56 > buf.length || buf.readUInt32LE(eocd64) !== EOCD64_SIG)
      throw new ZipError('bad_zip', 'Zip64 archive has a corrupt EOCD64 record.')
    entryCount = readU64asNumber(buf, eocd64 + 32)
    cdOffset = readU64asNumber(buf, eocd64 + 48)
  }
  if (entryCount > MAX_ENTRIES) throw new ZipError('bad_zip', `Archive lists ${entryCount} members (cap ${MAX_ENTRIES}).`)

  const entries: ZipEntry[] = []
  let p = cdOffset
  let totalUncompressed = 0
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_ENTRY_SIG)
      throw new ZipError('bad_zip', 'Central directory is truncated or corrupt.')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const versionMadeBy = buf.readUInt16LE(p + 4)
    const externalAttr = buf.readUInt32LE(p + 38)
    const crc32 = buf.readUInt32LE(p + 16)
    let compSize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    let localOffset = buf.readUInt32LE(p + 42)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const nameEnd = p + 46 + nameLen
    if (nameEnd + extraLen + commentLen > buf.length) throw new ZipError('bad_zip', 'Central directory is truncated or corrupt.')
    // Zip64 extra field: the 64-bit replacements appear in a fixed order, each ONLY for the
    // fields whose 32-bit original is the 0xFFFFFFFF sentinel.
    const extraEnd = nameEnd + extraLen
    let q = nameEnd
    while (q + 4 <= extraEnd) {
      const id = buf.readUInt16LE(q)
      const dataSize = buf.readUInt16LE(q + 2)
      const fieldEnd = q + 4 + dataSize
      if (fieldEnd > extraEnd) break
      if (id === ZIP64_EXTRA_ID) {
        let r = q + 4
        if (size === 0xffffffff) { size = readU64asNumber(buf, r); r += 8 }
        if (compSize === 0xffffffff) { compSize = readU64asNumber(buf, r); r += 8 }
        if (localOffset === 0xffffffff) localOffset = readU64asNumber(buf, r)
      }
      q = fieldEnd
    }
    const name = buf.toString(flags & UTF8_NAME_FLAG ? 'utf8' : 'latin1', nameEnd - nameLen, nameEnd)
    if (flags & ENCRYPTED_FLAG)
      throw new ZipError('encrypted_zip', `"${name}" is encrypted — password-protected archives aren't supported. Re-zip it without a password.`)
    if (method !== 0 && method !== 8)
      throw new ZipError('unsupported_compression', `"${name}" uses compression method ${method} (only stored and deflate are supported).`)
    if (size > MAX_ENTRY_UNCOMPRESSED) throw new ZipError('zip_too_large', `"${name}" expands past the ${MAX_ENTRY_UNCOMPRESSED / 2 ** 30} GiB per-member cap.`)
    totalUncompressed += size
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new ZipError('zip_too_large', 'Archive expands past the total uncompressed-size cap.')

    // Resolve the data offset through the local header, whose own name/extra lengths are
    // authoritative for where the bytes start.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG)
      throw new ZipError('bad_zip', `"${name}" has a corrupt local header.`)
    const dataOffset = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataOffset + compSize > buf.length) throw new ZipError('bad_zip', `"${name}" data runs past the end of the archive.`)

    // Unix-created archives store the member's mode in the high 16 bits of externalAttr;
    // versionMadeBy's high byte 3 is the Unix creator stamp. `zip -y` keeps versioned
    // library chains (libggml.so → libggml.so.0.0.1) as such members.
    const symlink = (versionMadeBy >> 8) === 3 && ((externalAttr >>> 16) & 0o170000) === 0o120000
    entries.push({ name, isDir: name.endsWith('/'), symlink, crc32, method, compSize, size, dataOffset })
    p = nameEnd + extraLen + commentLen
  }
  return entries
}

/** Locate the End-Of-Central-Directory record — scan backwards since a zip may carry up to
 *  64 KiB of trailing comment (or appended junk). Null when absent. */
function findEocd(buf: Buffer): number | null {
  const start = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return null
}

function readU64asNumber(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off)
  if (v > Number.MAX_SAFE_INTEGER) throw new ZipError('bad_zip', 'Zip64 field exceeds a safe integer.')
  return Number(v)
}

// CRC-32 (IEEE 802.3, poly 0xEDB88320) — zlib's raw-inflate carries no CRC, so the archive's
// own per-member CRC-32 is the only corruption signal; this computes it for comparison.
// Node's native zlib.crc32 (≥ 20.15 / 22.2) is roughly 9x faster than the table loop, but
// the Android bundle's Node 18 has no such export — a NAMED import would fail at module
// load there, so it is read off the namespace (undefined on 18) with the loop as fallback.
const nativeCrc32: ((data: Buffer) => number) | undefined = (nodeZlib as { crc32?: (data: Buffer) => number }).crc32
let crcTable: Uint32Array | null = null
export function crc32(data: Buffer): number {
  if (nativeCrc32) return nativeCrc32(data) >>> 0
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

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

export interface ZipSelection {
  /** The chosen llama-server member (shallowest, then archive order — deterministic for
   *  multi-variant zips that ship one binary per backend folder). */
  binary: ZipEntry
  /** Members to extract, keyed by lowercased destination basename (case-insensitive
   *  dedupe: the binary's own directory always wins); the written filename is the entry's
   *  own basename. Flattening is what makes the result loadable — see the module header. */
  files: Map<string, ZipEntry>
}

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
export function pickZipFiles(entries: ZipEntry[], platform: NodeJS.Platform = process.platform, binName = serverBinName): ZipSelection | null {
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

  const files = new Map<string, ZipEntry>()
  const add = (e: ZipEntry) => {
    const base = baseOf(e.name)
    if (unwritableBase(base)) return
    const key = base.toLowerCase()
    if (!files.has(key)) files.set(key, e)
  }
  for (const e of entries) if (!e.isDir && dirOf(e.name) === binDir) add(e)
  for (const e of entries)
    if (!e.isDir && dirOf(e.name) !== binDir && isPlatformLib(baseOf(e.name), platform) && nearerThanAnyRival(e.name)) add(e)
  return { binary, files }
}

/** The install dir slug under {enginesRoot}/build/ — the uploaded zip's filename stem,
 *  collapsed to a safe single path step by build-runner's asDirName (the one path-safety
 *  rule every other build dir follows), with this flow's own fallback for a stem that
 *  reduces to a path step ("..", "." — or empty). */
export function zipBuildDirName(fileName: string): string {
  return asDirName(basename(fileName.trim()).replace(/\.zip$/i, ''), 'zip-build')
}

/** Decompress and verify ONE member — bomb guard (inflate capped at the declared size),
 *  declared-size match, CRC-32. Shared by file extraction and symlink-target resolution. */
function inflateEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compSize)
  let data: Buffer
  try {
    data = entry.method === 8 ? nodeZlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : raw
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
      throw new ZipError('zip_too_large', `"${entry.name}" expands past its declared size.`)
    throw new ZipError('bad_zip', `"${entry.name}" could not be decompressed — the archive is corrupt.`)
  }
  if (data.length !== entry.size) throw new ZipError('bad_zip', `"${entry.name}" does not match its declared size.`)
  if (crc32(data) !== entry.crc32) throw new ZipError('zip_crc_mismatch', `"${entry.name}" failed its CRC-32 check — the archive is corrupt.`)
  return data
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

/** Remove zip installs that nothing owns anymore: the marker says this flow created the
 *  dir, but no registered engine and no remembered custom source points into it — the
 *  Add-engine dialog was closed (or its Add failed) between extraction and registration,
 *  leaving files that only Delete-on-a-registered-engine would ever clean. Runs at the
 *  start of every upload; a dir newer than the grace period survives, since another tab
 *  may still be sitting on its confirm step. */
export function gcAbandonedZipInstalls(enginesRoot: string, claimedBinPaths: string[], opts: { maxAgeMs?: number } = {}): void {
  const buildRoot = join(enginesRoot, 'build')
  const maxAgeMs = opts.maxAgeMs ?? ZIP_GC_GRACE_MS
  try {
    for (const d of readdirSync(buildRoot)) {
      const dir = join(buildRoot, d)
      if (!existsSync(dir) || !statSync(dir).isDirectory() || !existsSync(join(dir, ZIP_BUILD_MARKER))) continue
      if (claimedBinPaths.some((p) => isEngineInBuildDir(p, dir))) continue
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    /* unreadable build root or a dir vanished mid-sweep — the next upload tries again */
  }
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
  const destDir = join(enginesRoot, 'build', slug)
  const tmpDir = join(enginesRoot, 'build', `.${slug}-${randomUUID().slice(0, 8)}.tmp`)
  try {
    const binPath = extractZipFiles(bytes, selection, tmpDir)
    writeFileSync(join(tmpDir, ZIP_BUILD_MARKER), `${zipFileName}\n${new Date().toISOString()}\n`)
    const pr = await (opts.probeFn ?? probe)(binPath)
    const blocked = opts.blockSwap?.()
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
    const finalBin = join(destDir, basename(binPath))
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
