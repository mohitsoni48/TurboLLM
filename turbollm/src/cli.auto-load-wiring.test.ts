// Source-level guard: the daemon's startup auto-load waits for the boot model scan and is decided
// by `runAutoLoad` in engines/auto-load.ts, never by a second inline block in cli.ts.
//
// Why a source scan and not a behavioural test: cli.ts is top-level module code. Importing it
// boots the real daemon (config, engines, a listening port), so it cannot be loaded from a test.
// The behaviour itself is proven against fakes and a real Scanner in engines/auto-load.test.ts;
// what only a scan of cli.ts can catch is the wiring regressing: the boot scan's promise being
// dropped again (`void scanner.rescan()`, the original bug), a second rescan being awaited, or
// auto-load reading the pre-scan `cfg` snapshot. Precedent: src/code/worktree-wiring.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8')

const KEEP_BOOT_SCAN = 'const initialScan = scanner.rescan()'
const START_AUTO_LOAD = 'void runAutoLoad('
const SEED_MODEL_DIR = 'seedDefaultModelDir(store, scanner)'
const RESCAN_AFTER_DOWNLOAD = '() => void scanner.rescan(),'
const AUTO_LOAD_GETS_BOOT_SCAN = /void runAutoLoad\(\{[\s\S]*?\binitialScan\b[\s\S]*?\}\)/
const PRE_SCAN_AUTO_LOAD_READS = ['cfg.autoLoadOnStart', 'cfg.lastLoaded', 'cfg.devModel']

function occurrencesOf(needle: string): number {
  return CLI.split(needle).length - 1
}

test('the boot scan promise is kept exactly once', () => {
  assert.equal(occurrencesOf(KEEP_BOOT_SCAN), 1, `cli.ts must contain "${KEEP_BOOT_SCAN}" exactly once`)
})

test('cli.ts never awaits a second rescan of its own', () => {
  assert.ok(!CLI.includes('await scanner.rescan()'), 'auto-load must await the boot scan, not start another')
})

test('auto-load is started from runAutoLoad with the boot scan promise', () => {
  assert.ok(AUTO_LOAD_GETS_BOOT_SCAN.test(CLI), `cli.ts must match ${AUTO_LOAD_GETS_BOOT_SCAN}`)
})

test('cli.ts reads no auto-load setting from the pre-scan cfg snapshot', () => {
  const preScanReads = PRE_SCAN_AUTO_LOAD_READS.filter((read) => CLI.includes(read))
  assert.deepEqual(preScanReads, [], 'auto-load must decide from the snapshot runAutoLoad takes after the scan')
})

test('AC8: a completed download still triggers a fire-and-forget rescan', () => {
  assert.ok(CLI.includes(RESCAN_AFTER_DOWNLOAD), `the download completion callback must stay: ${RESCAN_AFTER_DOWNLOAD}`)
})

test('the model dir is seeded before the boot scan, and the boot scan starts before auto-load', () => {
  const seeded = CLI.indexOf(SEED_MODEL_DIR)
  const scanned = CLI.indexOf(KEEP_BOOT_SCAN)
  const autoLoaded = CLI.indexOf(START_AUTO_LOAD)
  assert.ok(seeded >= 0 && scanned >= 0 && autoLoaded >= 0, 'all three boot steps must be present')
  assert.ok(
    seeded < scanned && scanned < autoLoaded,
    `boot order must be seed (${seeded}) < scan (${scanned}) < auto-load (${autoLoaded})`,
  )
})
