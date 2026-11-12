// util/fetch-timeout.ts: bounded signals for the daemon's non-engine fetches (the global dispatcher has no 300 s backstop).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdleAbort, withTimeout } from './fetch-timeout'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('withTimeout aborts after the deadline with no caller signal', async () => {
  const signal = withTimeout(undefined, 20)
  assert.equal(signal.aborted, false)
  await sleep(60)
  assert.equal(signal.aborted, true)
})

test('withTimeout still aborts when the caller signal does', () => {
  const caller = new AbortController()
  const signal = withTimeout(caller.signal, 60_000)
  assert.equal(signal.aborted, false)
  caller.abort(new Error('cancelled'))
  assert.equal(signal.aborted, true)
})

test('createIdleAbort aborts only after a quiet period, and touch() resets it', async () => {
  const idle = createIdleAbort(undefined, 40)
  await sleep(25)
  idle.touch()
  await sleep(25)
  assert.equal(idle.signal.aborted, false)
  await sleep(50)
  assert.equal(idle.signal.aborted, true)
  idle.stop()
})

test('createIdleAbort follows the caller signal', () => {
  const caller = new AbortController()
  const idle = createIdleAbort(caller.signal, 60_000)
  caller.abort()
  assert.equal(idle.signal.aborted, true)
  idle.stop()
})

test('createIdleAbort stop() cancels the timer', async () => {
  const idle = createIdleAbort(undefined, 20)
  idle.stop()
  await sleep(50)
  assert.equal(idle.signal.aborted, false)
})
