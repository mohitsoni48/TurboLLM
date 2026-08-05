// Auto-reprobe staleness detection (GitHub #43 follow-up): installing a fixed
// TurboLLM build does NOT retroactively fix an already-cached, mis-probed engine —
// ensureProbed() must recognize the stale signature and reprobe it automatically.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStaleCapabilities } from './registry'

test('flags an engine that still carries the removed draft-max/draft-min flags', () => {
  assert.equal(isStaleCapabilities(['--mtp-head', '--draft-max', '--draft-min'], []), true)
})

test('flags an engine carrying any one of the removed draft-family flags', () => {
  assert.equal(isStaleCapabilities(['--draft'], []), true)
  assert.equal(isStaleCapabilities(['--draft-n'], []), true)
  assert.equal(isStaleCapabilities(['--draft-n-min'], []), true)
})

test('flags the pre-existing spec-type-without-enum staleness case', () => {
  assert.equal(isStaleCapabilities(['--spec-type', '--mtp-head'], []), true)
})

test('does not flag a fresh, fully-probed modern engine', () => {
  assert.equal(
    isStaleCapabilities(
      ['--mtp-head', '--spec-draft-n-max', '--spec-draft-n-min', '--spec-type', 'spec-type:draft-mtp'],
      [{ name: '--mtp-head', kind: 'valued' }],
    ),
    false,
  )
})

test('does not flag an engine with no speculative-decoding flags at all', () => {
  assert.equal(isStaleCapabilities(['--parallel', '--cache-type-k'], []), false)
})

test('flags an engine probed before flagInfo existed (undefined), even with otherwise-modern flags', () => {
  assert.equal(
    isStaleCapabilities(['--mtp-head', '--spec-draft-n-max', '--spec-draft-n-min', '--spec-type', 'spec-type:draft-mtp'], undefined),
    true,
  )
})

test('does not flag an engine that has flagInfo, even if it is an empty array (genuinely no extra flags)', () => {
  assert.equal(isStaleCapabilities(['--parallel'], []), false)
})
