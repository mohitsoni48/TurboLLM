// Fetches the real-header GGUF corpus (core/fixtures/gguf/corpus.json) into the gitignored
// core/fixtures/gguf/.corpus-cache/, one sha256-verified prefix per entry, by HTTP Range. Whole model files are
// never downloaded and no token is ever sent (rust-core plan T4; architecture 3.1). Run from turbollm/:
//   node core/scripts/fetch-gguf-corpus.mjs                     fetch every entry (cached good slices are skipped)
//   node core/scripts/fetch-gguf-corpus.mjs --entry <id>        fetch one entry
//   npx tsx core/scripts/fetch-gguf-corpus.mjs --discover <repo> <file> <id>
//       pins the revision, finds the smallest 64 KiB-rounded prefix the TS oracle parses completely, caches it
//       and prints the corpus.json entry (the oracle is src/gguf/gguf.ts, so this mode needs tsx)
//   node core/scripts/fetch-gguf-corpus.mjs --snapshot-listing  writes hf-listing.json: the .gguf file names of
//       every corpus Hugging Face repo at its pinned revision (input to quant-names.json)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gguf')
export const CORPUS_PATH = join(FIXTURES_DIR, 'corpus.json')
export const CACHE_DIR = join(FIXTURES_DIR, '.corpus-cache')
const LISTING_PATH = join(FIXTURES_DIR, 'hf-listing.json')
const GITHUB_PREFIX = 'github:'
const PREFIX_STEP = 64 * 1024
const DISCOVER_CHUNK = 1024 * 1024

/** Where an entry's file lives at its pinned revision (P-6: `github:` repos are served raw by GitHub). */
export function sliceUrl(entry) {
  if (entry.repo.startsWith(GITHUB_PREFIX)) {
    return `https://raw.githubusercontent.com/${entry.repo.slice(GITHUB_PREFIX.length)}/${entry.revision}/${entry.file}`
  }
  return `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`
}

export function cachedSlicePath(cacheDir, entry) {
  return join(cacheDir, `${entry.id}.gguf`)
}

/** Makes sure `cacheDir` holds the entry's verified prefix: 'cached' when it already did, 'fetched' otherwise. */
export async function ensureSlice(entry, cacheDir, fetchImpl = fetch) {
  const path = cachedSlicePath(cacheDir, entry)
  if (existsSync(path) && sha256Of(readFileSync(path)) === entry.sha256) return 'cached'
  const bytes = await fetchPrefix(entry, fetchImpl)
  verifySlice(entry, bytes)
  writeAtomically(path, bytes)
  return 'fetched'
}

function verifySlice(entry, bytes) {
  if (bytes.length !== entry.bytes) throw new Error(`${entry.id}: got ${bytes.length} bytes, want ${entry.bytes}`)
  const actual = sha256Of(bytes)
  if (actual !== entry.sha256) throw new Error(`${entry.id}: sha256 ${actual} does not match the pinned ${entry.sha256}`)
}

/** The entry's first `bytes` bytes, or fewer at the file's end. A server that ignores Range and answers 200 is read
 *  only up to the bytes asked for, then the rest of its body is cancelled unread. */
async function fetchPrefix(entry, fetchImpl) {
  const response = await fetchImpl(sliceUrl(entry), {
    headers: { Range: `bytes=0-${entry.bytes - 1}` },
    redirect: 'follow',
  })
  if (response.status !== 206 && response.status !== 200) throw new Error(`${entry.id}: HTTP ${response.status}`)
  return readAtMost(response, entry.bytes)
}

async function readAtMost(response, length) {
  const chunks = []
  let seen = 0
  const reader = response.body.getReader()
  while (seen < length) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    seen += value.length
  }
  await reader.cancel()
  return Buffer.concat(chunks).subarray(0, length)
}

function totalSizeOf(response) {
  const match = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
  return match ? Number(match[1]) : Number(response.headers.get('content-length'))
}

function writeAtomically(path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readCorpus() {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))
}

async function fetchAll(onlyId) {
  const entries = readCorpus().filter((e) => onlyId === undefined || e.id === onlyId)
  if (entries.length === 0) throw new Error(`no corpus entry ${onlyId}`)
  let failures = 0
  for (const entry of entries) {
    try {
      console.log(`ok  ${entry.id} (${await ensureSlice(entry, CACHE_DIR)}, sha256 verified)`)
    } catch (e) {
      failures++
      console.error(`FAIL ${e.message}`)
    }
  }
  if (failures > 0) process.exit(1)
}

async function discover(repo, file, id) {
  const oracle = await importOracle()
  const revision = await pinnedRevision(repo)
  const entry = { id, repo, revision, file }
  const workDir = join(CACHE_DIR, `.discover-${id}`)
  mkdirSync(workDir, { recursive: true })
  try {
    const { prefix, fileSize } = await downloadUntilParsed(entry, oracle, workDir)
    const bytes = await smallestParsedPrefix(prefix, fileSize, oracle, workDir)
    const slice = prefix.subarray(0, bytes)
    const pinned = { ...entry, bytes, sha256: sha256Of(slice), fileSize }
    writeAtomically(cachedSlicePath(CACHE_DIR, pinned), slice)
    console.log(JSON.stringify(pinned))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function importOracle() {
  try {
    return await import('../../src/gguf/gguf.ts')
  } catch {
    throw new Error('--discover runs the TS oracle: start it with npx tsx core/scripts/fetch-gguf-corpus.mjs')
  }
}

async function pinnedRevision(repo) {
  if (repo.startsWith(GITHUB_PREFIX)) {
    const commit = await fetchJson(`https://api.github.com/repos/${repo.slice(GITHUB_PREFIX.length)}/commits/HEAD`)
    return commit.sha
  }
  const model = await fetchJson(`https://huggingface.co/api/models/${repo}`)
  if (model.gated !== false) throw new Error(`${repo} is gated (${model.gated}); the corpus takes ungated repos only`)
  return model.sha
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

/** Downloads the file's head chunk by chunk until the oracle parses it completely (or the file ends). */
async function downloadUntilParsed(entry, oracle, workDir) {
  const probe = join(workDir, 'prefix.gguf')
  const first = await fetchChunk(entry, 0, PREFIX_STEP)
  let prefix = first.bytes
  for (;;) {
    writeFileSync(probe, prefix)
    if ((await oracleText(oracle, probe)) !== null || prefix.length >= first.totalSize) break
    const next = await fetchChunk(entry, prefix.length, DISCOVER_CHUNK)
    prefix = Buffer.concat([prefix, next.bytes])
  }
  return { prefix, fileSize: first.totalSize }
}

async function fetchChunk(entry, start, length) {
  const response = await fetch(sliceUrl(entry), { headers: { Range: `bytes=${start}-${start + length - 1}` } })
  if (response.status !== 206) throw new Error(`${entry.id}: HTTP ${response.status} for a ranged request`)
  return { bytes: await readAtMost(response, length), totalSize: totalSizeOf(response) }
}

/** The smallest multiple of 64 KiB (capped at the file size) whose prefix the oracle parses to the same result as
 *  the whole downloaded prefix. */
async function smallestParsedPrefix(prefix, fileSize, oracle, workDir) {
  const reference = await oracleTextOfPrefix(prefix, prefix.length, oracle, workDir)
  if (reference === null) throw new Error(`the oracle never parsed the first ${prefix.length} bytes completely`)
  let low = 1
  let high = Math.ceil(prefix.length / PREFIX_STEP)
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const length = Math.min(mid * PREFIX_STEP, fileSize)
    if ((await oracleTextOfPrefix(prefix, length, oracle, workDir)) === reference) high = mid
    else low = mid + 1
  }
  return Math.min(low * PREFIX_STEP, fileSize, prefix.length)
}

async function oracleTextOfPrefix(prefix, length, oracle, workDir) {
  const path = join(workDir, `candidate-${length}.gguf`)
  writeFileSync(path, prefix.subarray(0, length))
  try {
    return await oracleText(oracle, path)
  } finally {
    rmSync(path, { force: true })
  }
}

/** The oracle's JSON text for a complete parse, or null when the bytes end before the header does. */
async function oracleText(oracle, path) {
  try {
    return JSON.stringify(await oracle.parseGgufAsync(path))
  } catch (e) {
    if (e instanceof oracle.GgufError && e.code === 'truncated') return null
    throw e
  }
}

async function snapshotListing() {
  const listing = {}
  for (const entry of readCorpus().filter((e) => !e.repo.startsWith(GITHUB_PREFIX))) {
    const model = await fetchJson(`https://huggingface.co/api/models/${entry.repo}/revision/${entry.revision}`)
    const files = model.siblings.map((s) => s.rfilename).filter((name) => name.endsWith('.gguf'))
    listing[`${entry.repo}@${entry.revision}`] = files.sort()
  }
  writeFileSync(LISTING_PATH, `${JSON.stringify(listing, null, 2)}\n`)
  console.log(`wrote ${Object.keys(listing).length} repo listings to hf-listing.json`)
}

async function main(args) {
  if (args.length === 0) return fetchAll(undefined)
  if (args[0] === '--entry' && args.length === 2) return fetchAll(args[1])
  if (args[0] === '--discover' && args.length === 4) return discover(args[1], args[2], args[3])
  if (args[0] === '--snapshot-listing' && args.length === 1) return snapshotListing()
  console.error('usage: node core/scripts/fetch-gguf-corpus.mjs [--entry <id> | --snapshot-listing]\n' +
    '       npx tsx core/scripts/fetch-gguf-corpus.mjs --discover <repo> <file> <id>')
  process.exit(2)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
