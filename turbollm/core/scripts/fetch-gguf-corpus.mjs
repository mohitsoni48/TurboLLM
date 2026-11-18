// Fetches the real-header GGUF corpus (core/fixtures/gguf/corpus.json) into the gitignored
// core/fixtures/gguf/.corpus-cache/, one sha256-verified prefix per entry, by HTTP Range. Whole model files are
// never downloaded and no token is ever sent (rust-core plan T4; architecture 3.1). Run from turbollm/:
//   node core/scripts/fetch-gguf-corpus.mjs                     fetch every entry (cached good slices are skipped)
//   node core/scripts/fetch-gguf-corpus.mjs --entry <id>        fetch one entry
//   node core/scripts/fetch-gguf-corpus.mjs --snapshot-listing  writes hf-listing.json: the .gguf file names of
//       every corpus Hugging Face repo at its pinned revision (input to quant-names.json)
// There is no mode that pins a new entry: it needed the TypeScript oracle, which is deleted (rust-core T22). The
// goldens are the spec: a new corpus entry, and its golden, are written by hand and reviewed as a spec change.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gguf')
export const CORPUS_PATH = join(FIXTURES_DIR, 'corpus.json')
export const CACHE_DIR = join(FIXTURES_DIR, '.corpus-cache')
const LISTING_PATH = join(FIXTURES_DIR, 'hf-listing.json')
const GITHUB_PREFIX = 'github:'

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

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function main(args) {
  if (args.length === 0) return fetchAll(undefined)
  if (args[0] === '--entry' && args.length === 2) return fetchAll(args[1])
  if (args[0] === '--snapshot-listing' && args.length === 1) return snapshotListing()
  console.error('usage: node core/scripts/fetch-gguf-corpus.mjs [--entry <id> | --snapshot-listing]')
  process.exit(2)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
