// rust-core plan T11 (arch 5.4, P-1, P-2). Every crafted and corpus golden in core/fixtures/gguf, read
// through the facade and the real native core. Generated goldens are pinned by Rust only (P-1).
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { GgufError, ggufCutShort, parseGgufAsync, quantFromName } from './gguf'

const FIXTURES = join(import.meta.dirname, '..', '..', 'core', 'fixtures', 'gguf')
const CORPUS_CACHE = join(FIXTURES, '.corpus-cache')
const EXACT_INTEGER_DIVERGENCE = 'D-2'

interface Golden {
  parse: string
  cutShort: Array<[number, boolean]>
  maxRead?: number
  generated?: unknown
}

interface GoldenFixture {
  id: string
  golden: Golden
  path: string
}

const divergences: Record<string, string> = readJson(join(FIXTURES, 'divergences.json'))
const corpusIds = new Set(readJson<Array<{ id: string }>>(join(FIXTURES, 'corpus.json')).map((entry) => entry.id))
const fixtures = checkableFixtures()

test('every crafted and corpus golden parses to its exact JSON text', async (t) => {
  reportCounts(t)
  for (const { id, golden, path } of fixtures) {
    const actual = await parseText(path, golden.maxRead)
    assert.equal(actual, expectedParseText(id, golden), id)
  }
})

test('every golden cut-short pair gets its verdict', async () => {
  for (const { id, golden, path } of fixtures) {
    for (const [size, verdict] of golden.cutShort) {
      assert.equal(await ggufCutShort(path, size), verdict, `${id} at ${size}`)
    }
  }
})

test('every quant-name row maps through quantFromName, null as "?"', () => {
  const rows = readJson<Array<[string, string | null]>>(join(FIXTURES, 'golden', 'quant-names.json'))
  for (const [fileName, quant] of rows) {
    assert.equal(quantFromName(fileName), quant ?? '?', fileName)
  }
})

test('a missing file rejects with a plain Error carrying the system message', async () => {
  const missing = join(FIXTURES, 'crafted', 'no-such-fixture.gguf')
  const error = await parseGgufAsync(missing).then(
    () => assert.fail('a missing file parsed'),
    (rejection: unknown) => rejection,
  )
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof GgufError), 'an I/O failure is not a GgufError')
  assert.notEqual(error.message, '')
  assert.ok(error.cause instanceof Error, 'the core rejection is kept as the cause')
  assert.equal((error.cause as Error & { code?: unknown }).code, 'io')
  assert.equal(error.cause.message, error.message)
})

test('a GgufError code cannot be reassigned', () => {
  const error = new GgufError('truncated', 'Unexpected EOF in GGUF header.')
  // @ts-expect-error code is readonly
  error.code = 'not_gguf'
})

test('a GgufError is named GgufError and keeps its code', async () => {
  const error = await parseGgufAsync(join(FIXTURES, 'crafted', 'cut-short-not-gguf.gguf')).catch((e: unknown) => e)
  assert.ok(error instanceof GgufError)
  assert.equal(error.name, 'GgufError')
  assert.equal(error.code, 'not_gguf')
})

async function parseText(path: string, maxRead: number | undefined): Promise<string> {
  try {
    return JSON.stringify(await parseGgufAsync(path, maxRead))
  } catch (error) {
    if (!(error instanceof GgufError)) throw error
    return JSON.stringify({ error: { code: error.code, message: error.message } })
  }
}

/** D-2 goldens hold `dataEnd` as an exact integer; a JS number is the nearest double to it. */
function expectedParseText(id: string, golden: Golden): string {
  if (divergences[id] !== EXACT_INTEGER_DIVERGENCE) return golden.parse
  return golden.parse.replace(/"dataEnd":(\d+)/, (_, exact: string) => `"dataEnd":${Number(BigInt(exact))}`)
}

function checkableFixtures(): GoldenFixture[] {
  return goldenIds()
    .map((id) => ({ id, golden: readJson<Golden>(join(FIXTURES, 'golden', `${id}.json`)) }))
    .filter(({ golden }) => golden.generated === undefined)
    .map(({ id, golden }) => ({ id, golden, path: fixturePath(id) }))
    .filter(({ id, path }) => !corpusIds.has(id) || existsSync(path))
}

/** Golden ids, without the quant-name table and the raw TypeScript output of a declared divergence. */
function goldenIds(): string[] {
  return readdirSync(join(FIXTURES, 'golden'))
    .filter((name) => name.endsWith('.json') && !name.endsWith('.ts.json') && name !== 'quant-names.json')
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

function fixturePath(id: string): string {
  return corpusIds.has(id) ? join(CORPUS_CACHE, `${id}.gguf`) : join(FIXTURES, 'crafted', `${id}.gguf`)
}

function reportCounts(t: TestContext): void {
  const corpus = fixtures.filter(({ id }) => corpusIds.has(id)).length
  const missingCorpus = corpusIds.size - corpus
  t.diagnostic(`goldens: crafted=${fixtures.length - corpus} corpus=${corpus}`)
  if (missingCorpus === 0) return
  assert.notEqual(process.env.CI, 'true', `${missingCorpus} corpus slices not fetched on CI`)
  t.diagnostic(`corpus not fetched (${missingCorpus} skipped); run node core/scripts/fetch-gguf-corpus.mjs`)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
