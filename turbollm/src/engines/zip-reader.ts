// Pure-Node zip reader shared by the upload flow (zip-install.ts) and the release flow
// (download.ts's Linux .zip extraction): a central-directory parser with Zip64 support plus
// CRC-checked member inflation, with no dependency on anything else in this package. It must
// stay a leaf — download.ts imports it, and zip-install.ts reaches download.ts through
// scan.ts, so any relative import here would close an import cycle (import-cycles.test.ts).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import * as nodeZlib from 'node:zlib'

/** Central-directory-declared uncompressed-size guards (zip-bomb class). Checked BEFORE any
 *  inflate, and the inflate itself is capped at the declared size, so an under-declaring
 *  member can't get its bytes allocated first. */
const MAX_ENTRY_UNCOMPRESSED = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024
const MAX_ENTRIES = 10_000

/** The total cap again, over the bytes an extractor will actually WRITE (pass the regular
 *  members it writes plus, once per symlink member, the file it is copied from): a link
 *  declares only its link text but is written as a full copy of its target, so the declared
 *  sum readZipEntries checks does not bound the output. Run before any inflate. */
export function assertWithinTotalCap(written: ZipEntry[]): void {
  let total = 0
  for (const e of written) total += e.size
  if (total > MAX_TOTAL_UNCOMPRESSED) throw new ZipError('zip_too_large', 'Archive expands past the total uncompressed-size cap.')
}

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

/** What the file selector needs to know about any archive member — a zip central-directory
 *  entry or a file found by walking an extracted tar.gz. `symlink` members carry link text, not
 *  content. */
export interface ArchiveMember {
  name: string // archive path, forward slashes
  isDir: boolean
  symlink: boolean
}

/** One central-directory member. `dataOffset` is the absolute offset of the compressed
 *  bytes, resolved through the LOCAL header (whose name/extra lengths may differ from the
 *  central directory's — reading them from the CD instead mislocates the data). `symlink`
 *  is set for Unix S_IFLNK members (`zip -y`): their bytes are the link TARGET path, not
 *  file content. */
export interface ZipEntry extends ArchiveMember {
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

/** Decompress and verify ONE member — bomb guard (inflate capped at the declared size),
 *  declared-size match, CRC-32. Shared by file extraction and symlink-target resolution. */
export function inflateEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compSize)
  let data: Buffer
  try {
    data = entry.method === 8 ? nodeZlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : raw
  } catch (e) {
    throw inflateFailure(entry, e)
  }
  return verifiedMember(entry, data)
}

const inflateRawAsync = promisify(nodeZlib.inflateRaw)

/** inflateEntry with the inflate on libuv's thread pool, for whole-archive extraction: a
 *  release zip can expand to gigabytes, and the sync inflate would freeze the daemon's event
 *  loop (UI polling, SSE, the gateway's token stream) for all of it. Same guards. */
async function inflateEntryAsync(buf: Buffer, entry: ZipEntry): Promise<Buffer> {
  const raw = buf.subarray(entry.dataOffset, entry.dataOffset + entry.compSize)
  let data: Buffer
  try {
    data = entry.method === 8 ? await inflateRawAsync(raw, { maxOutputLength: Math.max(1, entry.size) }) : raw
  } catch (e) {
    throw inflateFailure(entry, e)
  }
  return verifiedMember(entry, data)
}

function inflateFailure(entry: ZipEntry, e: unknown): ZipError {
  if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
    return new ZipError('zip_too_large', `"${entry.name}" expands past its declared size.`)
  return new ZipError('bad_zip', `"${entry.name}" could not be decompressed — the archive is corrupt.`)
}

function verifiedMember(entry: ZipEntry, data: Buffer): Buffer {
  if (data.length !== entry.size) throw new ZipError('bad_zip', `"${entry.name}" does not match its declared size.`)
  if (crc32(data) !== entry.crc32) throw new ZipError('zip_crc_mismatch', `"${entry.name}" failed its CRC-32 check — the archive is corrupt.`)
  return data
}

/** Written into every dir the upload flow creates; see zip-install.ts. Defined in this leaf so
 *  the extractors can refuse to carry one in from an archive. */
export const ZIP_BUILD_MARKER = '.turbollm-zip-install'

/** Written last into a staged release install; the only proof of release provenance. */
export const RELEASE_INSTALL_MARKER = '.turbollm-release-install'

/** True for a member whose basename is one of this app's own install markers. An archive or
 *  scanned folder must never supply one: the marker is trusted as proof of how a dir was made. */
export function isInstallMarkerName(memberName: string): boolean {
  // Case-insensitive: on NTFS and default APFS '.TurboLLM-Release-Install' IS the marker file.
  const base = posix.basename(memberName.replaceAll('\\', '/')).toLowerCase()
  return base === ZIP_BUILD_MARKER || base === RELEASE_INSTALL_MARKER
}

const MAX_LINK_CHAIN = 8

/** Extract EVERY file member of a zip into destDir (the Linux/Android .zip extractor: GNU tar
 *  cannot read zip and unzip is optional there). Directories are created; a symlink member is
 *  written as a copy of the file its link text names when that file is a member inside destDir
 *  (the way the tar walk dereferences in-root links), and dropped otherwise — never created as
 *  a link, never followed outside the tree. A member whose normalised path would land outside
 *  destDir is refused with ZipError('bad_zip') before anything for it is written. Install
 *  markers are never extracted. Inflation and writes are async, so the daemon keeps serving
 *  meanwhile; the archive itself is still one in-memory buffer (bounded by the size cap). */
export async function extractZipAll(buf: Buffer, destDir: string): Promise<void> {
  const root = resolve(destDir)
  await mkdir(root, { recursive: true })
  const entries = readZipEntries(buf).filter((e) => !isInstallMarkerName(e.name))
  const byPath = new Map(entries.map((e) => [containedPath(root, e.name, e.isDir), e]))
  // Links are resolved first: their copies count toward the cap, checked before any inflate.
  const copies: Array<[string, ZipEntry]> = []
  for (const [target, entry] of byPath) {
    const real = entry.symlink ? resolveLinkedFile(buf, root, byPath, target, entry, 0) : null
    if (real) copies.push([target, real])
  }
  assertWithinTotalCap([...[...byPath.values()].filter((e) => !e.isDir && !e.symlink), ...copies.map(([, real]) => real)])
  for (const [target, entry] of byPath) {
    if (entry.isDir) await mkdir(target, { recursive: true })
    else if (!entry.symlink) await writeMember(target, await inflateEntryAsync(buf, entry))
  }
  for (const [target, real] of copies) await writeMember(target, await inflateEntryAsync(buf, real))
}

async function writeMember(target: string, data: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, data)
}

/** The regular-file member a symlink member ultimately names, or null when the link dangles,
 *  loops, or points outside root. */
function resolveLinkedFile(
  buf: Buffer,
  root: string,
  byPath: Map<string, ZipEntry>,
  linkPath: string,
  link: ZipEntry,
  depth: number,
): ZipEntry | null {
  if (depth > MAX_LINK_CHAIN) return null
  const linkText = inflateEntry(buf, link).toString('utf8')
  const targetPath = resolve(dirname(linkPath), linkText.replaceAll('\\', '/'))
  const insideRoot = !posix.isAbsolute(linkText) && !/^[A-Za-z]:/.test(linkText) && targetPath.startsWith(root + sep)
  const target = insideRoot ? byPath.get(targetPath) : undefined
  if (!target || target.isDir) return null
  return target.symlink ? resolveLinkedFile(buf, root, byPath, targetPath, target, depth + 1) : target
}

/** A DIRECTORY member may resolve to root itself (a no-op): `bsdtar -a -cf x.zip .` writes a
 *  './' entry first. A file member must land strictly inside. */
function containedPath(root: string, memberName: string, isDir: boolean): string {
  const name = posix.normalize(memberName.replaceAll('\\', '/'))
  const escapes = name === '..' || name.startsWith('../') || posix.isAbsolute(name) || /^[A-Za-z]:/.test(name)
  const target = resolve(root, name)
  if (escapes || !(target.startsWith(root + sep) || (isDir && target === root)))
    throw new ZipError('bad_zip', `"${memberName}" would extract outside the destination.`)
  return target
}
