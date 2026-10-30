// util/daemon-ticks.ts, and the guard that keeps the restart keeper quiet as the code changes.
//
// A Settings restart from a terminal keeps the old process as the keeper of its replacement (cli.ts becomeKeeper).
// Every recurring tick of the old process ran on in it, on the old process's state: the ext API's reaper threw from its
// timer on the chat store the keeper had closed and ended the keeper, and TurboLLM with it, 30 s after the restart;
// the telemetry ticks flushed with the consent from before it. So every setInterval in the daemon's source is either
// a daemonTick, which the keeper stops, or listed below with what stops it before the keeper starts its replacement.
// A new one fails this test until it is either (where a reviewer sees it); a listed one that is gone fails it too.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { daemonTick, stopDaemonTicks } from './daemon-ticks'
import { sourceFilesUnder } from '../test-support/raw-spawn-sites'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RESTART = 'stopped by the restart handler (cli.ts deps.requestRestart) before the keeper starts its replacement'

/** `<file>` → how many setInterval calls it has, and what stops each before the keeper's replacement starts. */
const OWNED_INTERVALS: Record<string, { count: number; why: string }> = {
  'util/daemon-ticks.ts': { count: 1, why: 'daemonTick itself: stopDaemonTicks, in becomeKeeper' },
  'cli.ts': { count: 1, why: `the interactive-run sweep (cliInteractiveSweepTimer): ${RESTART}` },
  'engines/update-scheduler.ts': { count: 1, why: `UpdateScheduler.stop(), which cancels its first pass too: ${RESTART}` },
  'routines/scheduler.ts': { count: 1, why: `RoutineScheduler.stop(): ${RESTART}` },
  'remote/manager.ts': { count: 1, why: 'a tunnel\'s health loop: cleared synchronously by remote.disable(), which the restart teardown calls' },
  'engines/manager.ts': { count: 1, why: 'an engine\'s idle watchdog, armed only while its process lives: the restart stops the engines, and the keeper\'s exit net kills what is left' },
  'chat/chat-routes.ts': { count: 2, why: 'a reply stream\'s keepalive and a turn\'s partial saves: each ends with its run, and the restart stops every run first (abortAllInFlightChats)' },
  'link/link-manager.ts': { count: 1, why: 'the Turbo Link poll: LinkManager.stop(), in becomeKeeper' },
  'sysinfo/usage.ts': { count: 1, why: 'the usage sampler: stopUsageMonitor(), in becomeKeeper (it also stops itself 6 s after its last reader)' },
  'util/tether.ts': { count: 1, why: 'the held-group re-count: it stops itself once nothing is held, and the keeper\'s closeAllLifelines closes every hold' },
}

test('every setInterval in the daemon is a daemonTick, or one the restart or the keeper stops (listed)', () => {
  const found: Record<string, number> = {}
  for (const path of sourceFilesUnder(SRC_ROOT)) {
    const n = readFileSync(path, 'utf8').split(/\bsetInterval\(/).length - 1
    if (n > 0) found[relative(SRC_ROOT, path).split(sep).join('/')] = n
  }
  const listed = Object.fromEntries(Object.entries(OWNED_INTERVALS).map(([file, { count }]) => [file, count]))
  assert.deepEqual(found, listed, 'a new recurring tick runs on in the restart keeper: make it a daemonTick (util/daemon-ticks.ts), or have the restart or becomeKeeper stop it and list it here')
})

test('stopDaemonTicks stops every daemonTick, and none keeps the process alive', (t) => {
  const real = daemonTick(() => {}, 1e9)
  assert.equal(real.hasRef(), false, 'unref\'d')
  stopDaemonTicks()
  t.mock.timers.enable({ apis: ['setInterval'] })
  let a = 0
  let b = 0
  daemonTick(() => { a++ }, 1000)
  daemonTick(() => { b++ }, 5000)
  t.mock.timers.tick(5000)
  assert.deepEqual([a, b], [5, 1])
  stopDaemonTicks()
  t.mock.timers.tick(60_000)
  assert.deepEqual([a, b], [5, 1], 'neither ticks again')
})
