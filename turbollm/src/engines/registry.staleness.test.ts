// Auto-reprobe staleness detection (GitHub #43 follow-up): installing a fixed
// TurboLLM build does NOT retroactively fix an already-cached, mis-probed engine —
// ensureProbed() must recognize the stale signature and reprobe it automatically.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStaleCapabilities } from './registry'

test('does NOT flag an engine that only has removed draft flags (genuinely old build)', () => {
  // A genuinely-old llama.cpp really supports --draft-max/--draft-min.
  // The reprobe would re-capture the same flags, so it's a no-op — don't waste ~15s.
  assert.equal(isStaleCapabilities(['--mtp-head', '--draft-max', '--draft-min'], []), false)
})

test('does NOT flag an engine carrying only one removed draft-family flag (genuinely old build)', () => {
  // Only a mis-probed *new* build has both a removed flag AND a successor flag.
  // A genuinely-old build has the removed flag but not the successor.
  assert.equal(isStaleCapabilities(['--draft'], []), false)
  assert.equal(isStaleCapabilities(['--draft-n'], []), false)
  assert.equal(isStaleCapabilities(['--draft-n-min'], []), false)
})

test('flags an engine carrying BOTH a removed AND a successor draft flag (mis-probed new build)', () => {
  // Only a mis-probed new build has both — the removed flag from old-era probing
  // and the successor from a later reprobe. This NEEDS a fresh probe.
  assert.equal(isStaleCapabilities(['--draft', '--spec-draft-n-max'], []), true)
  assert.equal(isStaleCapabilities(['--draft-max', '--draft-min', '--spec-draft-n-max', '--spec-draft-n-min'], []), true)
  assert.equal(isStaleCapabilities(['--draft', '--draft-n', '--spec-draft-n-min'], []), true)
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
