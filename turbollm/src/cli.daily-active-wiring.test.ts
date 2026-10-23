// Source-level guard: `daily_active` must be re-checked on a timer, not only at boot.
//
// `Emitter.dailyActive()` is idempotent per day (ledger key `daily:<date>`), but its only call used
// to be the one at startup — so a desktop app, container or Android daemon left running across
// midnight was counted on its boot day only. cli.ts is top-level module code (importing it boots the
// daemon), so the wiring can only be pinned by scanning it. Precedent: cli.auto-load-wiring.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'utf8')

// A daemonTick: an unref'd setInterval, which the restart keeper stops (util/daemon-ticks.ts).
test('daily_active is emitted from a recurring timer, not only at boot', () => {
  assert.match(CLI, /daemonTick\(\(\) => \{[^}]*\btelemetry\.dailyActive\(\)[^}]*\}, [^)]*\)/)
})
