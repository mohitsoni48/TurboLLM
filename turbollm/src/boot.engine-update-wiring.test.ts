// Source-level guard for how the boot (boot.ts) hands the background engine updater its update. Left a source scan,
// unlike the boot.*-wiring tests that run a real test daemon: the update only runs for an installed engine with a
// newer release, which an inert test daemon has neither of; applyEngineUpdate's own refusal while engine work is
// running is engines/update-apply's tests'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { source as read } from './test-support/daemon-source'

const source = read('boot.ts')

test('the auto-update scheduler asks the engine-work slot before applying an update (G-1)', () => {
  const call = source.match(/applyEngineUpdate\(\{[^}]*\}\s*,\s*engine\)/)?.[0] ?? ''
  assert.match(call, /workBusy:\s*\(\)\s*=>\s*engineWorkBusy\(deps\)/)
  assert.match(source, /import \{ engineWorkBusy \} from '\.\/api\/routes'/)
})

test('the auto-update scheduler hands the model router to the update so pool slots are honoured', () => {
  const call = source.match(/applyEngineUpdate\(\{[^}]*\}\s*,\s*engine\)/)?.[0] ?? ''
  assert.match(call, /\bmodelRouter\b/)
})
