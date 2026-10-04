// In-memory zip fixture builder for tests — local headers + central directory + EOCD, a
// deflate/stored choice per member, and a Zip64 variant whose 32-bit EOCD fields are the
// 0xFFFF/0xFFFFFFFF sentinels. Lets hostile inputs (lying declared sizes, wrong CRCs,
// traversal member names) be crafted precisely instead of depending on any platform's
// `zip` binary.
import { deflateRawSync } from 'node:zlib'
import { crc32 } from '../engines/zip-install'

export interface ZipMember {
  name: string
  data?: Buffer
  method?: number
  /** Overwrite the central-directory size (declared, not actual) — the lying-directory
   *  fixtures for size-cap and size-mismatch guards. */
  lieSize?: number
  /** Overwrite the CRC — the corrupt-archive fixture. */
  crc?: number
  /** A Unix symlink member (`zip -y`): sets the Unix creator + S_IFLNK external attributes;
   *  the data becomes the link TARGET path. */
  symlink?: boolean
  /** Set the encrypted general-purpose flag bit — the password-protected fixture. */
  encrypted?: boolean
}

export function buildZipArchive(members: ZipMember[], opts: { zip64?: boolean } = {}): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const m of members) {
    const data = m.data ?? Buffer.from(`content of ${m.name}`)
    const method = m.method ?? 8
    const comp = method === 8 ? deflateRawSync(data) : data
    const size = m.lieSize ?? data.length
    const crc = m.crc ?? crc32(data)
    const nameBuf = Buffer.from(m.name, 'latin1')

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(m.encrypted ? 0x0801 : 0x0800, 6) // utf-8 names (+ encrypted flag)
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(0, 10) // mtime
    lfh.writeUInt16LE(0x21, 12) // mdate
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(size, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    chunks.push(lfh, nameBuf, comp)

    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(m.symlink ? (3 << 8) | 20 : 20, 4) // version made by: 3 = Unix
    cdh.writeUInt16LE(20, 6)
    cdh.writeUInt16LE(m.encrypted ? 0x0801 : 0x0800, 8)
    cdh.writeUInt16LE(method, 10)
    cdh.writeUInt16LE(0, 12)
    cdh.writeUInt16LE(0x21, 14)
    cdh.writeUInt32LE(crc, 16)
    cdh.writeUInt32LE(comp.length, 20)
    cdh.writeUInt32LE(size, 24)
    cdh.writeUInt16LE(nameBuf.length, 28)
    cdh.writeUInt16LE(0, 30)
    cdh.writeUInt16LE(0, 32)
    cdh.writeUInt16LE(0, 34)
    cdh.writeUInt16LE(0, 36)
    cdh.writeUInt32LE(m.symlink ? (0o120777 << 16) >>> 0 : 0, 38) // Unix mode: S_IFLNK
    cdh.writeUInt32LE(offset, 42)
    central.push(cdh, nameBuf)

    offset += 30 + nameBuf.length + comp.length
  }
  const cdStart = offset
  const cdBuf = Buffer.concat(central)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(members.length, 8)
  eocd.writeUInt16LE(members.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  if (opts.zip64) {
    // Zip64: real values move into the EOCD64 record; the EOCD keeps the sentinels.
    eocd.writeUInt16LE(0xffff, 8)
    eocd.writeUInt16LE(0xffff, 10)
    eocd.writeUInt32LE(0xffffffff, 12)
    eocd.writeUInt32LE(0xffffffff, 16)
    const z64 = Buffer.alloc(56)
    z64.writeUInt32LE(0x06064b50, 0)
    z64.writeBigUInt64LE(44n, 4)
    z64.writeUInt16LE(20, 12)
    z64.writeUInt16LE(20, 14)
    z64.writeUInt32LE(0, 16)
    z64.writeUInt32LE(0, 20)
    z64.writeBigUInt64LE(BigInt(members.length), 24)
    z64.writeBigUInt64LE(BigInt(members.length), 32)
    z64.writeBigUInt64LE(BigInt(cdBuf.length), 40)
    z64.writeBigUInt64LE(BigInt(cdStart), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeUInt32LE(0, 4)
    loc.writeBigUInt64LE(BigInt(cdStart + cdBuf.length), 8)
    loc.writeUInt32LE(1, 16)
    return Buffer.concat([...chunks, cdBuf, z64, loc, eocd])
  }
  return Buffer.concat([...chunks, cdBuf, eocd])
}
