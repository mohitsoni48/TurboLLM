// A minimal .litertlm for tests: the real 32-byte prefix, a hand-built section FlatBuffer, and the LlmMetadata and
// ExecutorMetadata protos (models/litertlm.ts reads only these). `kvLens` is [StateBuffer.Type, maximum_sequence_length].

function varint(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}
const pVarint = (field: number, v: number) => [...varint(field * 8), ...varint(v)]
const pBytes = (field: number, b: number[]) => [...varint(field * 8 + 2), ...varint(b.length), ...b]

export function fakeLitertlmBundle(llmMax: number, kvLens: Array<[type: number, len: number]>): Buffer {
  const llm = Buffer.from(pVarint(5, llmMax))
  const states = kvLens.flatMap(([type, n]) =>
    pBytes(2, [...pBytes(1, [...Buffer.from('kv_cache_k_0')]), ...pVarint(6, type), ...pVarint(9, n)]))
  const exec = Buffer.from(pBytes(1, states))
  const hdr = Buffer.alloc(108)
  hdr.writeUInt32LE(12, 0) // root table
  hdr.writeUInt16LE(8, 4); hdr.writeUInt16LE(8, 6); hdr.writeUInt16LE(0, 8); hdr.writeUInt16LE(4, 10) // root vtable
  hdr.writeInt32LE(8, 12); hdr.writeUInt32LE(28 - 16, 16) // root → section_metadata
  hdr.writeUInt16LE(6, 20); hdr.writeUInt16LE(8, 22); hdr.writeUInt16LE(4, 24) // section_metadata vtable
  hdr.writeInt32LE(8, 28); hdr.writeUInt32LE(36 - 32, 32) // → objects vector
  hdr.writeUInt32LE(2, 36); hdr.writeUInt32LE(60 - 40, 40); hdr.writeUInt32LE(84 - 44, 44)
  hdr.writeUInt16LE(12, 48); hdr.writeUInt16LE(24, 50); hdr.writeUInt16LE(0, 52); hdr.writeUInt16LE(4, 54); hdr.writeUInt16LE(12, 56); hdr.writeUInt16LE(20, 58) // object vtable
  hdr.writeInt32LE(60 - 48, 60); hdr.writeBigUInt64LE(256n, 64); hdr.writeBigUInt64LE(BigInt(256 + llm.length), 72); hdr.writeUInt8(5, 80)
  hdr.writeInt32LE(84 - 48, 84); hdr.writeBigUInt64LE(512n, 88); hdr.writeBigUInt64LE(BigInt(512 + exec.length), 96); hdr.writeUInt8(9, 104)
  const file = Buffer.alloc(512 + exec.length)
  file.write('LITERTLM', 0, 'latin1')
  file.writeUInt32LE(1, 8); file.writeUInt32LE(6, 12)
  file.writeBigUInt64LE(BigInt(32 + hdr.length), 24)
  hdr.copy(file, 32)
  llm.copy(file, 256)
  exec.copy(file, 512)
  return file
}


// ── A .litertlm of any sections, for tests that need the header's items ──────────────────────
// The header is a real FlatBuffer (schema/core/litertlm_header_schema.fbs), laid out forward: each table's vtable just
// before it, every child after the field that points to it, which is all models/litertlm.ts's FbTable reads.

class FbWriter {
  readonly b: number[] = []
  get pos(): number { return this.b.length }
  align(n: number): void { while (this.b.length % n !== 0) this.b.push(0) }
  u8(v: number): void { this.b.push(v & 0xff) }
  u16(v: number): void { this.b.push(v & 0xff, (v >> 8) & 0xff) }
  u32(v: number): void { this.b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff) }
  u64(v: number): void { this.u32(v % 2 ** 32); this.u32(Math.floor(v / 2 ** 32)) }
  patchU32(at: number, v: number): void {
    this.b[at] = v & 0xff; this.b[at + 1] = (v >>> 8) & 0xff; this.b[at + 2] = (v >>> 16) & 0xff; this.b[at + 3] = (v >>> 24) & 0xff
  }
}

/** A table field: an inline scalar, or a child written after the table (a table, a string or a vector of tables). */
type FbField =
  | { id: number; u8: number }
  | { id: number; u64: number }
  | { id: number; child: (w: FbWriter) => number }

function fbTable(w: FbWriter, fields: FbField[]): number {
  const maxId = Math.max(-1, ...fields.map((f) => f.id))
  // Inline layout: the soffset, then each field (u64 8 bytes, u8 1 byte, an offset 4 bytes), 4-aligned.
  const offs = new Map<number, number>()
  let size = 4
  for (const f of fields) {
    offs.set(f.id, size)
    size += 'u64' in f ? 8 : 'u8' in f ? 4 : 4
  }
  w.align(4)
  const vt = w.pos
  w.u16(4 + 2 * (maxId + 1))
  w.u16(size)
  for (let i = 0; i <= maxId; i++) w.u16(offs.get(i) ?? 0)
  w.align(4)
  const t = w.pos
  w.u32(t - vt) // soffset: the vtable sits before the table
  const refs: Array<{ at: number; child: (w: FbWriter) => number }> = []
  for (const f of fields) {
    if ('u64' in f) w.u64(f.u64)
    else if ('u8' in f) { w.u8(f.u8); w.u8(0); w.u8(0); w.u8(0) }
    else { refs.push({ at: w.pos, child: f.child }); w.u32(0) }
  }
  for (const r of refs) { const c = r.child(w); w.patchU32(r.at, c - r.at) }
  return t
}

function fbString(s: string): (w: FbWriter) => number {
  return (w) => {
    w.align(4)
    const p = w.pos
    const bytes = Buffer.from(s, 'utf8')
    w.u32(bytes.length)
    for (const x of bytes) w.u8(x)
    w.u8(0)
    return p
  }
}

function fbTables(items: Array<(w: FbWriter) => number>): (w: FbWriter) => number {
  return (w) => {
    w.align(4)
    const p = w.pos
    w.u32(items.length)
    const slots = items.map(() => { const at = w.pos; w.u32(0); return at })
    items.forEach((make, i) => { const c = make(w); w.patchU32(slots[i], c - slots[i]) })
    return p
  }
}

/** A section of a fake bundle: its data type (AnySectionDataType: 3 TFLiteModel, 5 LlmMetadataProto, 9
 *  ExecutorMetadataProto, ...), its string items (a TFLiteModel's model_type, backend_constraint) and its bytes. */
export interface FakeSection { type: number; items?: Record<string, string>; data?: Buffer }

/** A .litertlm with these sections: the 32-byte prefix, the header FlatBuffer, then each section's bytes. */
export function fakeLitertlmBundleOf(sections: FakeSection[]): Buffer {
  const DATA_START = 4096
  const ranges: Array<[number, number]> = []
  let at = DATA_START
  for (const s of sections) { const n = s.data?.length ?? 16; ranges.push([at, at + n]); at += n }
  const w = new FbWriter()
  w.u32(0) // root offset, patched below
  const kv = (key: string, value: string) => (wr: FbWriter) => fbTable(wr, [
    { id: 0, child: fbString(key) },
    { id: 1, u8: 9 }, // VData.StringValue
    { id: 2, child: (w2) => fbTable(w2, [{ id: 0, child: fbString(value) }]) },
  ])
  const section = (s: FakeSection, i: number) => (wr: FbWriter) => fbTable(wr, [
    ...(s.items ? [{ id: 0, child: fbTables(Object.entries(s.items).map(([k, v]) => kv(k, v))) }] : []),
    { id: 1, u64: ranges[i][0] },
    { id: 2, u64: ranges[i][1] },
    { id: 3, u8: s.type },
  ])
  const root = fbTable(w, [{ id: 1, child: (wr) => fbTable(wr, [{ id: 0, child: fbTables(sections.map(section)) }]) }])
  w.patchU32(0, root)
  const header = Buffer.from(w.b)
  if (32 + header.length > DATA_START) throw new Error('fake header too large')
  const file = Buffer.alloc(at)
  file.write('LITERTLM', 0, 'latin1')
  file.writeUInt32LE(1, 8); file.writeUInt32LE(7, 12)
  file.writeBigUInt64LE(BigInt(32 + header.length), 24)
  header.copy(file, 32)
  sections.forEach((s, i) => s.data?.copy(file, ranges[i][0]))
  return file
}

/** LlmMetadata protobuf bytes (runtime/proto/llm_metadata.proto) with the fields the tests need. */
export function fakeLlmMetadata(fields: { maxNumTokens?: number }): Buffer {
  return Buffer.from(fields.maxNumTokens ? pVarint(5, fields.maxNumTokens) : [])
}
