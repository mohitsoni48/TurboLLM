import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Why this exists: a test that calls mkdtemp/tmpdir itself has to remember to delete what it
// made, and hundreds of them didn't — every `npm test` left ~1,000 directories (~90 MB, mostly
// one SQLite file per test) in the shared temp folder. tmpDir() cleans up by construction.

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIPPED_DIRS = new Set(['node_modules', 'webdist', 'test-support'])
const RAW_TEMP_USE = /\bmkdtemp(Sync)?\b|\btmpdir\s*\(/

/** Files exempt from the rule, each with the reason. Prefer fixing the test over adding to this. */
const ALLOWED_RAW_TEMP_USE: Record<string, string> = {}

test('no test file makes temp directories by hand; they all come from tmpDir()', () => {
  const offenders = testFilesUnder(SRC_ROOT)
    .filter((file) => !(posixPath(file) in ALLOWED_RAW_TEMP_USE))
    .flatMap(rawTempUses)

  assert.equal(
    offenders.length,
    0,
    `${offenders.length} raw temp-dir use(s) in test files. Get a directory with tmpDir(prefix) from ` +
      `'test-support/tmp' (removed automatically), or pass IN_MEMORY_DATA_DIR to a ConversationStore ` +
      `that needs no directory:\n${offenders.join('\n')}`,
  )
})

function testFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : testFilesUnder(path)
    return /\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function rawTempUses(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter(({ text }) => !isCommentLine(text) && RAW_TEMP_USE.test(text))
    .map(({ text, line }) => `${posixPath(file)}:${line}  ${text}`)
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*')
}

function posixPath(file: string): string {
  return relative(SRC_ROOT, file).split(sep).join('/')
}
