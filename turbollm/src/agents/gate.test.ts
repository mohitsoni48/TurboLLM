// Unit tests for GenerationGate — see gate.ts's own doc comment for the incident that added
// signal/timeout support: a stuck holder used to wedge every future acquire() forever, with no
// way for a caller's own Stop/cancellation to give up on the wait. Small real timeouts (tens of
// ms) are used instead of mocked timers to keep these fast without adding a fake-timer dependency.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { GenerationGate } from './gate'

test('GenerationGate: acquire/release round trip — a free gate grants immediately', async () => {
  const gate = new GenerationGate()
  const release = await gate.acquire('bg')
  assert.equal(typeof release, 'function')
  release() // should not throw
})

test('GenerationGate: a second acquire queues behind the first and is granted on release', async () => {
  const gate = new GenerationGate()
  const release1 = await gate.acquire('bg')
  let granted = false
  const p = gate.acquire('bg').then((release2) => { granted = true; release2() })
  await delay(10)
  assert.equal(granted, false, 'should still be queued while the first holder has not released')
  release1()
  await p
  assert.equal(granted, true)
})

test('GenerationGate: fg jumps ahead of already-queued bg waiters', async () => {
  const gate = new GenerationGate()
  const release1 = await gate.acquire('bg') // holds the gate
  const order: string[] = []
  const bgP = gate.acquire('bg').then((r) => { order.push('bg'); r() })
  await delay(5) // ensure bg is queued first
  const fgP = gate.acquire('fg').then((r) => { order.push('fg'); r() })
  await delay(5)
  release1()
  await Promise.all([bgP, fgP])
  assert.deepEqual(order, ['fg', 'bg'])
})

test('GenerationGate: an AbortSignal firing while queued rejects the wait instead of hanging', async () => {
  const gate = new GenerationGate()
  const release1 = await gate.acquire('bg') // holds the gate so the next acquire queues
  const ac = new AbortController()
  const p = gate.acquire('bg', { signal: ac.signal })
  await delay(10)
  ac.abort()
  await assert.rejects(p, /gate_acquire_aborted/)
  release1() // should not throw even though nobody was waiting anymore
})

test('GenerationGate: an already-aborted signal rejects immediately without ever queueing', async () => {
  const gate = new GenerationGate()
  const release1 = await gate.acquire('bg')
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(gate.acquire('bg', { signal: ac.signal }), /gate_acquire_aborted/)
  release1()
})

test('GenerationGate: a stuck holder self-heals — a queued waiter times out and rejects rather than hanging forever', async () => {
  const gate = new GenerationGate()
  await gate.acquire('bg') // held forever — simulates a leaked release, the real-world bug this fixes
  await assert.rejects(
    gate.acquire('bg', { timeoutMs: 30 }),
    /gate_acquire_timeout/,
  )
})

test('GenerationGate: a timed-out waiter does not consume the slot — the NEXT real waiter still gets granted on release', async () => {
  const gate = new GenerationGate()
  const release1 = await gate.acquire('bg')
  const timedOut = gate.acquire('bg', { timeoutMs: 20 })
  await assert.rejects(timedOut, /gate_acquire_timeout/)
  // A fresh waiter queued AFTER the timeout should still be granted normally once released.
  const p2 = gate.acquire('bg')
  release1()
  const release2 = await p2
  assert.equal(typeof release2, 'function')
  release2()
})

test('GenerationGate: calling release twice is a no-op (does not grant the gate to two waiters)', async () => {
  const gate = new GenerationGate()
  const release1 = await gate.acquire('bg')
  release1()
  release1() // second call must not free a second "slot"
  const release2 = await gate.acquire('bg')
  let secondGranted = false
  const p3 = gate.acquire('bg').then((r) => { secondGranted = true; r() })
  await delay(10)
  assert.equal(secondGranted, false)
  release2()
  await p3
  assert.equal(secondGranted, true)
})
