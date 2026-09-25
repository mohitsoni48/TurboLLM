// Source-level guard for the daemon's self-restart wiring (spec 08 §2, ADR-442).
//
// Why a source scan and not a behavioural test: cli.ts is top-level module code. Importing it
// boots the real daemon (config, engines, a listening port), so it cannot be loaded from a test.
//
// The npm/CLI restart, spawnReplacement(), is a detached, unref'd re-exec of the same interpreter
// and argv. It must stay byte-identical to the shipped one. If a test here fails because that
// function changed, the fix needs a founder decision, not an updated literal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The text from `opening` through the first closing brace at column 0 after it. */
function blockFrom(opening: string): string {
  const start = CLI.indexOf(opening)
  assert.ok(start >= 0, `cli.ts must contain "${opening}"`)
  const end = CLI.indexOf('\n}\n', start)
  assert.ok(end > start, `no column-0 closing brace after "${opening}"`)
  return CLI.slice(start, end + 2)
}

function occurrencesOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const SPAWN_REPLACEMENT_OPENING = 'function spawnReplacement(): void {'

const SPAWN_REPLACEMENT_AS_SHIPPED = [
  "function spawnReplacement(): void {",
  "  // Re-exec with the SAME interpreter + argv (minus argv[0]=node) and cwd, detached",
  "  // so it outlives this dying parent. `stdio:'ignore'` (NOT 'inherit') is essential:",
  "  // the parent is exiting, so inheriting its stdio handles would break the child's",
  "  // streams the moment we exit (and fails outright when the parent was itself launched",
  "  // detached). `unref()` lets the parent exit immediately. The replacement retries the",
  "  // port bind, so it survives the brief window where this process still holds it.",
  "  // Send the replacement's stdout/stderr to a log file (NOT the dead parent's",
  "  // streams) so a failed restart leaves something to diagnose. Falls back to",
  "  // 'ignore' if the file can't be opened.",
  "  let out: number | 'ignore' = 'ignore'",
  "  try {",
  "    out = openSync(join(store.dir(), 'restart.log'), 'a')",
  "  } catch {",
  "    out = 'ignore'",
  "  }",
  "  const child = spawn(process.execPath, process.argv.slice(1), {",
  "    cwd: process.cwd(),",
  "    detached: true,",
  "    stdio: ['ignore', out, out],",
  "  })",
  "  child.unref()",
  "}",
].join('\n')

const DETACHED_REEXEC_MARKERS = [
  'spawn(process.execPath, process.argv.slice(1), {',
  'cwd: process.cwd(),',
  'detached: true,',
  "stdio: ['ignore', out, out],",
  'child.unref()',
  "'restart.log'",
]

const SPAWN_REPLACEMENT_CALL = /spawnReplacement\(\)(?!:)/g
const FAIL_SAFE_SPAWN =
  /try \{\n\s+spawnReplacement\(\)\n\s+\} catch \(e\) \{\n\s+console\.warn\(`restart spawn failed: \$\{e\}`\)\n\s+\}/
const RESTART_WATCHDOG = 'const watchdog = setTimeout(finish, 14_000)'
const DIRECT_RESTART_EXITS = ['process.exit(75)', 'exit(RESTART_REQUESTED_EXIT_CODE)']

test('the npm/CLI replacement spawn is byte-identical to the shipped one', () => {
  assert.equal(
    blockFrom(SPAWN_REPLACEMENT_OPENING),
    SPAWN_REPLACEMENT_AS_SHIPPED,
    'spawnReplacement() changed. Constraint (c) keeps the npm/CLI restart byte-identical (ADR-442). ' +
      'Changing it needs a founder decision.',
  )
})

test("the npm/CLI replacement is still a detached, unref'd re-exec of the same interpreter and argv", () => {
  const spawnReplacement = blockFrom(SPAWN_REPLACEMENT_OPENING)
  for (const marker of DETACHED_REEXEC_MARKERS) {
    assert.ok(spawnReplacement.includes(marker), `spawnReplacement() must still contain: ${marker}`)
  }
})

test('spawnReplacement() has exactly one call site', () => {
  const callSites = CLI.match(SPAWN_REPLACEMENT_CALL) ?? []
  assert.equal(callSites.length, 1, 'spawnReplacement() must be called from the restart path only')
})

test('the replacement spawn keeps its fail-safe try/catch', () => {
  assert.ok(FAIL_SAFE_SPAWN.test(CLI), `cli.ts must match ${FAIL_SAFE_SPAWN}`)
})

test('the restart watchdog is still 14 s', () => {
  assert.equal(occurrencesOf(CLI, RESTART_WATCHDOG), 1, `cli.ts must contain "${RESTART_WATCHDOG}" exactly once`)
})

test('no code path in cli.ts exits with the restart code directly', () => {
  const directExits = DIRECT_RESTART_EXITS.filter((exit) => CLI.includes(exit))
  assert.deepEqual(directExits, [], 'the restart exit code comes from planRestartExit, never a hand-written exit')
})
