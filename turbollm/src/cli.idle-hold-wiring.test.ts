// Source-level guard: the daemon's primary Manager asks the chat whether it still needs the model before its idle
// watchdog unloads it (Manager.holdsEngine, chat-routes.ts chatHoldsEngine). cli.ts is top-level module code that boots
// the real daemon, so it cannot be imported from a test (see cli.auto-load-wiring.test.ts); the behaviour is proven in
// engines/manager.idle.test.ts and chat/chat-routes.detached.test.ts, and only a scan of cli.ts catches the wiring being
// dropped. The Android app's bundle starts from the same cli.ts (tsup.android.config.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// Line endings normalized, so a checkout with CRLF endings (Windows) reads the same.
const CLI = readFileSync(join(HERE, 'cli.ts'), 'utf8').replace(/\r\n/g, '\n')

test('the primary Manager is given the chat\'s engine hold, right where it is built', () => {
  assert.match(CLI, /const manager = new Manager\(store\)\n(?:\/\/.*\n)*manager\.holdsEngine = chatHoldsEngine\n/)
})
