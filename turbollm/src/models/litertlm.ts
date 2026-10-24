// LiteRT-LM models in the library. A `.litertlm` file is one self-contained bundle (weights, tokenizer, and for
// multimodal models the vision/audio encoders) that Google's LiteRT-LM runtime loads directly, so the library holds it
// the way it holds a GGUF: one file, one entry, deleted as a file. Unlike a GGUF it carries no header TurboLLM can read
// cheaply (the metadata is a FlatBuffer), so the entry is built from the file name and the 8-byte magic.
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ModelEntry } from './scanner'

/** The first 8 bytes of every LiteRT-LM file (litert_lm_builder's HEADER_MAGIC_BYTES). */
const MAGIC = 'LITERTLM'

/** Unlike a GGUF a .litertlm can be tiny (small test bundles), so only the magic below gates it, not a size floor. */
export function isLitertlmFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.litertlm')
}

/** True when the file really is a LiteRT-LM bundle — keeps a renamed HTML error page or a truncated download out of
 *  the library, where it would otherwise fail at load time with a native-runtime message. */
export async function hasLitertlmMagic(path: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const head = Buffer.alloc(MAGIC.length)
    const { bytesRead } = await fh.read(head, 0, MAGIC.length, 0)
    return bytesRead === MAGIC.length && head.toString('latin1') === MAGIC
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

// litert-community names its files by precision (`-int4`, `_q8`, `-fp16`). Anchored on separators, and the last match
// wins, for the same reason quantFromName's does (a model name can contain a number-letter run of its own).
const QUANT_RE = /(?:^|[-_. ])(int[248]|fp16|f16|fp32|bf16|q[48])(?=$|[-_. ])/gi

/** The precision label from the file name, '?' when it states none. */
export function litertlmQuantFromName(fileName: string): string {
  const matches = [...fileName.matchAll(QUANT_RE)]
  return matches.length > 0 ? matches[matches.length - 1][1].toUpperCase() : '?'
}

/** `ekv4096` in a litert-community name is the KV-cache length the bundle was exported with, which is the longest
 *  context the runtime can give it — the nearest thing to a native context the file name declares. 0 = not declared. */
export function litertlmNativeCtxFromName(fileName: string): number {
  const m = /(?:^|[-_. ])ekv(\d{3,6})(?=$|[-_. ])/i.exec(fileName)
  return m ? Number(m[1]) : 0
}

// ── Context limit from the bundle header ──────────────────────────────────────────────────
// A .litertlm starts with "LITERTLM", three uint32 versions, 4 bytes of padding, a uint64 header-end offset, then a
// FlatBuffer (schema/core/litertlm_header_schema.fbs) listing the sections with their byte ranges. The small
// ExecutorMetadata protobuf section describes each KV-cache state buffer, with its `maximum_sequence_length`
// (field 9). A static export sizes its global (full-attention) KV caches to exactly that, and the runtime clamps
// max_num_tokens down to it whatever the engine was asked for (ClampMaxNumTokens in
// llm_litert_compiled_model_executor.cc), so it is a hard limit.
// Only global caches count: a sliding-window (local) cache's length is its window, not the context, and LlmMetadata's
// own max_num_tokens is a default, which a dynamic export can grow past: neither is the limit (the default is read
// as the default, below).
// litert-community/LFM2.5-230M, for one: no `ekv` in its file name, 4096-entry KV caches, and a 15k-token prompt failed
// with "Input token ids are too long ... 15753 >= 4096" while the slider offered 256k.
//
// A length that is a "magic number" (a prime above 10, the runtime's IsMagicNumber in model_info.cc) is not a size: it
// marks a dynamic dimension the runtime replaces with max_num_tokens, which must be smaller than it
// (llm_executor_settings.h). Qwen3-0.6B_dynamic's caches say 32771, so it takes up to 32770 tokens, not "exactly 32771".
//
// The model's own default context is LlmMetadata.max_num_tokens (field 5): what the runtime uses when it is given none
// (engine_settings.cc: that value, or 4096 when the bundle declares none, sized for an empty prompt), the static limit
// above still capping it. TurboLLM used to pass 8192 (min(Model Defaults, the limit)) on every load instead, doubling
// Qwen3's KV cache and reporting 8192 for bundles it could not size while the runtime clamped to their real limit.

const SECTION_LLM_METADATA = 5
const SECTION_EXECUTOR_METADATA = 9
const MAX_HEADER = 1 << 20
const MAX_PROTO = 1 << 20

/** One FlatBuffer table over a buffer: just the accessors the header needs. */
class FbTable {
  constructor(private readonly b: Buffer, private readonly pos: number) {}
  private field(i: number): number {
    const vt = this.pos - this.b.readInt32LE(this.pos)
    const o = 4 + 2 * i
    return o < this.b.readUInt16LE(vt) ? this.b.readUInt16LE(vt + o) : 0
  }
  table(i: number): FbTable | null {
    const o = this.field(i)
    if (!o) return null
    const p = this.pos + o
    return new FbTable(this.b, p + this.b.readUInt32LE(p))
  }
  tables(i: number): FbTable[] {
    const o = this.field(i)
    if (!o) return []
    let p = this.pos + o
    p += this.b.readUInt32LE(p)
    const n = this.b.readUInt32LE(p)
    const out: FbTable[] = []
    for (let k = 0; k < n; k++) {
      const q = p + 4 + 4 * k
      out.push(new FbTable(this.b, q + this.b.readUInt32LE(q)))
    }
    return out
  }
  u64(i: number): number {
    const o = this.field(i)
    return o ? Number(this.b.readBigUInt64LE(this.pos + o)) : 0
  }
  u8(i: number): number {
    const o = this.field(i)
    return o ? this.b.readUInt8(this.pos + o) : 0
  }
}

type ProtoField = { field: number; varint?: number; bytes?: Buffer }

/** The top-level fields of a protobuf message (varint and length-delimited; fixed-width ones are skipped). */
export function protoFields(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = []
  let i = 0
  const varint = (): number => {
    let v = 0
    let mul = 1
    for (;;) {
      if (i >= buf.length) throw new RangeError('truncated varint')
      const c = buf[i++]
      v += (c & 0x7f) * mul
      if (c < 0x80) return v
      mul *= 128
    }
  }
  while (i < buf.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) out.push({ field, varint: varint() })
    else if (wire === 2) {
      const len = varint()
      if (i + len > buf.length) throw new RangeError('truncated field')
      out.push({ field, bytes: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else throw new RangeError(`unsupported wire type ${wire}`)
  }
  return out
}

/** The longest sequence the bundle's global KV caches hold (ExecutorMetadata), or 0 when they declare none.
 *  StateBuffer.Type 1/2 are global key/value caches: every one must hold the sequence, so the smallest declared
 *  length is the limit. 3/4 (local, sliding-window: the length is the window) and 5 (linear-attention state) say
 *  nothing about context. 0 (TYPE_UNSPECIFIED, older exports) could be either kind, so it is used only when no cache
 *  is typed, and then the LARGEST length wins: a sliding window is shorter than the context, never longer, so the
 *  max is the global length, and taking the min could cap Context at a 512-token window. */
export function executorMetadataMaxSequence(proto: Buffer): number {
  let typed = 0
  let untyped = 0
  for (const top of protoFields(proto)) {
    if (top.field !== 1 || !top.bytes) continue // llm_executor_metadata
    for (const f of protoFields(top.bytes)) {
      if (f.field !== 2 || !f.bytes) continue // state_buffers
      const fields = protoFields(f.bytes)
      const type = fields.find((x) => x.field === 6)?.varint ?? 0
      const len = fields.find((x) => x.field === 9)?.varint ?? 0 // maximum_sequence_length
      if (len <= 0) continue
      if (type === 1 || type === 2) typed = typed === 0 ? len : Math.min(typed, len)
      else if (type === 0) untyped = Math.max(untyped, len)
    }
  }
  return typed || untyped
}

/** The runtime's IsMagicNumber (model_info.cc): a prime above 10 marks a dynamic dimension, not a size. */
export function isLitertMagicNumber(n: number): boolean {
  if (!Number.isInteger(n) || n < 11 || n % 2 === 0) return false
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false
  return true
}

/** LlmMetadata.max_num_tokens (field 5): the context the bundle's runtime uses when it is given none. 0 when unset. */
export function llmMetadataMaxNumTokens(proto: Buffer): number {
  const f = protoFields(proto).find((x) => x.field === 5 && x.varint !== undefined)
  return f?.varint ?? 0
}

/** What the bundle's header says that TurboLLM uses (see the section comment above). */
export interface LitertlmHeader {
  /** The longest context it takes: a static export's KV-cache length, a dynamic one's magic number less one; 0 = unknown. */
  nativeCtx: number
  /** nativeCtx is a dynamic export's maximum (its KV length is a magic number), not a size its caches hold. */
  ctxDynamic: boolean
  /** LlmMetadata.max_num_tokens: the context the runtime uses when given none; 0 when the bundle declares none. */
  defaultCtx: number
}

const NO_HEADER: LitertlmHeader = { nativeCtx: 0, ctxDynamic: false, defaultCtx: 0 }

/** Reads only the header and the small LlmMetadata and ExecutorMetadata sections, never the weights. A header this
 *  reader does not understand gives NO_HEADER: it costs only the slider's precision and the model's own defaults. */
export async function litertlmHeaderFromFile(path: string): Promise<LitertlmHeader> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const read = async (pos: number, len: number): Promise<Buffer> => {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh!.read(buf, 0, len, pos)
      return buf.subarray(0, bytesRead)
    }
    const head = await read(0, 32)
    if (head.length < 32 || head.toString('latin1', 0, 8) !== MAGIC) return NO_HEADER
    const headerEnd = Number(head.readBigUInt64LE(24))
    if (headerEnd <= 32 || headerEnd > MAX_HEADER) return NO_HEADER
    const header = await read(32, headerEnd - 32)
    const root = new FbTable(header, header.readUInt32LE(0))
    const sections = root.table(1)?.tables(0) ?? [] // section_metadata.objects
    const out: LitertlmHeader = { ...NO_HEADER }
    for (const s of sections) {
      const type = s.u8(3)
      if (type !== SECTION_EXECUTOR_METADATA && type !== SECTION_LLM_METADATA) continue
      const begin = s.u64(1)
      const end = s.u64(2)
      if (end <= begin || end - begin > MAX_PROTO) continue
      const proto = await read(begin, end - begin)
      if (type === SECTION_LLM_METADATA) {
        out.defaultCtx = llmMetadataMaxNumTokens(proto)
        continue
      }
      const len = executorMetadataMaxSequence(proto)
      out.ctxDynamic = isLitertMagicNumber(len)
      out.nativeCtx = out.ctxDynamic ? len - 1 : len
    }
    return out
  } catch {
    return NO_HEADER
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** The hard context limit the bundle declares (see the section comment above), or 0 when the header says nothing or
 *  cannot be read. */
export async function litertlmNativeCtxFromFile(path: string): Promise<number> {
  return (await litertlmHeaderFromFile(path)).nativeCtx
}

function cleanName(fileName: string): string {
  return fileName
    .replace(/\.litertlm$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The library entry for a `.litertlm` file. Its format is 'litertlm' (a single file, deleted as a file); compat.ts
 *  gives it to the LiteRT-LM engine and to no other. Vision/audio stay false: the bundle declares them only in the
 *  FlatBuffer header, and claiming a capability the file may lack would put an image button on a text-only model. */
export function litertlmEntryFor(
  path: string, dir: string, sizeBytes: number, mtimeMs: number, header: number | Partial<LitertlmHeader> = 0,
): ModelEntry {
  const fileName = basename(path)
  const name = cleanName(fileName)
  const quant = litertlmQuantFromName(fileName)
  const h: Partial<LitertlmHeader> = typeof header === 'number' ? { nativeCtx: header } : header
  const headerCtx = h.nativeCtx ?? 0
  return {
    key: `${name.toLowerCase()}|${quant}|${sizeBytes}`,
    name,
    path,
    dir,
    format: 'litertlm',
    sizeBytes,
    sizeLabel: '',
    arch: 'litertlm',
    quant,
    // The header is the bundle's own word; the `ekvNNNN` name tag is the fallback for headers that declare nothing.
    nativeCtx: headerCtx || litertlmNativeCtxFromName(fileName),
    ...(headerCtx > 0 && h.ctxDynamic ? { ctxDynamic: true } : {}),
    ...((h.defaultCtx ?? 0) > 0 ? { defaultCtx: h.defaultCtx } : {}),
    blockCount: 0,
    headCountKv: 0,
    headDim: 0,
    moe: false,
    expertCount: 0,
    nextnLayers: 0,
    vision: false,
    audio: false,
    mmprojPath: null,
    mmprojSizeBytes: 0,
    hasChatTemplate: true, // the bundle embeds its own template; the runtime applies it
    reasoningEffort: false,
    embedding: false,
    incomplete: sizeBytes === 0,
    parseError: null,
    loaded: false,
    hasProfile: false,
    benchTps: null,
    mtime: new Date(mtimeMs || Date.now()).toISOString(),
  }
}
