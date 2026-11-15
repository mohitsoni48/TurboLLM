// rust-core plan T12 (arch 3.2 "Differential", 3.3, B-2, B-10). Shadow-only: while src/gguf/gguf.ts still
// exists, the TypeScript parser and the native core must agree on seeded mutations of every crafted and corpus
// header and on generated file names. A difference not declared in arch 3.3 fails the test.
import assert from 'node:assert/strict'
import fs, { closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import * as oracle from '../gguf/gguf'
import { tmpDir } from '../test-support/tmp'
import * as native from './gguf'

const SEED = 0x7e12c0de
const MUTATED_HEADERS = 5_000
const GENERATED_NAMES = 20_000
const REPORTED_DIFFERENCES = 20

const FIXTURES = join(import.meta.dirname, '..', '..', 'core', 'fixtures', 'gguf')
const CORPUS_CACHE = join(FIXTURES, '.corpus-cache')
const U32_MAX = 4294967295
const NATIVE_POSITION_OUT_OF_RANGE = 'position out of range'
const U32_FIELDS = [
  'nativeCtx', 'blockCount', 'embedLen', 'headCountKv', 'headDim', 'expertCount', 'nextnLayers', 'slidingWindow',
  'headDimSwa', 'fullAttentionInterval', 'ssmInnerSize', 'ssmStateSize', 'ssmConvKernel',
] as const

test('the TypeScript parser and the native core agree on mutated headers and generated names', { timeout: 600_000 }, async (t) => {
  const tally: Tally = { undeclared: [], declared: new Map() }
  const random = mulberry32(SEED)
  const sources = loadSources(t)
  const workDir = tmpDir('gguf-parity-')
  const staged = stageSources(sources, workDir)
  for (let index = 0; index < MUTATED_HEADERS; index++) {
    const source = pick(random, staged)
    await compareMutation(source, mutate(random, source, index), workDir, tally)
  }
  for (let index = 0; index < GENERATED_NAMES; index++) compareQuantName(generatedName(random), tally)
  report(t, tally)
  assert.deepEqual(tally.undeclared.slice(0, REPORTED_DIFFERENCES), [], `${tally.undeclared.length} undeclared`)
})

interface Tally {
  undeclared: string[]
  declared: Map<string, number>
}

interface HeaderSource {
  id: string
  bytes: Buffer
  sites: HeaderSites
}

interface StagedSource extends HeaderSource {
  path: string
}

interface HeaderSites {
  typeFields: number[]
  lengthFields: Array<{ offset: number; width: 4 | 8 }>
  headerEnd: number
}

type Mutation =
  | { label: string; patch: { offset: number; bytes: Buffer } }
  | { label: string; truncateTo: number }

async function compareMutation(source: StagedSource, mutation: Mutation, workDir: string, tally: Tally) {
  if ('truncateTo' in mutation) {
    const path = join(workDir, 'truncated.gguf')
    writeFileSync(path, source.bytes.subarray(0, mutation.truncateTo))
    await compareFile(path, mutation.truncateTo, `${source.id} ${mutation.label}`, tally)
    return
  }
  const { offset, bytes } = mutation.patch
  overwrite(source.path, offset, bytes)
  try {
    await compareFile(source.path, source.bytes.length, `${source.id} ${mutation.label}`, tally)
  } finally {
    overwrite(source.path, offset, source.bytes.subarray(offset, offset + bytes.length))
  }
}

async function compareFile(path: string, size: number, label: string, tally: Tally): Promise<void> {
  const [tsParse, nativeParse] = [await parseOutcome(oracle, path), await parseOutcome(native, path)]
  const view = declaredDivergenceView(tsParse, nativeParse)
  for (const rule of view.rules) countDeclared(tally, rule)
  if (view.ts !== view.native) tally.undeclared.push(`${label}: parse ts=${clip(view.ts)} native=${clip(view.native)}`)
  const [tsCut, nativeCut] = [oracleCutShort(path, size), await native.ggufCutShort(path, size)]
  if (tsCut.cutShort === nativeCut) return
  const rule = cutShortDivergence(tsCut, view.rules)
  if (rule) countDeclared(tally, rule)
  else tally.undeclared.push(`${label}: cutShort ts=${tsCut.cutShort} native=${nativeCut}`)
}

/** A differing cut-short verdict is declared when it follows from D-3 (the oracle read past the budget) or from
 *  D-2 (the verdict is `dataEnd > size`, and the two `dataEnd`s already differ above 2^53). */
function cutShortDivergence(tsCut: { cutShort: boolean; beyondReadBudget: boolean }, parseRules: string[]) {
  if (tsCut.cutShort && tsCut.beyondReadBudget) return 'D-3'
  return parseRules.includes('D-2') ? 'D-2' : undefined
}

/** D-3: TS's sync cut-short check has no read budget, the native one stops at MAX_ASYNC_HEADER_READ and answers
 *  "not cut short" (too_large). Watching the oracle's `readSync` calls shows whether it asked for more than the
 *  budget left, the only case where D-3 can change the verdict. */
function oracleCutShort(path: string, size: number): { cutShort: boolean; beyondReadBudget: boolean } {
  const readSync = fs.readSync
  let received = 0
  let beyondReadBudget = false
  fs.readSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    if (length > native.MAX_ASYNC_HEADER_READ - received) beyondReadBudget = true
    const got = readSync(fd, buffer, offset, length, position)
    received += got
    return got
  }) as typeof fs.readSync
  syncBuiltinESMExports()
  try {
    return { cutShort: oracle.ggufCutShort(path, size), beyondReadBudget }
  } finally {
    fs.readSync = readSync
    syncBuiltinESMExports()
  }
}

function countDeclared(tally: Tally, rule: string): void {
  tally.declared.set(rule, (tally.declared.get(rule) ?? 0) + 1)
}

function compareQuantName(fileName: string, tally: Tally): void {
  const [ts, nativeQuant] = [oracle.quantFromName(fileName), native.quantFromName(fileName)]
  if (ts !== nativeQuant) tally.undeclared.push(`name ${JSON.stringify(fileName)}: ts=${ts} native=${nativeQuant}`)
}

type ParseOutcome = { meta: Record<string, unknown> } | { failure: string; positionOutOfRange: boolean }

async function parseOutcome(parser: typeof oracle | typeof native, path: string): Promise<ParseOutcome> {
  try {
    return { meta: { ...(await parser.parseGgufAsync(path)) } }
  } catch (error) {
    if (error instanceof oracle.GgufError || error instanceof native.GgufError) {
      return { failure: JSON.stringify({ error: { code: error.code, message: error.message } }), positionOutOfRange: false }
    }
    return { failure: `thrown ${String(error)}`, positionOutOfRange: isPositionOutOfRange(error) }
  }
}

/** A read at a file position above Number.MAX_SAFE_INTEGER: Node's RangeError on "position" in TS, the core's
 *  fixed I/O message natively. Neither is a GgufError (the class D-5 declares equivalent). */
function isPositionOutOfRange(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message === NATIVE_POSITION_OUT_OF_RANGE) return true
  const code = (error as NodeJS.ErrnoException).code
  return error instanceof RangeError && code === 'ERR_OUT_OF_RANGE' && error.message.includes('"position"')
}

/** Both outcomes as text after the arch 3.3 rules that can show on an existing file: D-1 (Rust truncates and
 *  saturates integer fields; NaN saturates to 0, as an `f64 as u32` does) and D-2 (exact `dataEnd` in Rust, a
 *  double in TS: not compared only where both are at or above 2^53, so a `dataEnd` one side lost to 0 or to a
 *  small value still fails). D-5 (a position above 2^53): the failure class is compared, not its text. */
function declaredDivergenceView(ts: ParseOutcome, nativeOutcome: ParseOutcome) {
  if (!('meta' in ts) || !('meta' in nativeOutcome)) return failureView(ts, nativeOutcome)
  const rules: string[] = []
  const tsMeta = withSaturatedIntegers(ts.meta)
  if (JSON.stringify(tsMeta) !== JSON.stringify(ts.meta)) rules.push('D-1')
  const nativeMeta = { ...nativeOutcome.meta }
  if (isBeyondDoublePrecision(tsMeta.dataEnd) && isBeyondDoublePrecision(nativeMeta.dataEnd)) {
    if (tsMeta.dataEnd !== nativeMeta.dataEnd) rules.push('D-2')
    tsMeta.dataEnd = nativeMeta.dataEnd = 'beyond 2^53 (D-2)'
  }
  return { ts: JSON.stringify(tsMeta), native: JSON.stringify(nativeMeta), rules }
}

function isBeyondDoublePrecision(dataEnd: unknown): boolean {
  return typeof dataEnd === 'number' && dataEnd >= 2 ** 53
}

function failureView(ts: ParseOutcome, nativeOutcome: ParseOutcome) {
  const outOfRange = (outcome: ParseOutcome) => 'failure' in outcome && outcome.positionOutOfRange
  if (outOfRange(ts) && outOfRange(nativeOutcome)) {
    return { ts: 'position out of range (D-5)', native: 'position out of range (D-5)', rules: ['D-5'] }
  }
  return { ts: outcomeText(ts), native: outcomeText(nativeOutcome), rules: [] as string[] }
}

function withSaturatedIntegers(meta: Record<string, unknown>): Record<string, unknown> {
  const saturated: Record<string, unknown> = { ...meta }
  for (const field of U32_FIELDS) saturated[field] = saturateU32(meta[field] as number)
  saturated.headCountKvPerLayer = (meta.headCountKvPerLayer as number[]).map(saturateU32)
  return saturated
}

function saturateU32(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), U32_MAX)
}

function outcomeText(outcome: ParseOutcome): string {
  return 'meta' in outcome ? JSON.stringify(outcome.meta) : outcome.failure
}

function mutate(random: Random, source: HeaderSource, index: number): Mutation {
  const kinds = [flipBytes, truncate, swapType, corruptLength]
  return kinds[index % kinds.length](random, source)
}

function flipBytes(random: Random, { bytes, sites }: HeaderSource): Mutation {
  const offset = randomInt(random, Math.max(1, Math.min(sites.headerEnd, bytes.length)))
  const length = Math.min(1 + randomInt(random, 4), bytes.length - offset)
  const flipped = Buffer.from(bytes.subarray(offset, offset + length))
  for (let i = 0; i < flipped.length; i++) flipped[i] ^= 1 + randomInt(random, 255)
  return { label: `flip ${length} at ${offset}`, patch: { offset, bytes: flipped } }
}

function truncate(random: Random, { bytes, sites }: HeaderSource): Mutation {
  const truncateTo = randomInt(random, Math.min(bytes.length, sites.headerEnd + 64))
  return { label: `truncate to ${truncateTo}`, truncateTo }
}

function swapType(random: Random, source: HeaderSource): Mutation {
  if (source.sites.typeFields.length === 0) return flipBytes(random, source)
  const offset = pick(random, source.sites.typeFields)
  const type = pick(random, [randomInt(random, 13), 13, 39, 255, 2 ** 31, randomInt(random, 2 ** 32)])
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(type)
  return { label: `type ${type} at ${offset}`, patch: { offset, bytes } }
}

function corruptLength(random: Random, source: HeaderSource): Mutation {
  if (source.sites.lengthFields.length === 0) return flipBytes(random, source)
  const { offset, width } = pick(random, source.sites.lengthFields)
  const original = width === 8 ? source.bytes.readBigUInt64LE(offset) : BigInt(source.bytes.readUInt32LE(offset))
  const value = BigInt.asUintN(width * 8, pick(random, corruptedLengths(random, original)))
  const bytes = Buffer.alloc(width)
  if (width === 8) bytes.writeBigUInt64LE(value)
  else bytes.writeUInt32LE(Number(value))
  return { label: `length ${value} at ${offset}`, patch: { offset, bytes } }
}

function corruptedLengths(random: Random, original: bigint): bigint[] {
  const randomU64 = (BigInt(randomInt(random, 2 ** 32)) << 32n) | BigInt(randomInt(random, 2 ** 32))
  return [
    0n, 1n, original + 1n, original - 1n, original * 2n, 2n ** 28n + 1n, 2n ** 31n, 2n ** 32n + original,
    2n ** 53n + 1n, 2n ** 60n, 2n ** 64n - 1n, randomU64,
  ]
}

function generatedName(random: Random): string {
  const parts = Array.from({ length: 1 + randomInt(random, 5) }, () => nameFragment(random))
  const separators = ['-', '_', '.', ' ', '', '+']
  const joined = parts.reduce((name, part) => `${name}${pick(random, separators)}${part}`)
  return `${joined}${pick(random, ['.gguf', '.GGUF', '', '-00001-of-00003.gguf', '.bin'])}`
}

function nameFragment(random: Random): string {
  const fragment = pick(random, NAME_FRAGMENTS)
  const cased = random() < 0.3 ? fragment.toLowerCase() : fragment
  return random() < 0.1 ? insertOddCharacter(random, cased) : cased
}

const NAME_FRAGMENTS = [
  'Qwen3.6', 'Llama-3.2', 'gemma', 'Q2.5', '27B', 'A3B', 'Instruct', 'UD', 'seq2seq', '2025Q4', 'MTP', 'I',
  'Q4_K_M', 'Q8_0', 'IQ2_XXS', 'IQ4_NL', 'Q3_K_S', 'Q4_', 'Q5_K_XL', 'Q6_K', 'Q4_0_4_8', 'BF16', 'F16', 'F32',
  'Q', 'IQ', 'q4_k_m', 'APEX', 'APEX-I', 'NANO', 'MINI', 'COMPACT', 'BALANCED', 'QUALITY', 'Mini', 'X', '00001',
]
const ODD_CHARACTERS = ['K', 'ſ', 'ı', 'é', '😀', '\u0000', '/', '\\', '%']

function insertOddCharacter(random: Random, fragment: string): string {
  const at = randomInt(random, fragment.length + 1)
  return `${fragment.slice(0, at)}${pick(random, ODD_CHARACTERS)}${fragment.slice(at)}`
}

function loadSources(t: TestContext): HeaderSource[] {
  const corpusIds = readJson<Array<{ id: string }>>(join(FIXTURES, 'corpus.json')).map((entry) => entry.id)
  const corpusPaths = corpusIds.map((id) => ({ id, path: join(CORPUS_CACHE, `${id}.gguf`) }))
  const fetched = corpusPaths.filter(({ path }) => existsSync(path))
  reportMissingCorpus(t, corpusIds.length - fetched.length)
  return [...craftedPaths(), ...fetched].map(({ id, path }) => {
    const bytes = readFileSync(path)
    return { id, bytes, sites: mapHeaderSites(bytes) }
  })
}

function craftedPaths(): Array<{ id: string; path: string }> {
  const dir = join(FIXTURES, 'crafted')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.gguf'))
    .sort()
    .map((name) => ({ id: name.slice(0, -'.gguf'.length), path: join(dir, name) }))
}

function reportMissingCorpus(t: TestContext, missing: number): void {
  if (missing === 0) return
  assert.notEqual(process.env.CI, 'true', `${missing} corpus slices not fetched on CI`)
  t.diagnostic(`corpus not fetched (${missing} skipped); run node core/scripts/fetch-gguf-corpus.mjs`)
}

/** Each source copied once into the temp dir; a patch mutates that copy in place and is undone after the case. */
function stageSources(sources: HeaderSource[], workDir: string): StagedSource[] {
  return sources.map((source) => {
    const path = join(workDir, `${source.id}.gguf`)
    writeFileSync(path, source.bytes)
    return { ...source, path }
  })
}

function overwrite(path: string, offset: number, bytes: Buffer): void {
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, bytes, 0, bytes.length, offset)
  } finally {
    closeSync(fd)
  }
}

/** Where the type ids and lengths of a header sit, so mutations hit structure rather than vocab text. Walks until
 *  the header ends or stops making sense (a crafted file may be malformed on purpose). */
function mapHeaderSites(bytes: Buffer): HeaderSites {
  const walker = new SiteWalker(bytes)
  try {
    walker.header()
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
  return { typeFields: walker.typeFields, lengthFields: walker.lengthFields, headerEnd: walker.offset }
}

const ARRAY_TYPE = 9
const STRING_TYPE = 8
const SCALAR_SIZES = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8]
const LENGTH_SITES_PER_ARRAY = 64

class SiteWalker {
  readonly typeFields: number[] = []
  readonly lengthFields: Array<{ offset: number; width: 4 | 8 }> = []
  offset = 8

  constructor(private readonly bytes: Buffer) {}

  header(): void {
    const tensorCount = this.length()
    const kvCount = this.length()
    for (let i = 0; i < kvCount; i++) this.keyValue()
    for (let i = 0; i < tensorCount; i++) this.tensorInfo()
  }

  private keyValue(): void {
    this.string(true)
    this.value(this.type())
  }

  private tensorInfo(): void {
    this.string(true)
    const dims = this.u32Length()
    for (let d = 0; d < Math.min(dims, 4); d++) this.length()
    this.type()
    this.length()
  }

  private value(type: number): void {
    if (type === STRING_TYPE) this.string(true)
    else if (type === ARRAY_TYPE) this.array()
    else this.skip(scalarSize(type))
  }

  private array(): void {
    const elementType = this.type()
    const count = this.length()
    if (elementType !== STRING_TYPE) this.skip(count * scalarSize(elementType))
    else for (let i = 0; i < count; i++) this.string(i < LENGTH_SITES_PER_ARRAY)
  }

  private string(recorded: boolean): void {
    this.skip(recorded ? this.length() : this.read(8, () => Number(this.bytes.readBigUInt64LE(this.offset))))
  }

  private type(): number {
    const offset = this.offset
    const type = this.read(4, () => this.bytes.readUInt32LE(offset))
    this.typeFields.push(offset)
    return type
  }

  private length(): number {
    const offset = this.offset
    const length = this.read(8, () => Number(this.bytes.readBigUInt64LE(offset)))
    this.lengthFields.push({ offset, width: 8 })
    return length
  }

  private u32Length(): number {
    const offset = this.offset
    const length = this.read(4, () => this.bytes.readUInt32LE(offset))
    this.lengthFields.push({ offset, width: 4 })
    return length
  }

  private read(width: number, value: () => number): number {
    const read = value()
    this.skip(width)
    return read
  }

  private skip(count: number): void {
    if (this.offset + count > this.bytes.length) throw new RangeError('past the end of the header')
    this.offset += count
  }
}

function scalarSize(type: number): number {
  const size = SCALAR_SIZES[type]
  if (!size) throw new RangeError(`no fixed size for type ${type}`)
  return size
}

type Random = () => number

/** mulberry32: a tiny seeded PRNG, so every run (and CI) mutates the same bytes. */
function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(random: Random, bound: number): number {
  return Math.floor(random() * bound)
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[randomInt(random, items.length)]
}

function report(t: TestContext, tally: Tally): void {
  const declared = [...tally.declared].map(([rule, count]) => `${rule}=${count}`).join(' ') || 'none'
  t.diagnostic(`declared divergences applied: ${declared}`)
  for (const difference of tally.undeclared.slice(0, REPORTED_DIFFERENCES)) t.diagnostic(difference)
  t.diagnostic(
    `parity: cases=${MUTATED_HEADERS} names=${GENERATED_NAMES} seed=0x${SEED.toString(16)} ` +
      `undeclared=${tally.undeclared.length}`,
  )
}

function clip(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
