// cli.ts boots the daemon on import, so it cannot be loaded in a unit test. This guard reads
// the source to pin one wiring rule instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), 'utf8')

test('the auto-update scheduler asks the engine-work slot before applying an update (G-1)', () => {
  const call = source.match(/applyEngineUpdate\(\{[^}]*\}\s*,\s*engine\)/)?.[0] ?? ''
  assert.match(call, /workBusy:\s*\(\)\s*=>\s*engineWorkBusy\(deps\)/)
  assert.match(source, /import \{ engineWorkBusy \} from '\.\/api\/routes'/)
})

test('the auto-update scheduler hands the model router to the update so pool slots are honoured', () => {
  const call = source.match(/applyEngineUpdate\(\{[^}]*\}\s*,\s*engine\)/)?.[0] ?? ''
  assert.match(call, /\bmodelRouter\b/)
})
