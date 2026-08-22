// Drift guard for the ADR-376 final review's M-5.
//
// `web/src/lib/link-constants.ts` is a deliberate hand-synced MIRROR of the constants
// below: the web bundle cannot import from `src/`, and this follows the same convention
// as `lib/types.ts`. That decision stands — but a mirror across a wire boundary only
// stays honest if something checks it, and the review flagged that nothing did. So rather
// than restructure the mirror, read the file as TEXT and compare the values it declares.
//
// Text, not an import: `src/` is compiled with a different tsconfig than `web/`, and this
// test must not become the one thing that couples them at build time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINK_CAPABILITIES } from './types'
import { LINK_PRESETS } from './capabilities'

const MIRROR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'lib', 'link-constants.ts')
const source = readFileSync(MIRROR, 'utf8')

/** Pull the string literals out of one `[ ... ]` block, in order. */
function literals(block: string): string[] {
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function arrayAfter(marker: string): string[] {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `${marker} not found in ${MIRROR}`)
  const open = source.indexOf('[', at)
  const close = source.indexOf(']', open)
  assert.ok(open !== -1 && close !== -1, `could not read the array after ${marker}`)
  return literals(source.slice(open, close))
}

test('the web mirror declares exactly the same capabilities, in the same order', () => {
  assert.deepEqual(arrayAfter('export const LINK_CAPABILITIES'), [...LINK_CAPABILITIES])
})

test('the web mirror declares exactly the same presets', () => {
  for (const [name, caps] of Object.entries(LINK_PRESETS)) {
    assert.deepEqual(arrayAfter(`  ${name}: `), [...caps], `preset "${name}" has drifted`)
  }
})

test('the web mirror never grows an engines capability, in any spelling', () => {
  // ADR-139: engine add/scan executes a caller-supplied binary path, so no remote caller
  // gets it — enforced on the server by LINK_CAPABILITIES, and here so the UI can never
  // render a toggle for something the server would reject anyway.
  assert.ok(!/'engines:/.test(source), 'engines:* must never appear in the link UI constants')
})
