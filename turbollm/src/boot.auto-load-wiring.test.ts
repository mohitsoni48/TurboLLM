// The daemon's startup auto-load waits for the boot model scan and is decided by `runAutoLoad` in
// engines/auto-load.ts, never by a second inline block in the boot. On a real test daemon (test-support/test-daemon.ts)
// where it can be watched; its decisions are engines/auto-load.test.ts's, against fakes and a real Scanner.
//
// What regressed before was the wiring: the boot scan's promise dropped (`void scanner.rescan()`, the original bug),
// so auto-load decided on a library not scanned yet. The one step left as a source scan is the model-dir seed's place
// before the scan: a test daemon has a model dir configured (an empty one would adopt the user's own HF cache).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Scanner } from './models/scanner'
import { bootBody } from './test-support/daemon-source'
import { bootTestDaemon } from './test-support/test-daemon'

const until = async (what: string, ok: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 5_000; waited += 10) {
    if (ok()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('auto-load decides only once the boot scan has finished, and starts no scan of its own', async (t) => {
  let finishScan!: () => void
  const bootScan = new Promise<void>((resolve) => { finishScan = resolve })
  const rescan = t.mock.method(Scanner.prototype, 'rescan', () => bootScan)
  const lines: string[] = []
  t.mock.method(console, 'log', (...a: unknown[]) => { lines.push(a.join(' ')) })
  const decided = () => lines.some((l) => l.startsWith('auto-load skipped'))
  const d = await bootTestDaemon((c) => { c.autoLoadOnStart = true }, { autoLoad: true })
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(decided(), false, 'nothing decided while the boot scan runs')
    finishScan()
    await until('the auto-load decision', decided)
    assert.equal(rescan.mock.callCount(), 1, 'the boot scan is the only one')
  } finally {
    await d.stop()
  }
})

test('a completed download rescans the library', async (t) => {
  const d = await bootTestDaemon()
  try {
    const rescan = t.mock.method(d.deps.scanner, 'rescan', () => Promise.resolve())
    ;(d.deps.downloads as unknown as { onComplete: () => void }).onComplete()
    assert.equal(rescan.mock.callCount(), 1)
  } finally {
    await d.stop()
  }
})

test('the model dir is seeded before the boot scan, and the boot reads no auto-load setting itself', () => {
  const body = bootBody()
  const seeded = body.indexOf('seedDefaultModelDir(store, scanner)')
  const scanned = body.indexOf('const initialScan = scanner.rescan()')
  assert.ok(seeded >= 0 && scanned > seeded, 'seed, then scan')
  const preScanReads = ['cfg.autoLoadOnStart', 'cfg.lastLoaded', 'cfg.devModel'].filter((read) => body.includes(read))
  assert.deepEqual(preScanReads, [], 'auto-load decides from the snapshot runAutoLoad takes after the scan')
})

// QA F4 (B-19): the Android engine repair and registration is kept as a promise and handed to auto-load, so the first
// launch after an upgrade plans on the engine that setup activates, not the removed row it replaces. A source scan: the
// reconciler is a no-op off Android, so a test daemon cannot show the wait.
test('auto-load is handed the Android engine setup promise', () => {
  const body = bootBody()
  const keep = 'const androidEngineSetup = reconcileAndroidEngines('
  assert.equal(body.split(keep).length - 1, 1, `the boot must contain "${keep}" once`)
  assert.match(body, /void runAutoLoad\(\{[\s\S]*?\bengineSetup: androidEngineSetup\b[\s\S]*?\}\)/)
})
