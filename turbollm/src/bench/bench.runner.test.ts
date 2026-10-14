// BenchRunner driven against fakes: the search loop and measurement primitive (probing, benching and
// GPU settling stubbed on the instance, so these pin the search's own decisions — no engine, no GPU,
// no network) and the saved result's telemetry queueing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { BenchRunner, type BenchCandidate } from './bench'
import { readQueue } from '../telemetry/queue'
import { tmpDir } from '../test-support/tmp'
import { deriveDefault, type LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
    sizeBytes: 4_000_000_000, sizeLabel: '4 GB', arch: 'llama', quant: 'Q4_K_M',
    nativeCtx: 8192, blockCount: 32, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
    nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
    incomplete: false, parseError: null, loaded: false, hasProfile: false,
    benchTps: null, mtime: '', ...over,
  }
}

const SYS: SysInfo = { os: 'linux/x64', cpu: 'test', cores: 8, ramMB: 32000, gpus: [{ name: 'gpu0', vramMb: 24000, vendor: 'nvidia' }] }
const CAPS = { kvTypes: ['f16', 'q8_0'], flags: [] as string[] }

/** The private surface these tests drive or stub. */
interface RunnerInternals {
  deadline: number
  cancelled: boolean
  probeVram: (...a: unknown[]) => Promise<{ outcome: 'ok'; vramAbsMb: number | null; spillMb: number | null }>
  settleGpu: (...a: unknown[]) => Promise<void>
  benchAt: (e: ModelEntry, s: SysInfo, p: LoadProfile, ...rest: unknown[]) => Promise<null>
  denseSearch: (e: ModelEntry, s: SysInfo, p: LoadProfile, caps: typeof CAPS, results: BenchCandidate[], headroomMb: number) => Promise<unknown>
  measure: (e: ModelEntry, s: SysInfo, p: LoadProfile, caps: typeof CAPS, label: string, stepPrefix: string) => Promise<BenchCandidate>
  queueTelemetry: (record: unknown, entry: ModelEntry, sys: SysInfo, appVersion: string, engineVersion: string) => void
}

function runner(store: unknown = {}): { r: RunnerInternals; started: unknown[] } {
  const started: unknown[] = []
  const manager = {
    start: async (opts: unknown) => { started.push(opts) },
    stopAndWait: async () => {},
    status: () => ({ state: 'stopped' }),
    logPath: () => null,
    target: () => null,
  }
  const registry = { active: () => ({ id: 'llama-cpp', binPath: '', version: 'b1', capabilities: CAPS }) }
  const bench = new BenchRunner(manager as never, store as never, {} as never, registry as never, 'test', {} as never)
  const r = bench as unknown as RunnerInternals
  r.deadline = Date.now() + 60_000
  return { r, started }
}

test('dense search: a model that fits everywhere is benched at blockCount + 1 (llama.cpp offloads n_layer + 1 layers)', async () => {
  // `-ngl blockCount` leaves one of llama.cpp's n_layer + 1 offloadable layers on the CPU, so a
  // search capped at blockCount could never produce a full-offload profile.
  const { r } = runner()
  r.probeVram = async () => ({ outcome: 'ok', vramAbsMb: null, spillMb: null }) // every probe fits
  r.settleGpu = async () => {}
  let benchedNgl: number | null = null
  r.benchAt = async (_e, _s, p) => { benchedNgl = p.ngl; return null }

  const m = model({ blockCount: 32 })
  await r.denseSearch(m, SYS, deriveDefault(m, SYS), CAPS, [], 1024)

  assert.equal(benchedNgl, 33)
})

test('measure: a cancelled run never starts another engine load', async () => {
  // The search loops stop on cancel, but the search then benches its best-so-far candidate —
  // that must not load the model again after the user clicked Stop.
  const { r, started } = runner()
  r.cancelled = true

  const m = model()
  const cand = await r.measure(m, SYS, deriveDefault(m, SYS), CAPS, 'ngl=33', 'Measuring ngl=33')

  assert.equal(started.length, 0, 'manager.start must not be called once cancelled')
  assert.notEqual(cand.outcome, 'ok')
})

test('saved auto-tune result is queued even when the CPU/GPU names are not identifier-safe', () => {
  // `@` (pre-12th-gen Intel), `w/` (Ryzen APUs) and lspci's `[.../...]` fail bench_result's
  // identifier check, which used to drop the event before it was ever queued.
  const dir = tmpDir('turbollm-bench-telemetry-')
  try {
    const cfg = { telemetry: { level: 'anon', machineId: '00000000-0000-0000-0000-000000000000' } }
    const { r } = runner({ snapshot: () => cfg, update: () => {}, dir: () => dir })
    const sys: SysInfo = {
      os: 'linux/x64', cpu: 'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', cores: 12, ramMB: 32000,
      gpus: [{ name: 'Navi 48 [Radeon RX 9070/9070 XT]', vramMb: 16304, vendor: 'amd' }],
    }
    const record = { modelKey: 'm|q4|1', tps: 40, ttftMs: 200, vramMb: 9000, ts: '2026-10-13T00:00:00.000Z', params: { ctx: 8192, ngl: 33, nCpuMoe: 0, parallel: 1, kvTypeK: 'f16', flashAttn: 'auto' } }

    r.queueTelemetry(record, model(), sys, '1.0.0', 'b6123')

    const queued = readQueue(dir)
    assert.equal(queued.length, 1)
    assert.equal((queued[0].event.hw as { cpu: string }).cpu, 'Intel(R) Core(TM) i7-8700K CPU 3.70GHz')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
