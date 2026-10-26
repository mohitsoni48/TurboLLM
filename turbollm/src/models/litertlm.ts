// LiteRT-LM models in the library. A `.litertlm` file is one self-contained bundle (weights, tokenizer, and for
// multimodal models the vision/audio encoders) that Google's LiteRT-LM runtime loads directly, so the library holds it
// the way it holds a GGUF: one file, one entry, deleted as a file. Its metadata is a FlatBuffer header listing its
// sections, which litertlmHeaderFromFile walks for what the entry needs (context, modalities, tool calling); the rest
// comes from the file name and the 8-byte magic.
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

const SECTION_TFLITE_MODEL = 3
const SECTION_LLM_METADATA = 5
const SECTION_EXECUTOR_METADATA = 9

// The model types whose sections make a bundle multimodal: the encoders upstream's `serve` gives a vision or audio
// backend for (serve/util.py, model.parse_backend with target_model_types VISION_ENCODER / AUDIO_ENCODER_HW). A bundle
// declares its modalities only in this header, so they are read here: every .litertlm used to be marked text-only.
const VISION_ENCODER = 'tf_lite_vision_encoder'
const AUDIO_ENCODER = 'tf_lite_audio_encoder_hw'
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
  string(i: number): string | null {
    const o = this.field(i)
    if (!o) return null
    let p = this.pos + o
    p += this.b.readUInt32LE(p)
    const n = this.b.readUInt32LE(p)
    return this.b.toString('utf8', p + 4, p + 4 + n)
  }
}

/** VData.StringValue, the union type of a KeyValuePair whose value is a string (litertlm_header_schema.fbs). */
const VDATA_STRING = 9

/** A section's string items (KeyValuePair key → StringValue): a TFLiteModel's `model_type`, `backend_constraint`. */
function sectionStrings(section: FbTable): Map<string, string> {
  const out = new Map<string, string>()
  for (const kv of section.tables(0)) {
    const key = kv.string(0)
    if (key === null || kv.u8(1) !== VDATA_STRING) continue
    const value = kv.table(2)?.string(0)
    if (value != null) out.set(key, value)
  }
  return out
}

type ProtoField = { field: number; varint?: number; bytes?: Buffer; f32?: number }

/** The top-level fields of a protobuf message: varint, length-delimited and 32-bit (read as a float: the proto's
 *  `float` fields, SamplerParameters.p and .temperature); 64-bit ones are skipped. */
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
    } else if (wire === 5) {
      if (i + 4 > buf.length) throw new RangeError('truncated field')
      out.push({ field, f32: buf.readFloatLE(i) })
      i += 4
    } else if (wire === 1) i += 8
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

// ── Tool calling ──────────────────────────────────────────────────────────────────────────
// Both LiteRT-LM servers pass a request's tools to the runtime (upstream's `serve` as tools it does not run itself,
// the Android server through litert_lm_conversation_config_set_tools), and the bundle's chat template puts them in
// the prompt: LFM2.5's renders "List of tools: [...]", Qwen3's <tools>, Gemma 4's <|tool>. A template that never reads
// them (Gemma3-1B's, LFM2.5-VL's) drops them, so the model cannot call what it was never shown. Whether a model calls
// tools is therefore its own, read here: what LlmMetadata declares (supports_function_calling, field 12, which newer
// builders require), else whether its template (jinja_prompt_template, field 7) reads `tools`, else the runtime's
// default template for its model type (field 6; model_type_utils.cc GetDefaultJinjaPromptTemplate renders tools for
// Gemma 3n and FunctionGemma only).

/** LlmModelType's oneof cases whose default template renders tools: gemma3n (2), function_gemma (3). */
const DEFAULT_TEMPLATE_TOOL_TYPES = new Set([2, 3])

// A template comes from the file (up to MAX_PROTO) and is read on every scan, so both scans below run in linear time,
// with the output the plain patterns gave. `/\{[{%]([\s\S]*?)[}%]\}/g` rescanned to the end from every opener that had
// no closer after it, and `'(?:[^'\\]|\\.)*'` from every quote that had no closing one: a crafted bundle of `{{`, or
// of `\'` in a tag, held the daemon for minutes on each scan.

/** The code inside each `{{ }}` and `{% %}` tag, in order: what `/\{[{%]([\s\S]*?)[}%]\}/g` captures. An opener with
 *  no closer after it ends the scan: no later opener has one either. */
export function jinjaTagCode(template: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    let open = template.indexOf('{', from)
    while (open >= 0 && template[open + 1] !== '{' && template[open + 1] !== '%') open = template.indexOf('{', open + 1)
    if (open < 0) return out
    // The closer is the first `}}` or `%}` starting after the opener, so its `}` is at open + 3 or later.
    let close = template.indexOf('}', open + 3)
    while (close >= 0 && template[close - 1] !== '}' && template[close - 1] !== '%') close = template.indexOf('}', close + 1)
    if (close < 0) return out
    out.push(template.slice(open + 2, close - 1))
    from = close + 1
  }
}

/** A line terminator, which a backslash cannot escape in the pattern below (its `.` does not match one). */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/** `code` with each string literal made `""`: what `code.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""')`
 *  gives. A quote whose literal never closes is kept, and so is every later quote of its kind before the point its
 *  scan stopped: each is escaped or plain text on that same scan, so its own scan stops there too. */
export function blankJinjaStrings(code: string): string {
  let out = ''
  let copied = 0
  const unclosedUntil: Record<string, number> = { "'": -1, '"': -1 }
  for (let q = 0; q < code.length; q++) {
    const quote = code[q]
    if ((quote !== "'" && quote !== '"') || q < unclosedUntil[quote]) continue
    let k = q + 1
    while (k < code.length && code[k] !== quote) {
      if (code[k] === '\\') {
        if (k + 1 >= code.length || LINE_TERMINATOR.test(code[k + 1])) break
        k++
      }
      k++
    }
    if (code[k] !== quote) {
      unclosedUntil[quote] = k
      continue
    }
    out += code.slice(copied, q) + '""'
    copied = k + 1
    q = k
  }
  return out + code.slice(copied)
}

/** Whether a Jinja chat template reads the `tools` variable in its code ({% if tools %}, {% for tool in tools %},
 *  {{ tools | tojson }}), not merely the word: the text inside string literals is left out, so LFM2.5's
 *  "List of tools: [" and Qwen3's "<tools>" do not count, and neither does an attribute (`message.tools`). */
export function jinjaTemplateTakesTools(template: string): boolean {
  for (const tag of jinjaTagCode(template)) {
    if (/(?:^|[^\w.])tools\b/.test(blankJinjaStrings(tag))) return true
  }
  return false
}

// ── Past reasoning ────────────────────────────────────────────────────────────────────────
// What a bundle's template does with a model's reasoning on earlier turns is its own. LFM2.5's reads a message's
// `reasoning_content` (or `thinking`, `reasoning`) and shows it for the turn being answered, and for earlier turns only
// with its own preserve_thinking; Qwen3-0.6B's, Gemma 3's, Gemma 4's and LFM2.5-VL's read none, so the model sees only
// its earlier answers (Gemma 4's strips its own thinking channel from them). TurboLLM's chat sends past reasoning in
// that field to a LiteRT-LM model (chat-compaction.ts buildEngineMessages); whether it can reach the model at all is
// read here, for the thread settings to say so.

/** The message fields a template reads a model's past reasoning from. */
const REASONING_FIELDS = 'reasoning_content|reasoning|thinking'

/** Whether a Jinja chat template reads a message's past reasoning in its code: `message.reasoning_content` (or
 *  `.thinking`, `.reasoning`), or the same as a subscript or a .get(); not the word in its text or a string literal. */
export function jinjaTemplateReadsReasoning(template: string): boolean {
  const subscript = new RegExp(`(?:\\[|\\.get\\()\\s*(['"])(?:${REASONING_FIELDS})\\1`)
  const attribute = new RegExp(`\\.(?:${REASONING_FIELDS})\\b`)
  for (const tag of jinjaTagCode(template)) {
    if (subscript.test(tag)) return true
    if (attribute.test(blankJinjaStrings(tag))) return true
  }
  return false
}

/** Whether the bundle's template reads a model's past reasoning (jinjaTemplateReadsReasoning); null when it carries no
 *  template of its own (the runtime's default for its model type applies, which this does not judge). */
export function llmMetadataReasoningHistory(proto: Buffer): boolean | null {
  const template = protoFields(proto).find((x) => x.field === 7 && x.bytes !== undefined)?.bytes
  return template ? jinjaTemplateReadsReasoning(template.toString('utf8')) : null
}

// ── Sampling ──────────────────────────────────────────────────────────────────────────────
// A bundle may carry its own sampler (LlmMetadata.sampler_params, field 4: SamplerParameters type 1, k 2, p 3,
// temperature 4, seed 5): Qwen3-0.6B's is TOP_P with top_k 20, top_p 0.95, temperature 0.6; gemma-4-E2B-it-gpu's top_k
// 64, top_p 0.95, temperature 1.0. The runtime samples with it while a request sets none of temperature, top_p, top_k
// or seed; one that sets any gets a sampler of its own, whose other fields upstream's `serve` fills with fixed values
// (top_k 1, top_p 0.95, temperature 1.0: litert_lm/utils.py _sampler_config_to_params), so a temperature alone threw
// the model's sampler away and decoded greedily (top_k 1). Without one of its own, the runtime's default on CPU and
// GPU is that same TOP_P, top_k 1 (engine_settings.cc): greedy.

/** A bundle's own sampler, as the fields of a request that reproduce it on the CPU sampler (TOP_P only,
 *  sampler_factory.cc): TOP_K is TOP_P with top_p 1, GREEDY is top_k 1. A field the bundle leaves 0 is absent. */
export interface LitertlmSampler {
  topK?: number
  topP?: number
  temp?: number
}

/** float32 to the decimal it was written as (0.949999988 is 0.95). */
const f32 = (v: number | undefined): number | undefined => (v === undefined ? undefined : Number(v.toPrecision(6)))

/** LlmMetadata.sampler_params as {@link LitertlmSampler}; null when the bundle declares none (or TYPE_UNSPECIFIED: the
 *  runtime decides). */
export function llmMetadataSampler(proto: Buffer): LitertlmSampler | null {
  const params = protoFields(proto).find((x) => x.field === 4 && x.bytes !== undefined)?.bytes
  if (!params) return null
  const fields = protoFields(params)
  const type = fields.find((x) => x.field === 1)?.varint ?? 0
  const k = fields.find((x) => x.field === 2)?.varint ?? 0
  const p = f32(fields.find((x) => x.field === 3)?.f32)
  const temp = f32(fields.find((x) => x.field === 4)?.f32)
  if (type === 3) return { topK: 1 } // GREEDY
  if (type !== 1 && type !== 2) return null
  return {
    ...(k > 0 ? { topK: k } : {}),
    ...(type === 1 ? { topP: 1 } : p !== undefined && p > 0 ? { topP: p } : {}),
    ...(temp !== undefined && temp > 0 ? { temp } : {}),
  }
}

/** Whether the bundle's model calls tools (see the section comment above). */
export function llmMetadataToolCalls(proto: Buffer): boolean {
  const fields = protoFields(proto)
  const declared = fields.find((x) => x.field === 12 && x.varint !== undefined)
  if (declared) return declared.varint !== 0
  const template = fields.find((x) => x.field === 7 && x.bytes !== undefined)?.bytes
  if (template) return jinjaTemplateTakesTools(template.toString('utf8'))
  const type = fields.find((x) => x.field === 6 && x.bytes !== undefined)?.bytes
  const kind = type ? protoFields(type)[0]?.field : undefined
  return kind !== undefined && DEFAULT_TEMPLATE_TOOL_TYPES.has(kind)
}

/** What the bundle's header says that TurboLLM uses (see the section comment above). */
export interface LitertlmHeader {
  /** The longest context it takes: a static export's KV-cache length, a dynamic one's magic number less one; 0 = unknown. */
  nativeCtx: number
  /** nativeCtx is a dynamic export's maximum (its KV length is a magic number), not a size its caches hold. */
  ctxDynamic: boolean
  /** LlmMetadata.max_num_tokens: the context the runtime uses when given none; 0 when the bundle declares none. */
  defaultCtx: number
  /** It carries a vision encoder (a TFLiteModel section of model_type tf_lite_vision_encoder). */
  vision: boolean
  /** It carries an audio encoder (tf_lite_audio_encoder_hw). */
  audio: boolean
  /** Its model calls tools (llmMetadataToolCalls); null when the bundle has no LlmMetadata to say. */
  toolCalls: boolean | null
  /** Its own sampler (llmMetadataSampler); null when it declares none. */
  sampler: LitertlmSampler | null
  /** Its template reads a model's past reasoning (llmMetadataReasoningHistory); null when the header does not say. */
  reasoningHistory: boolean | null
}

const NO_HEADER: LitertlmHeader = {
  nativeCtx: 0, ctxDynamic: false, defaultCtx: 0, vision: false, audio: false, toolCalls: null, sampler: null,
  reasoningHistory: null,
}

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
      if (type === SECTION_TFLITE_MODEL) {
        const modelType = sectionStrings(s).get('model_type')?.toLowerCase()
        if (modelType === VISION_ENCODER) out.vision = true
        if (modelType === AUDIO_ENCODER) out.audio = true
        continue
      }
      if (type !== SECTION_EXECUTOR_METADATA && type !== SECTION_LLM_METADATA) continue
      const begin = s.u64(1)
      const end = s.u64(2)
      if (end <= begin || end - begin > MAX_PROTO) continue
      const proto = await read(begin, end - begin)
      if (proto.length !== end - begin) continue // a cut-short file: its sections say nothing (not "no tools")
      if (type === SECTION_LLM_METADATA) {
        out.defaultCtx = llmMetadataMaxNumTokens(proto)
        out.toolCalls = llmMetadataToolCalls(proto)
        out.sampler = llmMetadataSampler(proto)
        out.reasoningHistory = llmMetadataReasoningHistory(proto)
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
 *  gives it to the LiteRT-LM engine and to no other. Vision and audio are what its header declares (its encoder
 *  sections, litertlmHeaderFromFile), false when it was not read; tool calling, the sampler and whether its template
 *  reads past reasoning are its LlmMetadata's, absent when the header says nothing. */
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
    vision: h.vision === true,
    audio: h.audio === true,
    ...(typeof h.toolCalls === 'boolean' ? { toolCalls: h.toolCalls } : {}),
    ...(h.sampler ? { sampler: h.sampler } : {}),
    ...(typeof h.reasoningHistory === 'boolean' ? { reasoningHistory: h.reasoningHistory } : {}),
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
