// A complete GGUF v3 for tests, laid out as llama.cpp's writer lays one out: the header, the KV
// pairs (strings and uint32s), the tensor infos, padding to the alignment, then each tensor's
// data padded to the alignment too. Tensor bytes follow a deterministic pattern, so a file cut
// short or spliced from another one differs from the original.

export interface GgufTensor {
  name: string
  dims: number[]
  /** A ggml type: 0 F32 (1 element, 4 bytes per block), 8 Q8_0 (32 elements, 34 bytes), ... */
  type: number
}

/** Elements and bytes per block of the ggml types these tests use. */
const BLOCKS: Record<number, [number, number]> = { 0: [1, 4], 1: [1, 2], 8: [32, 34] }

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const str = (s: string) => { const body = Buffer.from(s, 'utf8'); return Buffer.concat([u64(body.length), body]) }

/** The fixed header and the KV pairs (strings and uint32s) of a GGUF v3 with `tensorCount` tensors. */
function headAndKvs(tensorCount: number, kvs: Array<[string, string | number]>): Buffer[] {
  const head: Buffer[] = [u32(0x46554747), u32(3), u64(tensorCount), u64(kvs.length)]
  for (const [key, value] of kvs) {
    head.push(str(key))
    head.push(...(typeof value === 'string' ? [u32(8), str(value)] : [u32(4), u32(value)]))
  }
  return head
}

/** A GGUF with no tensors, as convert_hf_to_gguf.py --vocab-only writes one (llama.cpp's
 *  models/ggml-vocab-*.gguf): the header and the KV pairs, with no padding after them. */
export function ggufVocabOnly(kvs: Array<[string, string | number]>): Buffer {
  return Buffer.concat(headAndKvs(0, kvs))
}

export function ggufFile(tensors: GgufTensor[], kvs: Array<[string, string | number]> = [], alignment = 32): Buffer {
  const pad = (n: number) => Math.ceil(n / alignment) * alignment

  const head = headAndKvs(tensors.length, kvs)
  const sizes = tensors.map((t) => {
    const [elems, bytes] = BLOCKS[t.type]
    return (t.dims.reduce((a, b) => a * b, 1) / elems) * bytes
  })
  let offset = 0
  tensors.forEach((t, i) => {
    head.push(str(t.name), u32(t.dims.length), ...t.dims.map(u64), u32(t.type), u64(offset))
    offset += pad(sizes[i])
  })
  const header = Buffer.concat(head)
  const file = Buffer.alloc(pad(header.length) + offset)
  header.copy(file)
  for (let i = pad(header.length); i < file.length; i++) file[i] = (i * 31 + (i >> 9)) & 0xff
  return file
}
