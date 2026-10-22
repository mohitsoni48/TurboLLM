// Source-level guard: both of the daemon's teardowns stop every running chat reply (chat-routes.ts
// abortAllInFlightChats) before the engine shuts down: requestRestart (Settings → Restart daemon, an app update) and
// the SIGINT/SIGTERM/SIGHUP handler (Ctrl+C, `turbollm --stop`, the desktop app's Quit on Linux and macOS). Left to the
// engine's exit, a reply cut off this way was saved as a finished one (`aborted: false`); stopped first, it is saved as
// stopped with its text while the store is open, as after Stop. The store then closes only once those turns have ended
// (chat-routes.ts chatTurnsEnded, waited for beside the engine's shutdown, up to 3 s): a turn running a tool call ends
// only when the call does, and the store closed before it had saved. cli.ts is top-level module code that boots the
// real daemon, so it cannot be imported from a test (see cli.idle-hold-wiring.test.ts), and only a scan catches a call
// being dropped or moved. The stop path itself is chat-routes.stop.test.ts's, the wait chat-routes.detached.test.ts's.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// Line endings normalized, so a checkout with CRLF endings (Windows) reads the same.
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The source from `start` to the first engine shutdown after it. */
function untilShutdown(start: string): string {
  const from = CLI.indexOf(start)
  assert.ok(from >= 0, `cli.ts has ${start}`)
  const to = CLI.indexOf('manager.shutdown()', from)
  assert.ok(to > from, `the teardown after ${start} shuts the engine down`)
  return CLI.slice(from, to)
}

/** The source from `start` to the first store close after it. */
function untilStoreCloses(start: string): string {
  const from = CLI.indexOf(start)
  assert.ok(from >= 0, `cli.ts has ${start}`)
  const to = CLI.indexOf('db.close()', from)
  assert.ok(to > from, `the teardown after ${start} closes the store`)
  return CLI.slice(from, to)
}

/** The wait the store's close follows: the engine's shutdown and the stopped chat turns, together. */
const CLOSE_AFTER_TURNS = /Promise\.all\(\[[^\]]*\bmanager\.shutdown\(\)[^\]]*\bchatTurnsEnded\(\)[^\]]*\]\)\.finally\(/

test('a restart stops every running chat reply before the engine shuts down', () => {
  assert.match(untilShutdown('deps.requestRestart = '), /\n\s+abortAllInFlightChats\(\)\n/)
})

test('a SIGINT, SIGTERM or SIGHUP stops every running chat reply before the engine shuts down', () => {
  assert.match(untilShutdown("for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {"), /\n\s+abortAllInFlightChats\(\)\n/)
})

test('a restart closes the store only once the chat replies it stopped have ended', () => {
  assert.match(untilStoreCloses('deps.requestRestart = '), CLOSE_AFTER_TURNS)
})

test('a SIGINT, SIGTERM or SIGHUP closes the store only once the chat replies it stopped have ended', () => {
  assert.match(untilStoreCloses("for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {"), CLOSE_AFTER_TURNS)
})
