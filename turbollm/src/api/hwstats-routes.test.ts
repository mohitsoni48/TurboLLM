// Route-level test for GET /api/v1/hwstats (ADR-383, plan task 3). The handler is a thin
// forwarder onto requestUsage(), so the test injects a fake reader via __setReaderForTests —
// the route must return the sampler's real shape without spawning any vendor tool.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { requestUsage, stopUsageMonitor, __setReaderForTests, type GpuReader } from '../sysinfo/usage'

function fakeApp() {
  // The hwstats route never touches `d` — a minimal double is enough for registerApi.
  const d = {
    version: 'test',
    store: { snapshot: () => ({}), update: (fn: (c: unknown) => void) => fn({}) },
    manager: { status: () => ({ state: 'stopped', model: null }) },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('GET /api/v1/hwstats returns the sampler shape', async (t) => {
  const starts: number[] = []
  const fake: GpuReader = {
    kind: 'fake',
    start: () => starts.push(1),
    // [] means "no usage data" — mergeUsage then reports every SysInfo card with null usage.
    read: async () => [],
    stop: () => {},
  }
  __setReaderForTests(fake)
  const app = fakeApp()

  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
  })

  // First call: no predecessor sample, so cpuPct is null — but the shape must be complete.
  const r1 = await app.request('/api/v1/hwstats')
  assert.equal(r1.status, 200)
  const b1 = (await r1.json()) as Record<string, unknown> & {
    cpuPct?: number | null
    ram?: { usedMb: number; totalMb: number }
    gpus?: unknown[]
    sampledAt?: number
  }
  assert.ok('cpuPct' in b1, 'body has cpuPct')
  assert.equal(b1.cpuPct, null, 'first tick has no predecessor')
  assert.ok(b1.ram && b1.ram.totalMb > 0, 'ram.totalMb > 0')
  assert.ok(Array.isArray(b1.gpus), 'gpus is an array')
  assert.ok(typeof b1.sampledAt === 'number', 'sampledAt is a number')
  assert.equal(starts.length, 1, 'the reader started exactly once')

  // Second call within the same second reuses the cached sample — still one start.
  const r2 = await app.request('/api/v1/hwstats')
  assert.equal(r2.status, 200)
  assert.equal(starts.length, 1, 'a repeat request does not restart the loop')

  // After the 1 s interval fires, the delta exists: cpuPct becomes a number in 0..100.
  await sleep(1200)
  const b3 = (await (await app.request('/api/v1/hwstats')).json()) as { cpuPct: number | null }
  assert.ok(typeof b3.cpuPct === 'number' && b3.cpuPct >= 0 && b3.cpuPct <= 100,
    `cpuPct is a clamped number after the second tick (got ${String(b3.cpuPct)})`)

  // And the module entry point the route forwards to agrees with the HTTP body.
  const direct = await requestUsage()
  assert.ok(typeof direct.cpuPct === 'number', 'requestUsage sees the same settled sample')
})

test('a reader that throws yields null usage, never a 500', async (t) => {
  const boom: GpuReader = {
    kind: 'boom',
    start: () => {},
    read: async () => {
      throw new Error('tool exploded')
    },
    stop: () => {},
  }
  __setReaderForTests(boom)
  const app = fakeApp()

  t.after(() => {
    stopUsageMonitor()
    __setReaderForTests(null)
  })

  // First call starts the loop and burns the null-cpuPct first-tick slot.
  const r1 = await app.request('/api/v1/hwstats')
  assert.equal(r1.status, 200, 'a failing reader degrades to null fields, not an error')
  const b1 = (await r1.json()) as { cpuPct: number | null; gpus: Array<{ utilPct: number | null }> }
  assert.equal(b1.cpuPct, null, 'first tick has no predecessor')
  for (const g of b1.gpus) assert.equal(g.utilPct, null, 'every card reports null usage')

  // After the 1 s interval fires, CPU/RAM keep sampling even though the GPU reader throws.
  await sleep(1200)
  const b2 = (await (await app.request('/api/v1/hwstats')).json()) as { cpuPct: number | null; gpus: Array<{ utilPct: number | null }> }
  assert.ok(typeof b2.cpuPct === 'number', 'CPU/RAM sampling is independent of the GPU reader')
  for (const g of b2.gpus) assert.equal(g.utilPct, null, 'a throwing reader stays null, never 0')
})
