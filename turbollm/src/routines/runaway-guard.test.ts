// turbollm/src/routines/runaway-guard.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunDeadline } from './runaway-guard'

test('createRunDeadline aborts the signal after timeoutMs', async () => {
  const deadline = createRunDeadline(10)
  assert.equal(deadline.signal.aborted, false)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(deadline.signal.aborted, true)
})

test('cancel() prevents a later abort', async () => {
  const deadline = createRunDeadline(10)
  deadline.cancel()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(deadline.signal.aborted, false)
})
