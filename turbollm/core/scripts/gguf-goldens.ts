// Writes, or checks, the GGUF fixtures in core/fixtures/gguf from the TypeScript parser, which is the
// oracle while the Rust port runs in shadow (rust-core plan T3; architecture 3.1-3.3). Run from turbollm/:
//   npx tsx core/scripts/gguf-goldens.ts --write    regenerate every crafted file and golden
//   npx tsx core/scripts/gguf-goldens.ts --check    regenerate in memory, exit 1 on any byte difference
// Corpus goldens (T4) come from the slices node core/scripts/fetch-gguf-corpus.mjs caches; a slice that is not
// fetched is skipped with a notice, and fails the run when CI=true.
// The oracle is parseGgufAsync (the daemon's path) and ggufCutShort; the sync parseGguf never is.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GgufError, ggufCutShort, parseGgufAsync, quantFromName } from '../../src/gguf/gguf'
import { ggufFile, ggufVocabOnly } from '../../src/test-support/gguf-file'

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gguf')
const CRAFTED_SIZE_CAP = 64 * 1024
const CORPUS_CACHE_DIR = join(FIXTURES_DIR, '.corpus-cache')
const MIN_CORPUS_ENTRIES = 15
const VOCAB_HEAVY_PREFIX = 4 * 1024 * 1024
const U32_MAX = 4_294_967_295

type Mode = 'write' | 'check'

/** A file this script owns, by its path relative to FIXTURES_DIR. */
interface Artifact {
  path: string
  content: Buffer
}

interface Golden {
  parse: string
  cutShort: Array<[number, boolean]>
}

type Divergence = { id: 'D-1' } | { id: 'D-2'; exactDataEnd: (bytes: Buffer) => bigint }

interface CraftedCase {
  id: string
  build: () => Buffer
  /** Sizes passed to ggufCutShort besides the file's own size. */
  cutShortAlsoAt?: (fileSize: number) => number[]
  divergence?: Divergence
}

interface GeneratedCase {
  id: string
  recipe: RecipeName
  args: number[]
  maxRead?: number
}

/** A corpus.json entry (architecture 3.1): a pinned prefix of a real GGUF. */
interface CorpusEntry {
  id: string
  repo: string
  revision: string
  file: string
  bytes: number
  sha256: string
  fileSize: number
}

async function main(mode: Mode): Promise<void> {
  assertCasesCoverThePlan()
  assertCorpusShape()
  const workDir = mkdtempSync(join(tmpdir(), 'turbollm-gguf-goldens-'))
  try {
    const artifacts = await renderArtifacts(workDir)
    if (mode === 'write') writeArtifacts(artifacts)
    else reportDifferences(artifacts)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function modeFrom(args: string[]): Mode {
  if (args.length === 1 && args[0] === '--write') return 'write'
  if (args.length === 1 && args[0] === '--check') return 'check'
  console.error('usage: npx tsx core/scripts/gguf-goldens.ts --write|--check')
  process.exit(2)
}

function assertCasesCoverThePlan(): void {
  const ids = new Set([...CRAFTED_CASES, ...GENERATED_CASES].map((c) => c.id))
  const missing = PLANNED_IDS.filter((id) => !ids.has(id))
  if (missing.length > 0) throw new Error(`the case table lacks planned ids: ${missing.join(', ')}`)
  if (ids.size !== CRAFTED_CASES.length + GENERATED_CASES.length) throw new Error('duplicate case id')
}

async function renderArtifacts(workDir: string): Promise<Artifact[]> {
  const artifacts: Artifact[] = []
  for (const c of CRAFTED_CASES) artifacts.push(...(await renderCrafted(c, workDir)))
  for (const c of GENERATED_CASES) artifacts.push(await renderGenerated(c, workDir))
  for (const entry of fetchedCorpus()) artifacts.push(await renderCorpus(entry))
  artifacts.push(quantNamesArtifact(), divergencesArtifact())
  return artifacts
}

function writeArtifacts(artifacts: Artifact[]): void {
  for (const a of artifacts) {
    const path = join(FIXTURES_DIR, a.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, a.content)
  }
  console.log(`wrote ${summary()}`)
}

function reportDifferences(artifacts: Artifact[]): void {
  const differences = artifacts.flatMap(differenceOf)
  for (const d of differences) console.error(d)
  console.log(`${summary()}, ${differences.length} differences`)
  if (differences.length > 0) process.exit(1)
}

function differenceOf(a: Artifact): string[] {
  const path = join(FIXTURES_DIR, a.path)
  if (!existsSync(path)) return [`missing  ${a.path}`]
  return readFileSync(path).equals(a.content) ? [] : [`differs  ${a.path}`]
}

function summary(): string {
  const corpus = `${fetchedCorpus().length} corpus` + (unfetchedCorpus().length > 0 ? ` (${unfetchedCorpus().length} not fetched)` : '')
  return `${CRAFTED_CASES.length} crafted, ${GENERATED_CASES.length} generated, ${corpus}, ${quantNameRows().length} quant names`
}

async function renderCrafted(c: CraftedCase, workDir: string): Promise<Artifact[]> {
  const bytes = c.build()
  if (bytes.length > CRAFTED_SIZE_CAP) throw new Error(`${c.id}: ${bytes.length} bytes is above the crafted cap`)
  const path = stageFile(workDir, c.id, bytes)
  const extraSizes = c.cutShortAlsoAt?.(bytes.length) ?? []
  const oracle = await runOracle(path, [bytes.length, ...extraSizes])
  const artifacts = [{ path: `crafted/${c.id}.gguf`, content: bytes }]
  if (!c.divergence) return [...artifacts, jsonArtifact(`golden/${c.id}.json`, oracle)]
  const expected = { ...oracle, parse: expectedRustParse(c.id, c.divergence, oracle.parse, bytes) }
  return [...artifacts, jsonArtifact(`golden/${c.id}.json`, expected), jsonArtifact(`golden/${c.id}.ts.json`, oracle)]
}

async function renderGenerated(c: GeneratedCase, workDir: string): Promise<Artifact> {
  const bytes = RECIPES[c.recipe](...(c.args as [number, number]))
  const path = stageFile(workDir, c.id, bytes)
  const oracle = await runOracle(path, [bytes.length], c.maxRead)
  const generated = { recipe: c.recipe, args: c.args, size: bytes.length, sha256: sha256Of(bytes) }
  const maxRead = c.maxRead === undefined ? {} : { maxRead: c.maxRead }
  return jsonArtifact(`golden/${c.id}.json`, { ...oracle, generated, ...maxRead })
}

async function renderCorpus(entry: CorpusEntry): Promise<Artifact> {
  const path = corpusSlicePath(entry)
  if (sha256Of(readFileSync(path)) !== entry.sha256) throw new Error(`${entry.id}: cached slice does not match its sha256`)
  return jsonArtifact(`golden/${entry.id}.json`, await runOracle(path, [entry.fileSize, entry.bytes]))
}

function stageFile(workDir: string, id: string, bytes: Buffer): string {
  const path = join(workDir, `${id}.gguf`)
  writeFileSync(path, bytes)
  return path
}

async function runOracle(path: string, sizes: number[], maxRead?: number): Promise<Golden> {
  const uniqueSizes = [...new Set(sizes)]
  return {
    parse: await oracleParseText(path, maxRead),
    cutShort: uniqueSizes.map((size) => [size, ggufCutShort(path, size)]),
  }
}

async function oracleParseText(path: string, maxRead?: number): Promise<string> {
  try {
    return JSON.stringify(await parseGgufAsync(path, maxRead))
  } catch (e) {
    if (!(e instanceof GgufError)) throw e
    return JSON.stringify({ error: { code: e.code, message: e.message } })
  }
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonArtifact(path: string, value: unknown): Artifact {
  return { path, content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) }
}

function quantNamesArtifact(): Artifact {
  const lines = quantNameRows().map((row) => `  ${JSON.stringify(row)}`)
  return { path: 'golden/quant-names.json', content: Buffer.from(`[\n${lines.join(',\n')}\n]\n`) }
}

function quantNameRows(): Array<[string, string | null]> {
  const fixtureNames = [...CRAFTED_CASES, ...GENERATED_CASES].map((c) => `${c.id}.gguf`)
  const corpusNames = CORPUS.map((entry) => basename(entry.file))
  const names = [...new Set([
    ...QUANT_NAMES_FROM_TESTS, ...ADVERSARIAL_QUANT_NAMES, ...fixtureNames, ...corpusNames, ...hfListingNames(),
  ])]
  return names.map((name) => {
    const quant = quantFromName(name)
    return [name, quant === '?' ? null : quant]
  })
}

/** The .gguf names of every corpus Hugging Face repo at its pinned revision (hf-listing.json). */
function hfListingNames(): string[] {
  const listingPath = join(FIXTURES_DIR, 'hf-listing.json')
  if (!existsSync(listingPath)) return []
  const listing = JSON.parse(readFileSync(listingPath, 'utf8')) as Record<string, string[]>
  return Object.values(listing).flat().map((file) => basename(file))
}

function readCorpus(): CorpusEntry[] {
  const corpusPath = join(FIXTURES_DIR, 'corpus.json')
  return existsSync(corpusPath) ? (JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusEntry[]) : []
}

function corpusSlicePath(entry: CorpusEntry): string {
  return join(CORPUS_CACHE_DIR, `${entry.id}.gguf`)
}

function fetchedCorpus(): CorpusEntry[] {
  return CORPUS.filter((entry) => existsSync(corpusSlicePath(entry)))
}

function unfetchedCorpus(): CorpusEntry[] {
  return CORPUS.filter((entry) => !existsSync(corpusSlicePath(entry)))
}

function assertCorpusShape(): void {
  if (CORPUS.length < MIN_CORPUS_ENTRIES) throw new Error(`corpus.json has ${CORPUS.length} entries, want at least ${MIN_CORPUS_ENTRIES}`)
  const pinnedBadly = CORPUS.filter((entry) => !/^[0-9a-f]{40}$/.test(entry.revision)).map((entry) => entry.id)
  if (pinnedBadly.length > 0) throw new Error(`not pinned to a full commit sha: ${pinnedBadly.join(', ')}`)
  if (!CORPUS.some((entry) => entry.bytes > VOCAB_HEAVY_PREFIX)) throw new Error('no corpus entry is above 4 MiB')
  const ids = new Set([...CRAFTED_CASES, ...GENERATED_CASES, ...CORPUS].map((c) => c.id))
  if (ids.size !== CRAFTED_CASES.length + GENERATED_CASES.length + CORPUS.length) throw new Error('duplicate fixture id')
  reportUnfetchedCorpus()
}

function reportUnfetchedCorpus(): void {
  const missing = unfetchedCorpus().map((entry) => entry.id)
  if (missing.length === 0) return
  console.error(`corpus slices not fetched (run node core/scripts/fetch-gguf-corpus.mjs): ${missing.join(', ')}`)
  if (process.env.CI === 'true') throw new Error('a missing corpus fails in CI')
}

function divergencesArtifact(): Artifact {
  const entries = CRAFTED_CASES.flatMap((c) => (c.divergence ? [[c.id, c.divergence.id]] : []))
  return jsonArtifact('divergences.json', Object.fromEntries(entries))
}

function expectedRustParse(id: string, divergence: Divergence, tsParse: string, bytes: Buffer): string {
  if (tsParse.startsWith('{"error"')) throw new Error(`${id}: a declared divergence needs a successful parse`)
  return divergence.id === 'D-1' ? saturateIntegerFields(tsParse) : withExactDataEnd(id, tsParse, divergence.exactDataEnd(bytes))
}

const U32_FIELDS = [
  'nativeCtx', 'blockCount', 'embedLen', 'headCountKv', 'headDim', 'expertCount', 'nextnLayers', 'slidingWindow',
  'headDimSwa', 'fullAttentionInterval', 'ssmInnerSize', 'ssmStateSize', 'ssmConvKernel',
]

function saturateIntegerFields(tsParse: string): string {
  const meta = JSON.parse(tsParse) as Record<string, unknown>
  for (const field of U32_FIELDS) meta[field] = saturateU32(meta[field] as number)
  meta.headCountKvPerLayer = (meta.headCountKvPerLayer as number[]).map(saturateU32)
  return JSON.stringify(meta)
}

function saturateU32(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), U32_MAX)
}

function withExactDataEnd(id: string, tsParse: string, exact: bigint): string {
  const trailingDataEnd = /"dataEnd":[^,}]+}$/
  if (!trailingDataEnd.test(tsParse)) throw new Error(`${id}: dataEnd is not the last field`)
  return tsParse.replace(trailingDataEnd, `"dataEnd":${exact}}`)
}

const T_UINT8 = 0, T_INT8 = 1, T_UINT16 = 2, T_INT16 = 3, T_UINT32 = 4, T_INT32 = 5, T_FLOAT32 = 6,
  T_BOOL = 7, T_STRING = 8, T_ARRAY = 9, T_UINT64 = 10, T_INT64 = 11, T_FLOAT64 = 12
const GGUF_MAGIC = 0x46554747
const F32_TENSOR = 0

function encoded(size: number, write: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(size)
  write(b)
  return b
}

const le = {
  u8: (n: number) => encoded(1, (b) => b.writeUInt8(n)),
  i8: (n: number) => encoded(1, (b) => b.writeInt8(n)),
  u16: (n: number) => encoded(2, (b) => b.writeUInt16LE(n)),
  i16: (n: number) => encoded(2, (b) => b.writeInt16LE(n)),
  u32: (n: number) => encoded(4, (b) => b.writeUInt32LE(n)),
  i32: (n: number) => encoded(4, (b) => b.writeInt32LE(n)),
  f32: (n: number) => encoded(4, (b) => b.writeFloatLE(n)),
  u64: (n: number | bigint) => encoded(8, (b) => b.writeBigUInt64LE(BigInt(n))),
  i64: (n: number | bigint) => encoded(8, (b) => b.writeBigInt64LE(BigInt(n))),
  f64: (n: number) => encoded(8, (b) => b.writeDoubleLE(n)),
  str: (s: string | Buffer) => {
    const body = typeof s === 'string' ? Buffer.from(s, 'utf8') : s
    return Buffer.concat([le.u64(body.length), body])
  },
}

/** A KV value as it follows its key: the type id, then the payload. */
const value = {
  u8: (n: number) => typed(T_UINT8, le.u8(n)),
  i8: (n: number) => typed(T_INT8, le.i8(n)),
  u16: (n: number) => typed(T_UINT16, le.u16(n)),
  i16: (n: number) => typed(T_INT16, le.i16(n)),
  u32: (n: number) => typed(T_UINT32, le.u32(n)),
  i32: (n: number) => typed(T_INT32, le.i32(n)),
  f32: (n: number) => typed(T_FLOAT32, le.f32(n)),
  bool: (v: boolean) => typed(T_BOOL, le.u8(v ? 1 : 0)),
  str: (s: string | Buffer) => typed(T_STRING, le.str(s)),
  u64: (n: number | bigint) => typed(T_UINT64, le.u64(n)),
  i64: (n: number | bigint) => typed(T_INT64, le.i64(n)),
  f64: (n: number) => typed(T_FLOAT64, le.f64(n)),
  array: (elementType: number, elements: Buffer[]) =>
    typed(T_ARRAY, Buffer.concat([le.u32(elementType), le.u64(elements.length), ...elements])),
  ofType: (type: number, payload: Buffer = Buffer.alloc(0)) => typed(type, payload),
}

function typed(type: number, payload: Buffer): Buffer {
  return Buffer.concat([le.u32(type), payload])
}

type Kv = [key: string | Buffer, value: Buffer]

interface TensorInfo {
  name: string
  dims: Array<number | bigint>
  type: number
  offset: number | bigint
}

/** A GGUF header with no tensor data after it: magic, version, counts, the KV pairs, the tensor infos. */
function ggufHeader(kvs: Kv[], tensors: TensorInfo[] = [], version = 3): Buffer {
  return Buffer.concat([
    le.u32(GGUF_MAGIC), le.u32(version), le.u64(tensors.length), le.u64(kvs.length),
    ...kvs.flatMap(([key, v]) => [le.str(key), v]),
    ...tensors.map(tensorInfoBytes),
  ])
}

function tensorInfoBytes(t: TensorInfo): Buffer {
  return Buffer.concat([le.str(t.name), le.u32(t.dims.length), ...t.dims.map(le.u64), le.u32(t.type), le.u64(t.offset)])
}

/** gguf.test.ts's buildGguf: tensorCount 0 and KV values typed by their JS shape. */
type TestKvValue = string | number | number[] | boolean[]

function buildGguf(kvs: Array<[string, TestKvValue]>): Buffer {
  return ggufHeader(kvs.map(([key, v]) => [key, testKvValue(v)]))
}

function testKvValue(v: TestKvValue): Buffer {
  if (typeof v === 'string') return value.str(v)
  if (typeof v === 'number') return value.u32(v)
  if (typeof v[0] === 'boolean') return value.array(T_BOOL, (v as boolean[]).map((b) => le.u8(b ? 1 : 0)))
  return value.array(T_UINT32, (v as number[]).map(le.u32))
}

function cycle<T>(period: T[], layers: number): T[] {
  return Array.from({ length: layers }, (_, i) => period[i % period.length])
}

/** gguf.test.ts's bigVocabGguf: scalar and per-layer metadata, a chat template, vocab-sized arrays, two
 *  tensor infos, then a megabyte of zeros standing in for tensor data. */
function bigVocabGguf(tokens: number, merges: number): Buffer {
  const strings = (n: number, text: (i: number) => string) => Array.from({ length: n }, (_, i) => le.str(text(i)))
  const kvs: Kv[] = [
    ['general.architecture', value.str('gemma4')],
    ['general.name', value.str('Big Vocab')],
    ['general.file_type', value.u32(15)],
    ['gemma4.block_count', value.u32(30)],
    ['gemma4.attention.head_count_kv', value.array(T_UINT32, [8, 2, 8].map(le.u32))],
    ['gemma4.attention.sliding_window_pattern', value.array(T_BOOL, [1, 0, 1].map(le.u8))],
    ['tokenizer.chat_template', value.str('{% if reasoning_effort %}x{% endif %}')],
    ['tokenizer.ggml.tokens', value.array(T_STRING, strings(tokens, (i) => `▁tok${i}é`))],
    ['tokenizer.ggml.scores', typed(T_ARRAY, Buffer.concat([le.u32(T_FLOAT32), le.u64(tokens), Buffer.alloc(tokens * 4)]))],
    ['tokenizer.ggml.merges', value.array(T_STRING, strings(merges, (i) => `a${i} b${i}`))],
    ['gemma4.embedding_length', value.u32(2048)],
  ]
  const tensors = [
    { name: 'token_embd.weight', dims: [2048, 64], type: F32_TENSOR, offset: 0 },
    { name: 'output.weight', dims: [100], type: F32_TENSOR, offset: 524288 },
  ]
  const header = ggufHeader(kvs, tensors)
  return Buffer.concat([header], header.length + 1_000_000)
}

const RECIPES = {
  'big-vocab': (tokens: number, merges: number) => bigVocabGguf(tokens, merges),
  'huge-description': (length: number) =>
    ggufFile([{ name: 'a', dims: [10], type: F32_TENSOR }], [
      ['general.architecture', 'llama'], ['general.description', 'x'.repeat(length)], ['llama.block_count', 7],
    ]),
  'long-name': (length: number) =>
    ggufVocabOnly([['general.architecture', 'llama'], ['general.name', 'n'.repeat(length)]]),
}
type RecipeName = keyof typeof RECIPES

const TWO_TENSORS = [
  { name: 'a', dims: [10], type: F32_TENSOR },
  { name: 'b', dims: [32, 2], type: 8 },
]
const ONE_BIG_TENSOR = [{ name: 'token_embd.weight', dims: [4096], type: F32_TENSOR }]
const VOCAB_ONLY_KVS: Array<[string, string]> = [['general.architecture', 'llama'], ['tokenizer.ggml.model', 'gpt2']]
const ALIGNMENT_PROBE_TENSORS: TensorInfo[] = [{ name: 'a', dims: [10], type: F32_TENSOR, offset: 0 }]
const BEYOND_DOUBLE_PRECISION = 2n ** 53n + 1n

function dataEndUnknownType(): Buffer {
  const bytes = ggufFile([{ name: 'a', dims: [10], type: F32_TENSOR }])
  const typeAt = bytes.indexOf(Buffer.from([0x0a, 0, 0, 0, 0, 0, 0, 0]), 24) + 8
  bytes.writeUInt32LE(999, typeAt)
  return bytes
}

function cutShortTensors(): Buffer {
  return ggufFile(ONE_BIG_TENSOR, [['general.architecture', 'llama']])
}

function declaredHugeString(): Buffer {
  return Buffer.concat([ggufHeaderPrefix(1), le.str('general.name'), le.u32(T_STRING), le.u64(20 * 1024 ** 3), Buffer.alloc(64)])
}

function ggufHeaderPrefix(kvCount: number): Buffer {
  return Buffer.concat([le.u32(GGUF_MAGIC), le.u32(3), le.u64(0), le.u64(kvCount)])
}

function versioned(version: number): Buffer {
  return ggufHeader([['general.architecture', value.str('llama')]], [], version)
}

/** A key of the given value type that the parser skips, then a key it reads, to show the skip kept its place. */
function skippedValueOfType(skipped: Buffer): Buffer {
  return ggufHeader([
    ['general.architecture', value.str('llama')],
    ['x.skipped', skipped],
    ['llama.block_count', value.u32(7)],
  ])
}

const SAMPLE_OF_TYPE: Buffer[] = [
  value.u8(200), value.i8(-7), value.u16(60000), value.i16(-300), value.u32(4_000_000_000), value.i32(-123456),
  value.f32(1.5), value.bool(true), value.str('skipped text'), value.array(T_UINT32, [1, 2, 3].map(le.u32)),
  value.u64(2n ** 40n), value.i64(-(2n ** 40n)), value.f64(-2.25),
]

function withAlignment(alignment: Buffer): Buffer {
  return ggufHeader([['general.architecture', value.str('llama')], ['general.alignment', alignment]], ALIGNMENT_PROBE_TENSORS)
}

function withFileType(fileType: Buffer): Buffer {
  return ggufHeader([['general.architecture', value.str('llama')], ['general.file_type', fileType]])
}

function nDims5(): Buffer {
  return ggufHeader([['general.architecture', value.str('llama')]], [
    { name: 'five', dims: [2, 2, 2, 2, 2], type: F32_TENSOR, offset: 0 },
  ])
}

function nestedArray(): Buffer {
  const inner = value.array(T_UINT32, [1, 2].map(le.u32)).subarray(4)
  return skippedValueOfType(value.array(T_ARRAY, [inner, inner]))
}

function tooLargeString(): Buffer {
  return Buffer.concat([ggufHeaderPrefix(1), le.str('general.name'), le.u32(T_STRING), le.u64(2n ** 60n), Buffer.alloc(64)])
}

function cutAt(bytes: Buffer, length: number): Buffer {
  return Buffer.from(bytes.subarray(0, length))
}

const D2_TENSORS: TensorInfo[] = [
  { name: 'near', dims: [1], type: F32_TENSOR, offset: 0 },
  { name: 'far', dims: [3], type: F32_TENSOR, offset: BEYOND_DOUBLE_PRECISION },
]
const Q4_0_TENSOR = 2
const ELEMENTS_ABOVE_2P128: Record<string, bigint[]> = {
  'd2-elements-2p150': [2n ** 50n, 2n ** 50n, 2n ** 50n],
  'd2-elements-2p130': [2n ** 50n, 2n ** 50n, 2n ** 30n],
}
const BLOCK_SIZES: Record<number, [elements: bigint, bytes: bigint]> = { [F32_TENSOR]: [1n, 4n], [Q4_0_TENSOR]: [32n, 18n] }
const U64_MAX = 2n ** 64n - 1n

function elementsAbove2p128(id: string): TensorInfo[] {
  return [{ name: 'huge', dims: ELEMENTS_ABOVE_2P128[id], type: Q4_0_TENSOR, offset: 0 }]
}

/** dataEnd by gguf.ts's formula in exact integers, for a header-only file at alignment 32 whose every tensor is
 *  a whole number of blocks; saturated to the u64 the Rust field holds (D-2). */
function exactDataEnd(headerEnd: number, tensors: TensorInfo[]): bigint {
  const alignment = 32n
  const dataStart = ((BigInt(headerEnd) + alignment - 1n) / alignment) * alignment
  const end = dataStart + tensors.map(exactTensorEnd).reduce((max, end) => (end > max ? end : max), 0n)
  return end > U64_MAX ? U64_MAX : end
}

function exactTensorEnd(t: TensorInfo): bigint {
  const [elementsPerBlock, bytesPerBlock] = BLOCK_SIZES[t.type]
  const elements = t.dims.reduce<bigint>((n, d) => n * BigInt(d), 1n)
  return BigInt(t.offset) + (elements / elementsPerBlock) * bytesPerBlock
}

const BOGUS_NAME_CASES: Array<[string, string]> = [
  ['gguf', 'GGUF'], ['pytorch', 'PyTorch'], ['pytorch-model', 'pytorch_model'], ['bin', 'BIN'],
  ['checkpoint', 'Checkpoint'], ['onnx', 'onnx'], ['upper', 'SAFETENSORS'], ['nonascii', 'ChecKpoint'],
]

const CRAFTED_CASES: CraftedCase[] = [
  { id: 'headdim-key-length', build: () => buildGguf([
    ['general.architecture', 'qwen3'], ['qwen3.block_count', 65], ['qwen3.embedding_length', 4096],
    ['qwen3.attention.head_count_kv', 8], ['qwen3.attention.key_length', 256],
  ]) },
  { id: 'headdim-value-length-fallback', build: () => buildGguf([
    ['general.architecture', 'qwen3'], ['qwen3.attention.value_length', 128],
  ]) },
  { id: 'headdim-absent', build: () => buildGguf([['general.architecture', 'llama']]) },
  { id: 'hybrid-ssm-qwen35', build: () => buildGguf([
    ['general.architecture', 'qwen35'], ['qwen35.block_count', 64], ['qwen35.attention.head_count_kv', 4],
    ['qwen35.attention.key_length', 256], ['qwen35.attention.value_length', 256], ['qwen35.full_attention_interval', 4],
    ['qwen35.ssm.conv_kernel', 4], ['qwen35.ssm.state_size', 128], ['qwen35.ssm.inner_size', 6144],
    ['qwen35.ssm.group_count', 16], ['qwen35.ssm.time_step_rank', 48],
  ]) },
  { id: 'hybrid-ssm-undeclared', build: () => buildGguf([
    ['general.architecture', 'qwen3next'], ['qwen3next.block_count', 48], ['qwen3next.attention.head_count_kv', 2],
    ['qwen3next.attention.key_length', 256], ['qwen3next.ssm.conv_kernel', 4], ['qwen3next.ssm.state_size', 128],
    ['qwen3next.ssm.inner_size', 4096],
  ]) },
  { id: 'swa-per-layer-kv', build: () => buildGguf([
    ['general.architecture', 'gemma4'], ['gemma4.block_count', 30],
    ['gemma4.attention.head_count_kv', cycle([8, 8, 8, 8, 8, 2], 30)], ['gemma4.attention.key_length', 512],
    ['gemma4.attention.value_length', 512], ['gemma4.attention.sliding_window', 1024],
    ['gemma4.attention.sliding_window_pattern', cycle([true, true, true, true, true, false], 30)],
    ['gemma4.attention.key_length_swa', 256], ['gemma4.attention.value_length_swa', 256],
  ]) },
  { id: 'swa-scalar-kv', build: () => buildGguf([
    ['general.architecture', 'gemma4'], ['gemma4.block_count', 42], ['gemma4.attention.head_count_kv', 2],
    ['gemma4.attention.key_length', 512], ['gemma4.attention.sliding_window', 512],
    ['gemma4.attention.sliding_window_pattern', cycle([true, true, true, true, true, false], 42)],
    ['gemma4.attention.key_length_swa', 256],
  ]) },
  { id: 'headdim-swa-value-fallback', build: () => buildGguf([
    ['general.architecture', 'gemma4'], ['gemma4.attention.value_length_swa', 256],
  ]) },
  { id: 'key-length-swa-no-leak', build: () => buildGguf([
    ['general.architecture', 'gemma4'], ['gemma4.attention.key_length', 512], ['gemma4.attention.key_length_swa', 256],
  ]) },
  { id: 'swa-scalar-pattern', build: () => buildGguf([
    ['general.architecture', 'gemma3'], ['gemma3.block_count', 26], ['gemma3.attention.sliding_window', 1024],
    ['gemma3.attention.sliding_window_pattern', 6], ['gemma3.attention.head_count_kv', 4],
    ['gemma3.attention.key_length', 256],
  ]) },
  { id: 'dense-no-layout', build: () => buildGguf([
    ['general.architecture', 'llama'], ['general.name', 'Plain Dense'], ['llama.block_count', 32],
    ['llama.context_length', 8192], ['llama.embedding_length', 4096], ['llama.attention.head_count_kv', 8],
    ['llama.attention.key_length', 128],
  ]) },
  { id: 'template-reasoning-effort', build: () => buildGguf([
    ['general.architecture', 'qwen35'],
    ['tokenizer.chat_template', "{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}"],
  ]) },
  { id: 'template-no-reasoning-effort', build: () => buildGguf([
    ['general.architecture', 'qwen35'],
    ['tokenizer.chat_template', '{%- if enable_thinking is undefined or enable_thinking is true %}...{%- endif %}'],
  ]) },
  { id: 'template-absent', build: () => buildGguf([['general.architecture', 'llama']]) },
  { id: 'bogus-name-safetensors', build: () => buildGguf([
    ['general.architecture', 'qwen35moe'], ['general.name', 'Safetensors'],
  ]) },
  ...BOGUS_NAME_CASES.map(([suffix, name]) => ({
    id: `bogus-name-${suffix}`, build: () => buildGguf([['general.name', name]]),
  })),
  { id: 'name-contains-format-word', build: () => buildGguf([['general.name', 'Safetensors Finetune 7B']]) },
  { id: 'data-end-aligned', build: () => ggufFile(TWO_TENSORS, [['general.architecture', 'llama']]) },
  { id: 'data-end-aligned-256', build: () => ggufFile(TWO_TENSORS, [['general.alignment', 256]], 256) },
  { id: 'data-end-unknown-type', build: dataEndUnknownType },
  { id: 'cut-short-tensors', build: cutShortTensors, cutShortAlsoAt: (size) => [size - 1000, 60] },
  { id: 'cut-short-tensors-short', build: () => cutAt(cutShortTensors(), cutShortTensors().length - 1000) },
  { id: 'cut-short-in-tensor-info', build: () => cutAt(cutShortTensors(), 60) },
  { id: 'cut-short-not-gguf', build: () => Buffer.from('<html>not found</html>') },
  { id: 'vocab-only-unaligned', build: () => ggufVocabOnly(VOCAB_ONLY_KVS), cutShortAlsoAt: (size) => [size - 3] },
  { id: 'vocab-only-cut', build: () => cutAt(ggufVocabOnly(VOCAB_ONLY_KVS), ggufVocabOnly(VOCAB_ONLY_KVS).length - 3) },
  { id: 'async-qwen3', build: () => buildGguf([
    ['general.architecture', 'qwen3'], ['qwen3.block_count', 65], ['qwen3.attention.key_length', 256],
  ]) },
  { id: 'async-gemma3-arrays', build: () => buildGguf([
    ['general.architecture', 'gemma3'], ['gemma3.attention.sliding_window_pattern', [true, false, true]],
    ['gemma3.attention.head_count_kv', [8, 2, 8]],
  ]) },
  { id: 'async-tensors', build: () => ggufFile(TWO_TENSORS, [['general.architecture', 'llama']]) },
  { id: 'async-alignment-256', build: () => ggufFile([{ name: 'a', dims: [10], type: F32_TENSOR }], [['general.alignment', 256]], 256) },
  { id: 'async-vocab-only', build: () => ggufVocabOnly(VOCAB_ONLY_KVS) },
  { id: 'err-not-gguf-html', build: () => Buffer.from('<html>not found</html>, long enough to read a header from') },
  { id: 'err-truncated-in-vocab', build: () => cutAt(bigVocabGguf(2000, 2000), 40_000) },
  { id: 'err-bad-version-9', build: () => Buffer.concat([Buffer.from('GGUF'), Buffer.from([9, 0, 0, 0]), Buffer.alloc(32)]) },
  { id: 'declared-huge-string', build: declaredHugeString },

  { id: 'trunc-magic', build: () => Buffer.from('GG') },
  { id: 'trunc-version', build: () => Buffer.concat([le.u32(GGUF_MAGIC), Buffer.from([3, 0])]) },
  { id: 'trunc-kv', build: () => {
    const whole = buildGguf([['general.architecture', 'llama'], ['general.name', 'Truncated Inside The Value']])
    return cutAt(whole, whole.length - 10)
  } },
  { id: 'trunc-tensor-info', build: () => {
    const whole = cutShortTensors()
    return cutAt(whole, whole.indexOf('token_embd.weight') + 5)
  } },
  ...[1, 2, 3, 4].map((v) => ({ id: `version-${v}`, build: () => versioned(v) })),
  ...SAMPLE_OF_TYPE.map((sample, type) => ({ id: `type-${type}`, build: () => skippedValueOfType(sample) })),
  { id: 'nested-array', build: nestedArray },
  { id: 'array-as-scalar', build: () => ggufHeader([['general.architecture', value.array(T_STRING, [le.str('llama')])]]) },
  { id: 'unknown-type-13', build: () => skippedValueOfType(value.ofType(13)) },
  { id: 'unknown-type-255', build: () => skippedValueOfType(value.ofType(255)) },
  { id: 'string-as-number', build: () => ggufHeader([
    ['general.architecture', value.str('llama')], ['llama.context_length', value.str('8192')],
    ['llama.block_count', value.str('abc')], ['llama.embedding_length', value.str(' 4096 ')],
  ]) },
  { id: 'number-as-string', build: () => ggufHeader([
    ['general.architecture', value.u32(7)], ['general.name', value.f32(1.5)], ['general.size_label', value.bool(true)],
  ]) },
  { id: 'ftype-empty', build: () => withFileType(value.str('')) },
  { id: 'ftype-str-15', build: () => withFileType(value.str('15')) },
  { id: 'ftype-hex', build: () => withFileType(value.str('0x0F')) },
  { id: 'ftype-neg-zero', build: () => withFileType(value.f32(-0)) },
  { id: 'ftype-1-5', build: () => withFileType(value.f32(1.5)) },
  { id: 'align-0', build: () => withAlignment(value.u32(0)) },
  { id: 'align-3', build: () => withAlignment(value.u32(3)) },
  { id: 'align-2p32', build: () => withAlignment(value.u64(2n ** 32n)) },
  { id: 'align-string', build: () => withAlignment(value.str('64')) },
  { id: 'ndims-5', build: nDims5 },
  { id: 'tensor-type-unknown', build: () => ggufHeader([['general.architecture', value.str('llama')]], [
    { name: 'removed-type', dims: [32], type: 4, offset: 0 },
  ]) },
  { id: 'too-large-string', build: tooLargeString },
  { id: 'invalid-utf8-key', build: () => ggufHeader([
    ['general.architecture', value.str('llama')],
    [Buffer.concat([Buffer.from('lla'), Buffer.from([0xff]), Buffer.from('ma.block_count')]), value.u32(12)],
  ]) },
  { id: 'invalid-utf8-value', build: () => ggufHeader([
    ['general.architecture', value.str('llama')],
    ['general.name', value.str(Buffer.concat([
      Buffer.from('Bad'), Buffer.from([0xff, 0xe2, 0x82]), Buffer.from('Name'), Buffer.from([0xf0, 0x9f]),
    ]))],
  ]) },
  { id: 'duplicate-key-last-wins', build: () => ggufHeader([
    ['general.architecture', value.str('llama')], ['general.name', value.str('First')], ['llama.block_count', value.u32(10)],
    ['general.name', value.str('Second')], ['llama.block_count', value.u32(20)],
  ]) },
  { id: 'd1-float-in-int-key', divergence: { id: 'D-1' }, build: () => ggufHeader([
    ['general.architecture', value.str('llama')], ['llama.context_length', value.f32(4096.5)],
    ['llama.attention.head_count_kv', value.array(T_FLOAT32, [8.5, 2.25].map(le.f32))],
    ['llama.attention.key_length', value.f64(128.75)],
  ]) },
  { id: 'd1-negative-in-int-key', divergence: { id: 'D-1' }, build: () => ggufHeader([
    ['general.architecture', value.str('llama')], ['llama.block_count', value.i32(-5)],
    ['llama.attention.head_count_kv', value.array(T_INT32, [8, -2, 8].map(le.i32))],
  ]) },
  { id: 'd1-above-u32', divergence: { id: 'D-1' }, build: () => ggufHeader([
    ['general.architecture', value.str('llama')], ['llama.context_length', value.u64(2n ** 33n)],
    ['llama.embedding_length', value.u64(2n ** 32n + 7n)], ['llama.attention.sliding_window', value.i64(2n ** 40n)],
    ['llama.attention.head_count_kv', value.array(T_UINT64, [2n ** 32n, 4n].map(le.u64))],
  ]) },
  { id: 'd2-offset-above-2p53',
    divergence: { id: 'D-2', exactDataEnd: (bytes) => exactDataEnd(bytes.length, D2_TENSORS) },
    build: () => ggufHeader([['general.architecture', value.str('llama')]], D2_TENSORS) },
  ...Object.keys(ELEMENTS_ABOVE_2P128).map((id): CraftedCase => ({ id,
    divergence: { id: 'D-2', exactDataEnd: (bytes) => exactDataEnd(bytes.length, elementsAbove2p128(id)) },
    build: () => ggufHeader([['general.architecture', value.str('llama')]], elementsAbove2p128(id)) })),
]

const GENERATED_CASES: GeneratedCase[] = [
  { id: 'gen-big-vocab', recipe: 'big-vocab', args: [60_000, 90_000] },
  { id: 'gen-huge-description', recipe: 'huge-description', args: [40 * 1024 * 1024] },
  { id: 'gen-long-name', recipe: 'long-name', args: [3 * 1024 * 1024], maxRead: 1024 * 1024 },
]

/** Every id plan section 3 names: the 33 gguf.test.ts rows, then the architecture 3.1 additions. */
const PLANNED_IDS = [
  'headdim-key-length', 'headdim-value-length-fallback', 'headdim-absent', 'hybrid-ssm-qwen35',
  'hybrid-ssm-undeclared', 'swa-per-layer-kv', 'swa-scalar-kv', 'headdim-swa-value-fallback', 'key-length-swa-no-leak',
  'swa-scalar-pattern', 'dense-no-layout', 'template-reasoning-effort', 'template-no-reasoning-effort',
  'template-absent', 'bogus-name-safetensors', 'bogus-name-gguf', 'bogus-name-pytorch', 'bogus-name-pytorch-model',
  'bogus-name-bin', 'bogus-name-checkpoint', 'bogus-name-onnx', 'bogus-name-upper', 'name-contains-format-word',
  'data-end-aligned', 'data-end-unknown-type', 'cut-short-tensors', 'vocab-only-unaligned', 'vocab-only-cut',
  'gen-big-vocab', 'async-qwen3', 'async-gemma3-arrays', 'async-tensors', 'async-alignment-256', 'async-vocab-only',
  'err-not-gguf-html', 'err-truncated-in-vocab', 'err-bad-version-9', 'gen-huge-description', 'gen-long-name',
  'declared-huge-string',
  'trunc-magic', 'trunc-version', 'trunc-kv', 'trunc-tensor-info', 'version-1', 'version-2', 'version-3', 'version-4',
  ...Array.from({ length: 13 }, (_, type) => `type-${type}`),
  'nested-array', 'array-as-scalar', 'unknown-type-13', 'unknown-type-255', 'string-as-number', 'number-as-string',
  'ftype-empty', 'ftype-str-15', 'ftype-hex', 'ftype-neg-zero', 'ftype-1-5', 'align-0', 'align-3', 'align-2p32',
  'align-string', 'ndims-5', 'tensor-type-unknown', 'too-large-string', 'invalid-utf8-key', 'invalid-utf8-value',
  'bogus-name-nonascii', 'duplicate-key-last-wins', 'd1-float-in-int-key', 'd1-negative-in-int-key', 'd1-above-u32',
  'd2-offset-above-2p53', 'd2-elements-2p150', 'd2-elements-2p130',
]

/** gguf.test.ts rows 18-23 (quantFromName). */
const QUANT_NAMES_FROM_TESTS = [
  'llama-3-8b-instruct-Q4_K_M.gguf', 'model-IQ3_XS.gguf', 'model-F16.gguf',
  'Qwen3.6-35B-A3B-APEX-MTP-Balanced.gguf', 'Qwen3.6-35B-A3B-APEX-MTP-Compact.gguf',
  'Qwen3.6-35B-A3B-APEX-MTP-I-Balanced.gguf', 'Qwen3.6-35B-A3B-APEX-MTP-I-Compact.gguf',
  'Qwen3.6-35B-A3B-APEX-MTP-I-Mini.gguf', 'Qwen3.6-35B-A3B-APEX-MTP-I-Nano.gguf',
  'Qwen3.6-35B-A3B-APEX-MTP-I-Quality.gguf', 'Qwen3.6-35B-A3B-APEX-MTP-Quality.gguf',
  'model-apex-i-quality.gguf', 'model-apex-mini.gguf', 'random-model-name.gguf',
  'flan-t5-seq2seq-base-Q8_0.gguf', 'model-2025Q4-release-Q8_0.gguf', 'Q2.5-Veltha-14B-Q4_K_M.gguf',
  'model-Q4_K_XL-00001-of-00002.gguf', 'model.Q5_K_M.gguf', 'model-q4_0.gguf',
]

const APEX_TIERS = ['Nano', 'Mini', 'Compact', 'Balanced', 'Quality']

const ADVERSARIAL_QUANT_NAMES = [
  'flan-t5-seq2seq-base.gguf', 'seq2seq.gguf', 'model-2024-05-01.gguf', 'model-2025Q4-release.gguf',
  'Q2.5-7B-Q4_K_M.gguf', 'Q2.5-7B.gguf', 'x-Q4_K_M_ab+.gguf', 'x-Q4_K_M_ab.gguf', 'model-Q4_K_M.gguf',
  'model-Q4_K_M', 'Q8_0', '', '.gguf', 'model Q5_K_S.gguf', 'Model-BF16.gguf', 'model-bf16.gguf', 'model-f32.gguf',
  'model-IQ2_XXS-00001-of-00003.gguf', 'model-iq4_nl.gguf', 'model-UD-Q4_K_XL.gguf', 'model-Q4_K_M.gguf.part',
  'model-Q4-K-M.gguf', 'model_Q6_K.gguf', 'model-Q4_K_M-Q8_0.gguf', 'model-Q10_K.gguf', 'model-Q4_.gguf',
  'model-IQ.gguf', 'model-F16x.gguf', 'model-xF16.gguf',
  ...APEX_TIERS.flatMap((tier) => [`m-APEX-${tier}.gguf`, `m-APEX-I-${tier}.gguf`, `m-apex-i-${tier.toLowerCase()}.gguf`]),
  'APEX-Quality.gguf', 'm-APEX-a-b-c-Quality.gguf', 'm-APEX-a-b-c-d-Quality.gguf', 'm-APEX-QualityX.gguf',
  'm-APEX-Quality-Q4_K_M.gguf', 'm-APEX-I-Quality', 'm-APEXQuality.gguf', 'm-APEX-I-I-Nano.gguf',
]

const CORPUS = readCorpus()

await main(modeFrom(process.argv.slice(2)))
