// The onSettled observer added for ADR-299's onboarding_step. Tested here rather
// than in the telemetry suite because the guarantee under test is BuildState's:
// that it reports both terminal outcomes, and that a broken observer cannot
// affect a build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuildState } from './build-state'
import { ProvisionState } from './provision-state'

function started(): BuildState {
  const b = new BuildState()
  b.start('llama.cpp')
  return b
}

test('BuildState.onSettled: fires with ok=true on done()', () => {
  const seen: boolean[] = []
  const b = started()
  b.onSettled = (ok) => seen.push(ok)
  b.done()
  assert.deepEqual(seen, [true])
})

test('BuildState.onSettled: fires with ok=false on fail()', () => {
  const seen: boolean[] = []
  const b = started()
  b.onSettled = (ok) => seen.push(ok)
  b.fail('cmake exited 1')
  assert.deepEqual(seen, [false])
})

test('BuildState.onSettled: an observer that throws does not break the build', () => {
  const b = started()
  b.onSettled = () => {
    throw new Error('telemetry exploded')
  }
  assert.doesNotThrow(() => b.done())
  assert.equal(b.get().phase, 'done', 'terminal state is still recorded')
})

test('BuildState: no observer is fine', () => {
  const b = started()
  assert.doesNotThrow(() => b.done())
})

// ProvisionState carries the same observer for the engine_install step.
test('ProvisionState.onSettled: reports both outcomes and survives a throwing observer', () => {
  const seen: boolean[] = []
  const p = new ProvisionState()
  p.onSettled = (ok) => seen.push(ok)
  p.done()
  p.fail('404 fetching release asset')
  assert.deepEqual(seen, [true, false])

  const q = new ProvisionState()
  q.onSettled = () => {
    throw new Error('telemetry exploded')
  }
  assert.doesNotThrow(() => q.done())
})

// failReason (telemetry-review follow-up): fail()'s raw string must be classified
// BEFORE it reaches onSettled — the observer may never see free text (same
// invariant the doc comment on onSettled states).
test('ProvisionState.onSettled: fail() classifies the error into a failReason enum, never passes the raw string', () => {
  const seen: Array<{ ok: boolean; failReason?: string }> = []
  const p = new ProvisionState()
  p.onSettled = (ok, failReason) => seen.push({ ok, failReason })
  p.fail('404 fetching release asset')
  assert.deepEqual(seen, [{ ok: false, failReason: 'no_asset' }])
})

test('ProvisionState.onSettled: done() reports ok with no failReason', () => {
  const seen: Array<{ ok: boolean; failReason?: string }> = []
  const p = new ProvisionState()
  p.onSettled = (ok, failReason) => seen.push({ ok, failReason })
  p.done()
  assert.deepEqual(seen, [{ ok: true, failReason: undefined }])
})
