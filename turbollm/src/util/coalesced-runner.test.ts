// CoalescedRunner contract C1-C4 (architecture.md §3.1, ADR-425).
//
// The fake task parks every execution on a deferred the test settles by hand, so each test chooses
// the exact interleaving instead of hoping a timer lands in the window that matters.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CoalescedRunner } from './coalesced-runner'

type Deferred = ReturnType<typeof deferred>

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((r) => setImmediate(r))

function controllableRunner() {
  const runs: Deferred[] = []
  const stats = { starts: 0, active: 0, maxActive: 0 }
  const runner = new CoalescedRunner(async () => {
    stats.starts++
    stats.active++
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    const run = deferred()
    runs.push(run)
    try {
      await run.promise
    } finally {
      stats.active--
    }
  }, () => {})

  const finishRun = async (index: number) => {
    assert.ok(runs[index], `execution ${index + 1} never started`)
    runs[index].resolve()
    await flush()
  }

  return { runner, stats, finishRun }
}

function watchCompletion(request: Promise<void>) {
  const completion = { done: false }
  void request.then(() => { completion.done = true })
  return completion
}

test('a request on an idle runner starts the task synchronously', async () => {
  const { runner, stats, finishRun } = controllableRunner()

  const request = runner.request()

  assert.equal(stats.starts, 1)
  await finishRun(0)
  await request
})

test('requests made during one execution never overlap it and share exactly one follow-up (C1, C3)', async () => {
  const { runner, stats, finishRun } = controllableRunner()

  const requests = [runner.request()]
  for (let i = 0; i < 5; i++) requests.push(runner.request())
  await finishRun(0)

  assert.equal(stats.starts, 2)
  await finishRun(1)
  await Promise.all(requests)
  assert.equal(stats.starts, 2)
  assert.equal(stats.maxActive, 1)
})

test('a request made during an execution resolves only after the follow-up finishes (C2)', async () => {
  const { runner, finishRun } = controllableRunner()

  const a = watchCompletion(runner.request())
  const b = watchCompletion(runner.request())
  await finishRun(0)

  assert.equal(a.done, true)
  assert.equal(b.done, false)
  await finishRun(1)
  assert.equal(b.done, true)
})

test('a request made while a follow-up is queued joins that follow-up', async () => {
  const { runner, stats, finishRun } = controllableRunner()

  void runner.request()
  void runner.request()
  const c = watchCompletion(runner.request())
  await finishRun(0)

  assert.equal(c.done, false)
  await finishRun(1)
  assert.equal(c.done, true)
  assert.equal(stats.starts, 2)
})

test('a request made after the follow-up has started queues a new follow-up', async () => {
  const { runner, stats, finishRun } = controllableRunner()

  void runner.request()
  void runner.request()
  await finishRun(0)
  assert.equal(stats.starts, 2)

  const d = watchCompletion(runner.request())
  await finishRun(1)
  assert.equal(stats.starts, 3)
  assert.equal(d.done, false)

  await finishRun(2)
  assert.equal(d.done, true)
})

test('a rejecting task is reported to onError once, the request still resolves, and the next request runs again (C4)', async () => {
  const boom = new Error('boom')
  const reported: unknown[] = []
  let starts = 0
  const runner = new CoalescedRunner(async () => {
    starts++
    throw boom
  }, (err) => { reported.push(err) })

  await assert.doesNotReject(runner.request())

  assert.equal(reported.length, 1)
  assert.equal(reported[0], boom)
  await runner.request()
  assert.equal(starts, 2)
})

test('a task that throws before returning a promise is reported to onError once, the request still resolves, and the next request runs again (C4)', async () => {
  const boom = new Error('boom')
  const reported: unknown[] = []
  let starts = 0
  function throwBeforeReturningPromise(): Promise<void> {
    starts++
    throw boom
  }
  const runner = new CoalescedRunner(throwBeforeReturningPromise, (err) => { reported.push(err) })

  await assert.doesNotReject(runner.request())

  assert.equal(reported.length, 1)
  assert.equal(reported[0], boom)
  await runner.request()
  assert.equal(starts, 2)
})

test('a request still resolves when onError itself throws (C4)', async () => {
  const runner = new CoalescedRunner(
    async () => { throw new Error('boom') },
    () => { throw new Error('onError failed') },
  )

  await assert.doesNotReject(runner.request())
})

test('busy stays true from the first request through a queued follow-up and clears after the last execution', async () => {
  const { runner, finishRun } = controllableRunner()
  assert.equal(runner.busy, false)

  const first = runner.request()
  assert.equal(runner.busy, true)

  let busyBetweenExecutions: boolean | undefined
  void first.then(() => { busyBetweenExecutions = runner.busy })
  const followUp = runner.request()
  assert.equal(runner.busy, true)

  await finishRun(0)
  assert.equal(busyBetweenExecutions, true)
  assert.equal(runner.busy, true)

  await finishRun(1)
  await followUp
  await flush()
  assert.equal(runner.busy, false)
})
