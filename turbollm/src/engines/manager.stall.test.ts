// Load stall timeout (scalability review 4.8). ADR-067's one global load lock is KEPT, held through readiness, but a
// load that shows no progress for LOAD_STALL_MS ends early and frees the lock, instead of holding it for the full
// READINESS_TIMEOUT_MS. Progress = new engine log bytes, or a change in the readiness probe's answer. These tests drive
// the real readiness loop and the real load gate with a fake child (never spawned), an injected clock (no real waits)
// and an injected probe (no port is touched).
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { ConfigStore } from '../config/config'
import { loadTiming, Manager, type ProbeResult } from './manager'
import { tmpDir } from '../test-support/tmp'

const real = { ...loadTiming }
afterEach(() => Object.assign(loadTiming, real))
beforeEach(() => { loadTiming.processActivity = () => null }) // never read a real /proc here

const MIN = 60_000
/** The text a user reads for a stalled load. */
const STALL_TEXT = 'The engine made no progress for 2 minutes while loading'

/** A virtual clock: sleeping advances it and yields once, so awaiting loops run to completion without waiting. */
function fakeClock(onTick: (nowMs: number) => void = () => {}) {
  let now = 1_000_000
  loadTiming.now = () => now
  loadTiming.sleep = async (ms) => {
    now += ms
    onTick(now)
    await new Promise((r) => setImmediate(r))
  }
  return { elapsed: (since: number) => now - since, get now() { return now } }
}

const down: ProbeResult = { ready: false, answer: 'down' }

/** A Manager mid-load: starting, with a never-spawned child and a log file of its own. */
function startingManager(kind: string, stallSeconds?: number, logDir = tmpDir('tllm-stall-')) {
  const store = ConfigStore.load(join(logDir, 'config.json'))
  if (stallSeconds !== undefined) store.update((c) => { c.engineLoadStallSeconds = stallSeconds })
  const m = new Manager(store)
  const logPath = join(logDir, `${kind}.log`)
  writeFileSync(logPath, '[turbollm] starting engine\n')
  let killed = 0
  const child = { kill: () => { killed++; return true } } as unknown as ChildProcess
  const priv = m as unknown as Record<string, unknown>
  priv.child = child
  priv.state = 'starting'
  priv.opts = { engine: { kind } }
  priv.logPathStr = logPath
  priv.pid = 4242
  return {
    m, logPath, child, killed: () => killed,
    /** The load as startInternal runs it: the readiness loop in the background, the gate held until it settles. */
    async hold(): Promise<void> {
      void (m as unknown as { readiness(c: ChildProcess, p: number): Promise<void> }).readiness(child, 1)
      await (m as unknown as { awaitNotStarting(): Promise<void> }).awaitNotStarting()
    },
  }
}

test('a silent hung load fails after the stall window, frees the lock, and the next queued load proceeds', async () => {
  const clock = fakeClock()
  loadTiming.probe = async () => down
  const a = startingManager('llama-server')
  const b = startingManager('llama-server')
  const events: string[] = []
  const t0 = clock.now
  const runExclusive = (Manager as unknown as { runExclusive<T>(fn: () => Promise<T>): Promise<T> }).runExclusive

  const loadA = runExclusive(async () => { events.push('a-start'); await a.hold(); events.push(`a-end@${clock.elapsed(t0) / MIN}min`) })
  const loadB = runExclusive(async () => { events.push('b-start'); b.m.stop(); events.push('b-got-lock') })
  await Promise.all([loadA, loadB])

  const st = a.m.status()
  assert.equal(st.state, 'error')
  assert.equal(st.err?.code, 'readiness_timeout', 'same code as a readiness timeout, so telemetry and the exit handler treat it alike')
  assert.ok(st.err?.message.startsWith(STALL_TEXT), st.err?.message)
  assert.equal(a.killed(), 1, 'the stalled engine is stopped')
  assert.deepEqual(events.slice(0, 2), ['a-start', events[1]])
  assert.match(events[1], /^a-end@2(\.\d+)?min$/, 'freed at the stall window, not the 10-minute cap')
  assert.deepEqual([events[0], events[2], events[3]], ['a-start', 'b-start', 'b-got-lock'])
})

test('a slow load that keeps logging is not failed', async () => {
  const t0 = 1_000_000
  let ready = false
  // Output every 60 s for 8 minutes (far past the stall window), then the engine answers.
  const run = startingManager('llama-server')
  let last = 0
  const clock = fakeClock((now) => {
    if (now - t0 - last >= MIN) { last = now - t0; appendFileSync(run.logPath, '.....\n') }
    if (now - t0 >= 8 * MIN) ready = true
  })
  loadTiming.probe = async () => ({ ready, answer: ready ? '200' : 'down' })

  await run.hold()

  assert.equal(run.m.status().state, 'running')
  assert.equal(run.killed(), 0)
  assert.ok(clock.elapsed(t0) >= 8 * MIN)
})

test('a change in the probe answer counts as progress (the port starting to accept connections)', async () => {
  const t0 = 1_000_000
  let ready = false
  const run = startingManager('llama-server')
  const clock = fakeClock((now) => { if (now - t0 >= 5 * MIN) ready = true })
  // Silent log; answers: down for 100 s, then 503 (loading) for 100 s, then 404-ish for 100 s, ... never silent for 120 s straight.
  loadTiming.probe = async () => {
    const s = (clock.now - t0) / 1000
    const answer = ready ? '200' : s < 100 ? 'down' : s < 200 ? '503' : s < 300 ? '503/503' : '503/200x'
    return { ready, answer }
  }
  await run.hold()
  assert.equal(run.m.status().state, 'running')
  assert.equal(run.killed(), 0)
})

test('the 10-minute overall cap still applies to a load that keeps logging', async () => {
  const t0 = 1_000_000
  const run = startingManager('llama-server')
  // (the load gate's own 200 ms polls tick the same clock, so fire on crossing a 30 s mark, not on landing on one)
  let marks = 0
  const clock = fakeClock((now) => {
    if (Math.floor((now - t0) / 30_000) > marks) { marks++; appendFileSync(run.logPath, 'still going\n') }
  })
  loadTiming.probe = async () => down

  await run.hold()

  const st = run.m.status()
  assert.equal(st.state, 'error')
  assert.equal(st.err?.code, 'readiness_timeout')
  assert.match(st.err?.message ?? '', /did not become ready within 600 seconds/)
  assert.equal(run.killed(), 1)
  assert.ok(clock.elapsed(t0) > 10 * MIN && clock.elapsed(t0) < 10 * MIN + 5_000)
})

test('Python engines are exempt: a silent compile or warm-up is not stall-failed before the cap', async () => {
  for (const kind of ['vllm', 'sglang', 'mlx', 'rapid-mlx', 'mlx-vlm', 'litert-lm', 'laya']) {
    const t0 = 1_000_000
    const run = startingManager(kind)
    const clock = fakeClock()
    loadTiming.probe = async () => down
    // The Python load-failure scan reads the log tail; nothing in this one matches, so only the clock can end it.
    await run.hold()
    const st = run.m.status()
    assert.match(st.err?.message ?? '', /did not become ready within 600 seconds/, kind)
    assert.ok(clock.elapsed(t0) > 10 * MIN, kind)
  }
})

const WARMUP = 'common_init_from_params: warming up the model with an empty run - please wait ... (--no-warmup to disable)\n'

test('once the engine logs its warm-up, five silent minutes (experts paging in) do not stall-fail the load', async () => {
  const t0 = 1_000_000
  let ready = false
  const run = startingManager('llama-server')
  let wrote = false
  const clock = fakeClock((now) => {
    if (!wrote && now - t0 >= 30_000) { wrote = true; appendFileSync(run.logPath, WARMUP) }
    if (now - t0 >= 6 * MIN) ready = true
  })
  loadTiming.probe = async () => ({ ready, answer: ready ? '200' : '503' })
  await run.hold()
  assert.equal(run.m.status().state, 'running')
  assert.equal(run.killed(), 0)
  assert.ok(clock.elapsed(t0) >= 6 * MIN)
})

test('the warm-up marker is matched in the fork variants too', async () => {
  for (const line of ['warming up the model with an empty run', 'llama_init_from_gpt_params: warming up the model with an empty run - please wait ... (--no-warmup to disable)', 'WARMING UP THE MODEL']) {
    const t0 = 1_000_000
    let ready = false
    let wrote = false
    const run = startingManager('llama-server')
    fakeClock((now) => {
      if (!wrote) { wrote = true; appendFileSync(run.logPath, line + '\n') }
      if (now - t0 >= 4 * MIN) ready = true
    })
    loadTiming.probe = async () => ({ ready, answer: ready ? '200' : '503' })
    await run.hold()
    assert.equal(run.m.status().state, 'running', line)
  }
})

test('an argv line mentioning --no-warmup is not the warm-up marker: a silent hang is still stalled', async () => {
  const clock = fakeClock()
  loadTiming.probe = async () => down
  const run = startingManager('llama-server')
  appendFileSync(run.logPath, '[turbollm] command: llama-server -m x.gguf --no-warmup\n')
  await run.hold()
  assert.ok(run.m.status().err?.message.startsWith(STALL_TEXT), run.m.status().err?.message)
  assert.ok(clock.elapsed(1_000_000) < 3 * MIN)
})

test('a failed engine-log stream disables the stall timer for that load', async () => {
  const t0 = 1_000_000
  let ready = false
  const run = startingManager('llama-server')
  ;(run.m as unknown as { logStreamFailed: boolean }).logStreamFailed = true
  fakeClock((now) => { if (now - t0 >= 5 * MIN) ready = true })
  loadTiming.probe = async () => ({ ready, answer: ready ? '200' : 'down' })
  await run.hold()
  assert.equal(run.m.status().state, 'running')
  assert.equal(run.killed(), 0)
})

test('the engine process doing I/O or burning CPU counts as progress', async () => {
  const t0 = 1_000_000
  let ready = false
  const run = startingManager('llama-server')
  const seen: number[] = []
  const clock = fakeClock((now) => { if (now - t0 >= 6 * MIN) ready = true })
  // The counter moves every 30 s: the process is busy even though it prints nothing and /health never changes.
  loadTiming.processActivity = (pid) => { seen.push(pid); return Math.floor((clock.now - t0) / 30_000) }
  loadTiming.probe = async () => ({ ready, answer: ready ? '200' : '503' })
  await run.hold()
  assert.equal(run.m.status().state, 'running')
  assert.ok(seen.length > 0 && seen.every((p) => p === 4242), "reads the engine's own pid")
})

test('a flat process-activity counter does not rescue a truly hung load', async () => {
  const clock = fakeClock()
  loadTiming.probe = async () => down
  loadTiming.processActivity = () => 7
  const run = startingManager('llama-server')
  await run.hold()
  assert.ok(run.m.status().err?.message.startsWith(STALL_TEXT), run.m.status().err?.message)
  assert.equal(run.killed(), 1)
  assert.ok(clock.elapsed(1_000_000) < 3 * MIN)
})

test('the stall window comes from config: a longer one outlasts the default, and the message names it', async () => {
  const clock = fakeClock()
  loadTiming.probe = async () => down
  const run = startingManager('llama-server', 240)
  await run.hold()
  assert.ok(run.m.status().err?.message.startsWith('The engine made no progress for 4 minutes while loading'), run.m.status().err?.message)
  assert.ok(clock.elapsed(1_000_000) >= 4 * MIN && clock.elapsed(1_000_000) < 5 * MIN)
})

test('engineLoadStallSeconds 0 disables the stall watch: only the 10-minute cap applies', async () => {
  const clock = fakeClock()
  loadTiming.probe = async () => down
  const run = startingManager('llama-server', 0)
  await run.hold()
  assert.match(run.m.status().err?.message ?? '', /did not become ready within 600 seconds/)
  assert.ok(clock.elapsed(1_000_000) > 10 * MIN)
})
