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

// ── capacity: the gate is a counting semaphore, sized to the engine's own slots ────────────────
// Added when gateway traffic started going through the gate. Claude Code fans out background
// subagents, each a full independent request; against a `--parallel 1` llama-server they don't
// just queue, they evict each other's cached prompt prefix so every one re-prefills. The gate now
// admits exactly as many concurrent generations as the running engine advertises.

test('GenerationGate: capacity N admits N concurrently and queues the rest', async () => {
  const gate = new GenerationGate(() => 2)
  const a = await gate.acquire('bg')
  const b = await gate.acquire('bg')
  assert.deepEqual(gate.stats(), { inFlight: 2, queued: 0, capacity: 2 })

  let thirdGranted = false
  const third = gate.acquire('bg').then((r) => { thirdGranted = true; return r })
  await delay(20)
  assert.equal(thirdGranted, false, 'the third must wait — the engine only has two slots')
  assert.equal(gate.stats().queued, 1)

  a()
  await third
  assert.equal(thirdGranted, true, 'freeing a slot admits exactly one waiter')
  assert.equal(gate.stats().inFlight, 2, 'still at capacity, not over it')
  b()
})

test('GenerationGate: capacity is re-read per admission, so a model swap takes effect live', async () => {
  // The daemon outlives any one model. A capacity captured once at construction would describe
  // whatever happened to be loaded at startup for the rest of the process's life.
  let slots = 1
  const gate = new GenerationGate(() => slots)
  const first = await gate.acquire('bg')

  let secondGranted = false
  void gate.acquire('bg').then(() => { secondGranted = true })
  await delay(20)
  assert.equal(secondGranted, false, 'capacity 1 — queued')

  slots = 3 // a bigger-slot engine loads
  first() // any release re-evaluates capacity and drains
  await delay(20)
  assert.equal(secondGranted, true, 'the waiter is admitted under the NEW capacity')
})

test('GenerationGate: one release drains every waiter the new capacity allows, not just one', async () => {
  let slots = 1
  const gate = new GenerationGate(() => slots)
  const held = await gate.acquire('bg')
  let granted = 0
  for (let i = 0; i < 3; i++) void gate.acquire('bg').then(() => { granted++ })
  await delay(20)
  assert.equal(granted, 0)

  slots = 4
  held()
  await delay(20)
  // Granting only one per release would strand the freed headroom until some unrelated release
  // happened along — the queue must be drained to the current capacity.
  assert.equal(granted, 3, 'all three fit under capacity 4')
})

test('GenerationGate: a timed-out waiter never consumes a slot from the drain loop', async () => {
  // The phantom-holder leak: counting a slot for a waiter that had already given up would shrink
  // effective capacity by one permanently.
  const gate = new GenerationGate(() => 1)
  const held = await gate.acquire('bg')
  await assert.rejects(gate.acquire('bg', { timeoutMs: 20 }), /gate_acquire_timeout/)
  const real = gate.acquire('bg')
  held()
  const release = await real
  assert.equal(gate.stats().inFlight, 1, 'exactly one holder, not a phantom plus one')
  release()
  assert.equal(gate.stats().inFlight, 0)
})

test('GenerationGate: fg still preempts queued bg under the counting gate', async () => {
  const gate = new GenerationGate(() => 1)
  const held = await gate.acquire('bg')
  const order: string[] = []
  // Every waiter is eventually granted and released — a queued acquire that is never granted sits
  // until DEFAULT_ACQUIRE_TIMEOUT_MS and then rejects, which surfaces as an unhandled rejection
  // that fails the whole file 3 minutes later rather than as a failing assertion.
  const bgWait = gate.acquire('bg').then((r) => { order.push('bg'); return r })
  await delay(5)
  const fgWait = gate.acquire('fg').then((r) => { order.push('fg'); return r })
  await delay(5)

  held()
  ;(await fgWait)()   // fg is admitted first, then hands the slot on
  ;(await bgWait)()
  assert.deepEqual(order, ['fg', 'bg'], 'the user-facing request jumps ahead of the queued bg one')
})

test('GenerationGate: Infinity capacity never queues (an engine that batches for itself)', async () => {
  // vLLM / mlx-lm advertise no --parallel; capping them at 1 because we could not read a flag
  // would be a brand-new restriction rather than a safe default.
  const gate = new GenerationGate(() => Infinity)
  const releases = await Promise.all([1, 2, 3, 4, 5].map(() => gate.acquire('bg')))
  assert.equal(gate.stats().inFlight, 5)
  assert.equal(gate.stats().queued, 0)
  for (const r of releases) r()
  assert.equal(gate.stats().inFlight, 0)
})
