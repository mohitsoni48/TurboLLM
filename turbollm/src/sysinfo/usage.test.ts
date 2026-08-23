// Lifecycle tests for the usage sampling loop (ADR-383). The real readers spawn processes and
// depend on the host's hardware, so everything here runs against an injected fake: what is under
// test is the LOOP's contract — start once, never overlap, always resolve, latch off a dead
// reader, and tear the child down — not any vendor's output format (that is usage-parse.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setReaderForTests,
  __tickForTests,
  createLatchingReader,
  pickReader,
  requestUsage,
  stopUsageMonitor,
} from './usage'
import type { GpuReader } from './usage'
import type { GpuSample } from './usage-parse'
import type { SysInfo } from './sysinfo'

const sysWith = (...gpus: SysInfo['gpus']): SysInfo => ({
  os: 'linux/x64',
  cpu: 'test',
  cores: 8,
  ramMB: 64000,
  gpus,
})

function fakeReader(over: Partial<GpuReader> & { onRead?: () => Promise<GpuSample[] | null> } = {}) {
  const calls = { start: 0, stop: 0, read: 0 }
  const reader: GpuReader = {
    kind: 'fake',
    start: () => {
      calls.start++
    },
    stop: () => {
      calls.stop++
    },
    read: async () => {
      calls.read++
      return over.onRead ? over.onRead() : []
    },
  }
  return { reader, calls }
}

test('requestUsage: starts the reader exactly once, even for concurrent callers', async (t) => {
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
  })
  const { reader, calls } = fakeReader()
  __setReaderForTests(reader)

  await Promise.all([requestUsage(), requestUsage(), requestUsage()])
  assert.equal(calls.start, 1, 'three concurrent callers must not spawn three readers')
})

test('stopUsageMonitor: tears the reader down and is idempotent', async (t) => {
  t.after(() => __setReaderForTests(null))
  const { reader, calls } = fakeReader()
  __setReaderForTests(reader)

  await requestUsage()
  stopUsageMonitor()
  stopUsageMonitor()
  assert.equal(calls.stop, 1, 'a second stop must not re-stop an already-stopped reader')
})

test('requestUsage: a reader that rejects still resolves, with null usage', async (t) => {
  // Fail open (ADR-349's convention): a broken vendor tool must degrade the GPU fields to dashes,
  // never reject the HTTP request and never surface an error to the user.
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
  })
  const { reader } = fakeReader({ onRead: () => Promise.reject(new Error('nvidia-smi exploded')) })
  __setReaderForTests(reader)

  const u = await requestUsage()
  assert.ok(Array.isArray(u.gpus))
  for (const g of u.gpus) {
    assert.equal(g.utilPct, null)
    assert.equal(g.vramUsedMb, null)
  }
})

test('requestUsage: RAM is always readable, and used never exceeds total', async (t) => {
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
  })
  __setReaderForTests(fakeReader().reader)

  const u = await requestUsage()
  assert.ok(u.ram.totalMb > 0, 'os.totalmem() must report something')
  assert.ok(u.ram.usedMb >= 0 && u.ram.usedMb <= u.ram.totalMb)
  assert.ok(u.sampledAt > 0)
})

test('cpuPct is null on the first sample and a real number on the next', async (t) => {
  // The first tick has no predecessor to difference against. Reporting 0 there would draw an idle
  // CPU bar for one tick every time the monitor opens.
  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
  })
  __setReaderForTests(fakeReader().reader)

  const first = await requestUsage()
  assert.equal(first.cpuPct, null)

  // The loop's real interval is 1 s. Back-to-back ticks would share a millisecond, giving a zero
  // CPU-time delta — which correctly reports null — so wait long enough for the OS counters
  // (~15.6 ms granularity on Windows) to actually move.
  await new Promise((r) => setTimeout(r, 80))
  const second = await __tickForTests()
  assert.ok(typeof second.cpuPct === 'number', `expected a number, got ${second.cpuPct}`)
  assert.ok(second.cpuPct >= 0 && second.cpuPct <= 100)
})

test('createLatchingReader: stops calling a reader that has failed three times', async () => {
  // A box with no nvidia-smi would otherwise spawn a doomed process every second, forever.
  let sampled = 0
  const r = createLatchingReader('flaky', async () => {
    sampled++
    throw new Error('nope')
  })

  for (let i = 0; i < 6; i++) assert.equal(await r.read(), null)
  assert.equal(sampled, 3, 'the reader must latch off after 3 consecutive failures')
})

test('createLatchingReader: a success resets the failure counter', async () => {
  let sampled = 0
  let succeed = false
  const r = createLatchingReader('flappy', async () => {
    sampled++
    if (!succeed) throw new Error('nope')
    return [{ id: '0', name: 'g', utilPct: 1, vramUsedMb: 1, vramTotalMb: 2, vramSharedMb: null }]
  })

  await r.read()
  await r.read() // two failures — one short of the latch
  succeed = true
  assert.ok(await r.read(), 'third call succeeds')
  succeed = false
  await r.read()
  await r.read()
  await r.read() // three fresh failures re-latch
  await r.read() // must be a no-op now
  assert.equal(sampled, 6)
})

test('pickReader: a CPU-only box gets the null reader, not a doomed vendor probe', async () => {
  const r = pickReader(sysWith())
  assert.equal(r.kind, 'null')
  assert.equal(await r.read(), null)
})

test('pickReader: any NVIDIA card wins, even beside an integrated GPU', () => {
  // ADR-306: the iGPU contributes nothing to the VRAM budget, so there is no reason to also pay
  // for the (far more expensive) vendor-neutral Windows counter stream on such a box.
  const r = pickReader(
    sysWith(
      { name: 'Intel UHD Graphics 770', vramMb: 2000, vendor: 'intel', unified: true },
      { name: 'NVIDIA GeForce RTX 5070 Ti', vramMb: 16303, vendor: 'nvidia' },
    ),
  )
  assert.equal(r.kind, 'nvidia')
})
