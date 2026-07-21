// Minimal GGUF header reader (spec 04 §3). Reads only the KV metadata block —
// never the tensor data — skipping large arrays (tokenizer vocab) by advancing
// the file offset rather than materializing them.
import { closeSync, openSync, readSync } from 'node:fs'

export class GgufError extends Error {
  constructor(
    public code: string,
    msg: string,
  ) {
    super(msg)
    this.name = 'GgufError'
  }
}

export interface GgufMeta {
  arch: string
  name: string
  quant: string
  sizeLabel: string
  nativeCtx: number
  blockCount: number
  embedLen: number
  /** Max KV-head count across layers. Architectures that vary the count per layer
   *  (Gemma 4 declares an array) collapse to the largest — the conservative choice for a
   *  single-number estimate. Use `headCountKvPerLayer` when it's non-empty for the real
   *  per-layer values. */
  headCountKv: number
  /** Real per-head dimension from `<arch>.attention.key_length` (falling back to
   *  `value_length`) — llama.cpp's own authoritative field for KV-cache sizing. NOT always
   *  `embedding_length / head_count`: GQA/MQA architectures with a decoupled head dimension
   *  (e.g. Qwen3.6-27B's real 256 vs. its embedding-derived ~128) diverge from that ratio.
   *  0 when the GGUF doesn't declare it — callers fall back to a conservative constant. */
  headDim: number
  expertCount: number
  /** `<arch>.nextn_predict_layers` — >0 means the GGUF carries a built-in NextN /
   *  multi-token-prediction head (self-speculative decoding). 0 = none. */
  nextnLayers: number
  hasChatTemplate: boolean

  // ---- Attention layout (optional; all absent-by-default) --------------------------
  // Most GGUFs (plain llama/mistral/qwen2-style dense attention) declare none of the
  // keys below and every field here stays 0/[] — callers must treat that as "unknown
  // layout, assume every layer caches the full context", i.e. exactly the old behaviour.
  // These exist because two families badly violate that assumption:
  //   - sliding-window attention (Gemma 3/4): most layers cap at a fixed window, and the
  //     window layers use a *different* head dim (and sometimes a different KV-head
  //     count) than the global ones.
  //   - hybrid linear/SSM attention (Qwen3.5/3.6, Qwen3-Next): only every Nth layer keeps
  //     a growing KV cache; the rest hold a small constant recurrent state.

  /** `<arch>.attention.sliding_window` — window size in tokens for sliding layers.
   *  0 when absent. */
  slidingWindow: number
  /** `<arch>.attention.sliding_window_pattern` when declared as a per-layer boolean
   *  array; `true` = that layer is SLIDING (windowed), `false` = full/global attention.
   *  `[]` when absent, or when the architecture declares it as a scalar stride instead —
   *  we don't guess a mask from a stride, so callers fall back to the conservative
   *  every-layer-is-global estimate. Length is expected to equal `blockCount`. */
  slidingWindowPattern: boolean[]
  /** `<arch>.attention.key_length_swa` (falling back to `value_length_swa`) — the
   *  per-head dim used by *sliding* layers, which Gemma 4 sets to half its global
   *  `key_length`. 0 when absent; callers then reuse `headDim` for every layer, which
   *  over-counts rather than under-counts. */
  headDimSwa: number
  /** `<arch>.attention.head_count_kv` when it is declared as a per-layer ARRAY (Gemma
   *  4's 26B-A4B does; its sliding and global layers use different counts). `[]` when
   *  the key is scalar or absent — the scalar is always available as `headCountKv`. */
  headCountKvPerLayer: number[]
  /** `<arch>.full_attention_interval` — on hybrid linear/SSM architectures, every Nth
   *  layer is real full attention (and thus the only layers with a growing KV cache);
   *  the others hold a constant-size recurrent state. 0 when absent. */
  fullAttentionInterval: number
  /** `<arch>.ssm.inner_size` / `.ssm.state_size` / `.ssm.conv_kernel` — the recurrent
   *  state dimensions on hybrid architectures. Non-zero values are the marker that a
   *  model is hybrid *at all*, even when it declines to declare `full_attention_interval`
   *  (Qwen3-Coder-Next does exactly that: hybrid with an undeclared layout). 0 when absent. */
  ssmInnerSize: number
  ssmStateSize: number
  ssmConvKernel: number
}

const MAGIC = 0x46554747 // "GGUF" little-endian

// LLAMA_FTYPE -> quant label (spec 04 §3).
const FTYPE: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ4_XS', 30: 'BF16',
}

// GGUF value types.
const T_UINT8 = 0, T_INT8 = 1, T_UINT16 = 2, T_INT16 = 3, T_UINT32 = 4, T_INT32 = 5,
  T_FLOAT32 = 6, T_BOOL = 7, T_STRING = 8, T_ARRAY = 9, T_UINT64 = 10, T_INT64 = 11,
  T_FLOAT64 = 12

function scalarSize(t: number): number {
  switch (t) {
    case T_UINT8: case T_INT8: case T_BOOL: return 1
    case T_UINT16: case T_INT16: return 2
    case T_UINT32: case T_INT32: case T_FLOAT32: return 4
    case T_UINT64: case T_INT64: case T_FLOAT64: return 8
    default: return 0
  }
}

// Buffered forward-only reader over a file descriptor.
class BufReader {
  private buf = Buffer.alloc(0)
  private pos = 0
  private fileOff = 0
  constructor(
    private fd: number,
    private chunk = 1 << 22, // 4 MB
  ) {}

  private fill(need: number): void {
    if (this.buf.length - this.pos >= need) return
    const remaining = this.buf.subarray(this.pos)
    const toRead = Math.max(this.chunk, need - remaining.length)
    const tmp = Buffer.alloc(toRead)
    const r = readSync(this.fd, tmp, 0, toRead, this.fileOff + this.buf.length)
    this.fileOff += this.pos
    this.buf = Buffer.concat([remaining, tmp.subarray(0, r)])
    this.pos = 0
    if (this.buf.length < need) throw new GgufError('truncated', 'Unexpected EOF in GGUF header.')
  }

  bytes(n: number): Buffer {
    this.fill(n)
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }
  u8(): number { return this.bytes(1).readUInt8(0) }
  u32(): number { return this.bytes(4).readUInt32LE(0) }
  i32(): number { return this.bytes(4).readInt32LE(0) }
  f32(): number { return this.bytes(4).readFloatLE(0) }
  u64(): number { return Number(this.bytes(8).readBigUInt64LE(0)) }
  i64(): number { return Number(this.bytes(8).readBigInt64LE(0)) }
  f64(): number { return this.bytes(8).readDoubleLE(0) }
  str(): string {
    const len = this.u64()
    return this.bytes(len).toString('utf8')
  }
  skip(n: number): void {
    const buffered = this.buf.length - this.pos
    if (n <= buffered) {
      this.pos += n
      return
    }
    // Beyond the buffer: drop it and advance the file offset (cheap, no read).
    this.fileOff = this.fileOff + this.pos + n
    this.buf = Buffer.alloc(0)
    this.pos = 0
  }
}

function readScalar(r: BufReader, t: number): number | string | boolean {
  switch (t) {
    case T_UINT8: return r.u8()
    case T_INT8: return r.bytes(1).readInt8(0)
    case T_UINT16: return r.bytes(2).readUInt16LE(0)
    case T_INT16: return r.bytes(2).readInt16LE(0)
    case T_UINT32: return r.u32()
    case T_INT32: return r.i32()
    case T_FLOAT32: return r.f32()
    case T_BOOL: return r.u8() !== 0
    case T_UINT64: return r.u64()
    case T_INT64: return r.i64()
    case T_FLOAT64: return r.f64()
    case T_STRING: return r.str()
    default: throw new GgufError('bad_type', `Unknown GGUF value type ${t}.`)
  }
}

function skipValue(r: BufReader, t: number): void {
  if (t === T_STRING) {
    r.skip(r.u64())
    return
  }
  if (t === T_ARRAY) {
    const elemType = r.u32()
    const count = r.u64()
    if (elemType === T_STRING) {
      for (let i = 0; i < count; i++) r.skip(r.u64())
    } else {
      r.skip(count * scalarSize(elemType))
    }
    return
  }
  r.skip(scalarSize(t))
}

// Reads a numeric value as a list. A scalar yields a one-element list; an array is
// materialized in order. `isArray` is kept separate from `values.length` so a genuine
// one-element array isn't mistaken for a scalar.
function readNumberList(r: BufReader, t: number): { values: number[]; isArray: boolean } {
  if (t === T_ARRAY) {
    const elemType = r.u32()
    const count = r.u64()
    const values: number[] = []
    for (let i = 0; i < count; i++) values.push(Number(readScalar(r, elemType)))
    return { values, isArray: true }
  }
  return { values: [Number(readScalar(r, t))], isArray: false }
}

// Reads a numeric value or, for an int array (e.g. per-layer head_count_kv),
// the maximum element.
function readNumberOrMax(r: BufReader, t: number): number {
  return maxOf(readNumberList(r, t).values)
}

// Max of an already-read list, floored at 0 (an empty array reads as 0, matching the
// "unknown" convention the rest of this parser uses).
function maxOf(values: number[]): number {
  let max = 0
  for (const v of values) if (v > max) max = v
  return max
}

// Reads a per-layer boolean mask (e.g. sliding_window_pattern). Non-array values are
// consumed and reported as `[]`: some architectures declare this key as a scalar stride
// rather than a mask, and inventing a mask from a stride risks *under*-counting the KV
// cache. An unknown layout must degrade to the conservative estimate, not a guess.
function readBoolArray(r: BufReader, t: number): boolean[] {
  if (t !== T_ARRAY) {
    skipValue(r, t)
    return []
  }
  const elemType = r.u32()
  const count = r.u64()
  const out: boolean[] = []
  for (let i = 0; i < count; i++) {
    const v = readScalar(r, elemType)
    // Bool arrays are the real-world shape; ints/strings are tolerated so a
    // differently-typed writer doesn't silently produce an all-true mask
    // (`Boolean('false')` is `true`).
    out.push(typeof v === 'string' ? v.toLowerCase() === 'true' : Boolean(v))
  }
  return out
}

/** Parse the GGUF metadata header. Throws GgufError on a non-GGUF/truncated file. */
export function parseGguf(path: string): GgufMeta {
  const fd = openSync(path, 'r')
  try {
    const r = new BufReader(fd)
    if (r.u32() !== MAGIC) throw new GgufError('not_gguf', 'Not a GGUF file.')
    const version = r.u32()
    if (version !== 2 && version !== 3) throw new GgufError('bad_version', `Unsupported GGUF version ${version}.`)
    r.u64() // tensorCount (unused)
    const kvCount = r.u64()

    const m: Partial<GgufMeta> = { hasChatTemplate: false }
    // key_length/value_length are usually equal (both = the real per-head dim); tracked
    // separately since a GGUF can in principle declare only one.
    let keyLength: number | undefined
    let valueLength: number | undefined
    // Same pairing for the sliding-window variants of those two keys.
    let keyLengthSwa: number | undefined
    let valueLengthSwa: number | undefined
    for (let i = 0; i < kvCount; i++) {
      const key = r.str()
      const t = r.u32()
      if (key === 'general.architecture') m.arch = String(readScalar(r, t))
      else if (key === 'general.name') m.name = String(readScalar(r, t))
      else if (key === 'general.file_type') m.quant = FTYPE[Number(readScalar(r, t))] ?? ''
      else if (key === 'general.size_label') m.sizeLabel = String(readScalar(r, t))
      else if (key.endsWith('.context_length')) m.nativeCtx = readNumberOrMax(r, t)
      else if (key.endsWith('.block_count')) m.blockCount = readNumberOrMax(r, t)
      else if (key.endsWith('.embedding_length')) m.embedLen = readNumberOrMax(r, t)
      else if (key.endsWith('.attention.head_count_kv')) {
        // Scalar on most architectures, a per-layer array on Gemma 4's 26B-A4B. Keep the
        // max as the scalar `headCountKv` (unchanged behaviour) and additionally retain
        // the array, since collapsing [8,8,8,8,8,2,…] to 8 assigns the global layers 4x
        // the KV heads they actually use.
        const kv = readNumberList(r, t)
        m.headCountKv = maxOf(kv.values)
        if (kv.isArray) m.headCountKvPerLayer = kv.values
      }
      else if (key.endsWith('.attention.key_length')) keyLength = readNumberOrMax(r, t)
      else if (key.endsWith('.attention.value_length')) valueLength = readNumberOrMax(r, t)
      else if (key.endsWith('.attention.key_length_swa')) keyLengthSwa = readNumberOrMax(r, t)
      else if (key.endsWith('.attention.value_length_swa')) valueLengthSwa = readNumberOrMax(r, t)
      else if (key.endsWith('.attention.sliding_window')) m.slidingWindow = readNumberOrMax(r, t)
      else if (key.endsWith('.attention.sliding_window_pattern')) m.slidingWindowPattern = readBoolArray(r, t)
      else if (key.endsWith('.full_attention_interval')) m.fullAttentionInterval = readNumberOrMax(r, t)
      else if (key.endsWith('.ssm.inner_size')) m.ssmInnerSize = readNumberOrMax(r, t)
      else if (key.endsWith('.ssm.state_size')) m.ssmStateSize = readNumberOrMax(r, t)
      else if (key.endsWith('.ssm.conv_kernel')) m.ssmConvKernel = readNumberOrMax(r, t)
      else if (key.endsWith('.expert_count')) m.expertCount = readNumberOrMax(r, t)
      else if (key.endsWith('.nextn_predict_layers')) m.nextnLayers = readNumberOrMax(r, t)
      else if (key === 'tokenizer.chat_template') {
        m.hasChatTemplate = true
        skipValue(r, t)
      } else {
        skipValue(r, t)
      }
    }

    return {
      arch: m.arch ?? 'unknown',
      name: m.name ?? '',
      quant: m.quant ?? '',
      sizeLabel: m.sizeLabel ?? '',
      nativeCtx: m.nativeCtx ?? 0,
      blockCount: m.blockCount ?? 0,
      embedLen: m.embedLen ?? 0,
      headCountKv: m.headCountKv ?? 0,
      headDim: keyLength ?? valueLength ?? 0,
      expertCount: m.expertCount ?? 0,
      nextnLayers: m.nextnLayers ?? 0,
      hasChatTemplate: m.hasChatTemplate ?? false,
      slidingWindow: m.slidingWindow ?? 0,
      slidingWindowPattern: m.slidingWindowPattern ?? [],
      headDimSwa: keyLengthSwa ?? valueLengthSwa ?? 0,
      headCountKvPerLayer: m.headCountKvPerLayer ?? [],
      fullAttentionInterval: m.fullAttentionInterval ?? 0,
      ssmInnerSize: m.ssmInnerSize ?? 0,
      ssmStateSize: m.ssmStateSize ?? 0,
      ssmConvKernel: m.ssmConvKernel ?? 0,
    }
  } finally {
    closeSync(fd)
  }
}

/** Best-effort quant from a filename token when general.file_type is absent/unknown. */
export function quantFromName(filename: string): string {
  const m = filename.match(/(I?Q\d[A-Z0-9_]*|BF16|F16|F32)/i)
  return m ? m[1].toUpperCase() : '?'
}
