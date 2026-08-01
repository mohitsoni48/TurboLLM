// Regression coverage for Manager.parallelSlots() — the number the engine gate and the launched
// agent CLI are both sized from.
//
// Read off the RUNNING process's launch args rather than the saved profile on purpose: the two
// diverge the moment a profile is edited while an engine is up, and sizing a concurrency limit
// from the wrong one silently over- or under-subscribes the engine.
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** The pure extraction, mirrored from Manager.parallelSlots() so it can be exercised without
 *  standing up a real Manager (which needs a ConfigStore, a spawned engine and a live port). */
function slotsFromArgs(args: string[] | undefined): number | null {
  if (!args) return null
  const i = args.indexOf('--parallel')
  if (i === -1 || i + 1 >= args.length) return null
  const n = Number(args[i + 1])
  return Number.isInteger(n) && n > 0 ? n : null
}

test('parallelSlots: reads the real slot count out of the launch args', () => {
  assert.equal(slotsFromArgs(['-m', 'model.gguf', '--parallel', '1', '--flash-attn', 'on']), 1)
  assert.equal(slotsFromArgs(['--parallel', '4']), 4)
})

test('parallelSlots: null when the engine advertises no --parallel at all', () => {
  // vLLM / mlx-lm do their own continuous batching. Callers treat null as "unbounded" — capping
  // them at 1 because we could not read a flag would be a new restriction, not a safe default.
  assert.equal(slotsFromArgs(['--served-model-name', 'local', '--max-model-len', '8192']), null)
  assert.equal(slotsFromArgs([]), null)
  assert.equal(slotsFromArgs(undefined), null)
})

test('parallelSlots: a malformed or trailing --parallel is null, never NaN or 0', () => {
  // NaN would make `inFlight < capacity` false forever and wedge the gate; 0 would refuse every
  // request. Both are worse than falling back to unbounded.
  assert.equal(slotsFromArgs(['--parallel']), null, 'trailing flag with no value')
  assert.equal(slotsFromArgs(['--parallel', 'abc']), null)
  assert.equal(slotsFromArgs(['--parallel', '0']), null)
  assert.equal(slotsFromArgs(['--parallel', '-2']), null)
  assert.equal(slotsFromArgs(['--parallel', '2.5']), null)
})
