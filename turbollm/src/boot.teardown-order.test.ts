// Source-level guard for the steps of the daemon's one teardown (boot.ts close) that boot.teardown-wiring.test.ts
// cannot watch on a real daemon: they are module functions, not methods it can spy on (chatTurns.abortAll,
// chatTurns.turnsEnded, stopTethered), and an idle test daemon has no chat reply running for them to act on.
//
// Both of the daemon's teardowns run close(): a restart (Settings → Restart daemon, an app update) and the signal
// shutdown (Ctrl+C, `turbollm --stop`, the desktop app's Quit on Linux and macOS). Every running chat reply is stopped
// first (chat-turns.ts abortAll): left to the engine's exit, a reply cut off this way was saved as a
// finished one (`aborted: false`); stopped first, it is saved as stopped with its text while the store is open, as
// after Stop. The store then closes only once those turns have ended (chat-turns.ts turnsEnded, waited for beside
// the engine's shutdown, up to 3 s): a turn running a tool call ends only when the call does, and the store closed
// before it had saved. The stop path itself is chat-routes.stop.test.ts's, the wait chat-routes.detached.test.ts's.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootBody } from './test-support/daemon-source'

const TEARDOWN = (() => {
  const body = bootBody()
  const start = body.indexOf('function close({')
  assert.ok(start >= 0, 'bootDaemon defines close()')
  return body.slice(start, body.indexOf('\n}\n', start) + 2)
})()

test('the teardown stops every running chat reply before anything else, the engine\'s shutdown included', () => {
  assert.match(TEARDOWN, /^function close\([^\n]*\{\n\s*chatTurns\.abortAll\(\)\n/)
})

test('the teardown waits for the stopped chat turns and the tethered children beside the engine, and closes the store only then', () => {
  assert.match(TEARDOWN, /const stopping: Promise<unknown>\[\] = \[[^\]]*\bmanager\.shutdown\(\)[^\]]*\bstopTethered\(\)[^\]]*\bchatTurns\.turnsEnded\(\)[^\]]*\]/)
  const waited = TEARDOWN.indexOf('void Promise.all(stopping).finally(')
  assert.ok(waited > 0 && waited < TEARDOWN.indexOf('db.close()'), 'the store closes in the wait\'s finally')
})
