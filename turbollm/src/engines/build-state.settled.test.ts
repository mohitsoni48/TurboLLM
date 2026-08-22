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

test('BuildState.onSettled: fires with "ok" on done()', () => {
  const seen: string[] = []
  const b = started()
  b.onSettled = (outcome) => seen.push(outcome)
  b.done()
  assert.deepEqual(seen, ['ok'])
})

test('BuildState.onSettled: fires with "fail" on fail()', () => {
  const seen: string[] = []
  const b = started()
  b.onSettled = (outcome) => seen.push(outcome)
  b.fail('cmake exited 1')
  assert.deepEqual(seen, ['fail'])
})

// cancel() (PR #105 review finding): a build the user aborted themselves must not
// be reported as a failure — it shares fail()'s terminal UI shape (phase 'error')
// but a distinct observer outcome.
test('BuildState.onSettled: fires with "cancelled" on cancel(), distinct from fail()', () => {
  const seen: string[] = []
  const b = started()
  b.onSettled = (outcome) => seen.push(outcome)
  b.cancel('Build cancelled.')
  assert.deepEqual(seen, ['cancelled'])
})

test('BuildState.cancel(): reports the SAME terminal UI shape as fail() — phase error, with the message', () => {
  const b = started()
  b.cancel('Build cancelled.')
  const status = b.get()
  assert.equal(status.phase, 'error')
  assert.equal(status.active, false)
  assert.equal(status.error, 'Build cancelled.')
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
  const seen: Array<{ ok: boolean; trigger: string; failReason?: string }> = []
  const p = new ProvisionState()
  p.onSettled = (ok, trigger, failReason) => seen.push({ ok, trigger, failReason })
  p.start('llama-server', 'user_install')
  p.fail('404 fetching release asset')
  assert.deepEqual(seen, [{ ok: false, trigger: 'user_install', failReason: 'no_asset' }])
})

test('ProvisionState.onSettled: done() reports ok with no failReason', () => {
  const seen: Array<{ ok: boolean; trigger: string; failReason?: string }> = []
  const p = new ProvisionState()
  p.onSettled = (ok, trigger, failReason) => seen.push({ ok, trigger, failReason })
  p.start('llama-server', 'user_install')
  p.done()
  assert.deepEqual(seen, [{ ok: true, trigger: 'user_install', failReason: undefined }])
})

// The trigger is what separates the unattended boot-time seed from a user actually
// choosing to install something — one event name covered both until the 2026-08-21
// data-integrity audit, which made "installed an engine" look like a user milestone
// on machines where nobody had done anything at all.
test('ProvisionState.onSettled: carries the trigger that started this run, not the default', () => {
  const seen: string[] = []
  const p = new ProvisionState()
  p.onSettled = (_ok, trigger) => seen.push(trigger)
  p.start('llama-server', 'seed')
  p.done()
  p.start('llama-server', 'user_update')
  p.fail('network unreachable')
  assert.deepEqual(seen, ['seed', 'user_update'])
})
