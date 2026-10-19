// BenchRunner driven against fakes: the search loop and measurement primitive (probing, benching and
// GPU settling stubbed on the instance, so these pin the search's own decisions — no engine, no GPU,
// no network) and the saved result's telemetry queueing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { BenchRunner, type BenchCandidate } from './bench'
import { readQueue } from '../telemetry/queue'
import { tmpDir } from '../test-support/tmp'
import { ComfyGuard } from '../engines/comfy-guard'
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
  /** The run's engine, which start() takes; set by hand where a test drives a probe without a run. */
  engine: unknown
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
  r.engine = registry.active()
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

// Without --kv-unified, llama.cpp gives each of the `parallel` slots ctx / parallel cells (n_ctx_seq), and llama-server
// refuses a prompt longer than its slot. The bench prompt was sized from the whole ctx (75% of it), so with parallel
// above 1 every candidate's prefill was refused and auto-tune found nothing.
test('measure: with parallel slots and no unified KV, the bench prompt fits one slot', async () => {
  for (const [kvUnified, slotCtx] of [[false, 8192], [true, 32768]] as const) {
    const manager = {
      start: async () => {},
      stopAndWait: async () => {},
      status: () => ({ state: 'running' }),
      logPath: () => null,
      target: () => 'http://engine.invalid',
    }
    const registry = { active: () => ({ id: 'llama-cpp', binPath: '', version: 'b1', capabilities: CAPS }) }
    const bench = new BenchRunner(manager as never, {} as never, {} as never, registry as never, 'test', {} as never)
    const r = bench as unknown as RunnerInternals & { prefillProbe: (t: string, messages: { content: string }[]) => Promise<unknown> }
    r.deadline = Date.now() + 60_000
    r.engine = registry.active()
    let promptChars = 0
    r.prefillProbe = async (_t, messages) => {
      promptChars = messages.reduce((n, msg) => n + msg.content.length, 0)
      return { fault: 'crash' } // the prompt is all this test needs
    }
    const m = model({ nativeCtx: 32768 })
    const profile: LoadProfile = { ...deriveDefault(m, SYS), ctx: 32768, parallel: 4, kvUnified }

    await r.measure(m, SYS, profile, CAPS, 'ngl=33', 'Measuring ngl=33')

    const tokens = Math.ceil(promptChars / 4) // the bench builder's own 4 chars/token
    assert.ok(tokens > 0, 'the prefill probe was reached')
    assert.ok(tokens <= slotCtx * 0.75 + 64, `kvUnified ${kvUnified}: ~${tokens} prompt tokens for a ${slotCtx}-token slot`)
    assert.ok(tokens > slotCtx * 0.5, `kvUnified ${kvUnified}: the prompt still fills most of the slot (~${tokens} tokens)`)
  }
})

// A ComfyUI render during auto-tune: Manager.start runs no ComfyUI pre-start hook, so the sweep used to keep starting
// probes under the render (each one loading gigabytes into VRAM ComfyUI is sampling in) and release() then loaded the
// killed probe's configuration as the user's model. Driven with a real ComfyGuard wired to the runner, as cli.ts does,
// and a probe start already waiting for the global load gate when the render begins.
test('a ComfyUI render cancels auto-tune: a probe waiting for the load gate starts nothing, and release loads no probe', async () => {
  let state = 'running' // the previous probe is up
  const spawned: unknown[] = []
  let waiting = false
  let openGate!: () => void
  const gate = new Promise<void>((res) => { openGate = res })
  const manager = {
    status: () => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    currentOpts: () => (state === 'running' ? { model: { key: 'm|q4|1' } } : null),
    target: () => null,
    logPath: () => null,
    stopAndWait: async () => { state = 'stopped' },
    // Manager.start's shape: wait for the gate, run beforeStart inside it, then spawn.
    start: async (opts: unknown, hooks?: { beforeStart?: () => Promise<void> }) => {
      waiting = true
      await gate
      await hooks?.beforeStart?.()
      spawned.push(opts)
      state = 'running'
    },
  }
  const registry = { active: () => ({ id: 'llama-cpp', binPath: '', version: 'b1', capabilities: CAPS }) }
  const bench = new BenchRunner(manager as never, {} as never, {} as never, registry as never, 'test', {} as never)
  const r = bench as unknown as RunnerInternals & { state: { running: boolean } }
  r.deadline = Date.now() + 60_000
  r.state = { running: true }
  r.engine = registry.active()
  const comfyStore = { snapshot: () => ({ comfyui: { enabled: true, gatePath: '/cn', url: '', reverseGate: false, cachePersist: false } }), dir: () => '/tmp' }
  const comfy = new ComfyGuard(comfyStore as never, manager as never)
  comfy.setAutoTune(bench)

  const m = model()
  const probing = r.probeVram(m, SYS, deriveDefault(m, SYS), CAPS)
  while (!waiting) await new Promise((res) => setImmediate(res))
  await comfy.acquire()
  openGate()
  const probe = await probing

  assert.deepEqual(spawned, [], 'no probe starts under the render')
  assert.notEqual(probe.outcome, 'ok')
  assert.equal(comfy.snapshot().suspendedModelKey, null, 'the killed probe is not the model to reload')
  await comfy.release()
  assert.deepEqual(spawned, [], 'release loads no probe configuration')
})

// A run used to look the active engine up again for every probe. The primary is stopped between two probes and the
// activate route checked only the primary, so a switch there sent the rest of the run to the newly selected engine (a
// GGUF launched on vLLM with llama.cpp's -ngl flags), and the winner was saved under the engine the run started on.
// Driven through start(), with the search cut to two probes and the switch landing between them (the settle window).
test('auto-tune starts every probe on the engine it started with, and stops when another engine is selected', async () => {
  const engines = {
    cuda: { id: 'cuda', name: 'llama.cpp CUDA', kind: 'llama-server', binPath: '/e/llama-server', version: 'b1', capabilities: CAPS },
    vllm: { id: 'vllm', name: 'vLLM', kind: 'vllm', binPath: '/e/python', version: 'vllm 0.1', capabilities: { kvTypes: [], flags: [] } },
  }
  let activeId: keyof typeof engines = 'cuda'
  const started: string[] = []
  const manager = {
    // Manager.start's shape: beforeStart runs inside the load gate, then the spawn.
    start: async (opts: { engine: { id: string } }, hooks?: { beforeStart?: () => Promise<void> }) => {
      await hooks?.beforeStart?.()
      started.push(opts.engine.id)
    },
    stopAndWait: async () => {},
    status: () => ({ state: 'stopped', err: null }), // every probe reads as a crash at once: only its start matters here
    logPath: () => null,
    target: () => null,
  }
  const registry = { active: () => engines[activeId] }
  const m = model({ blockCount: 2 })
  const store = { snapshot: () => ({ modelProfiles: {}, vramHeadroomMb: 1024, modelDirs: [] }) }
  const scanner = { get: (key: string) => (key === m.key ? m : undefined) }
  const bench = new BenchRunner(manager as never, store as never, scanner as never, registry as never, 'test', {} as never)
  const r = bench as unknown as RunnerInternals
  r.settleGpu = async () => {}
  r.denseSearch = async (e, s, p, caps, results) => {
    await r.probeVram(e, s, { ...p, ngl: 1 }, caps)
    activeId = 'vllm' // the user picks vLLM in Engines, or an install activates it
    await r.probeVram(e, s, { ...p, ngl: 2 }, caps)
    return r.benchAt(e, s, { ...p, ngl: 2 }, caps, results, 'ngl=2')
  }

  bench.start(m.key)
  while (bench.isRunning()) await new Promise((res) => setTimeout(res, 20))

  assert.deepEqual(started, ['cuda'], 'nothing starts on the engine selected mid-run')
  const st = bench.status()
  assert.equal(st.done, true)
  assert.match(st.error ?? '', /another engine was selected/)
})

// A Disable or Delete of the run's engine between two probes (the primary is stopped there, so it is allowed) leaves no
// engine selected (Registry.remove). The run stops the same way, and says its engine was removed, not that another
// engine was selected.
test('auto-tune stops when its engine is removed during the run, and says so', async () => {
  const cuda = { id: 'cuda', name: 'llama.cpp CUDA', kind: 'llama-server', binPath: '/e/llama-server', version: 'b1', capabilities: CAPS }
  let selected: typeof cuda | undefined = cuda
  const started: string[] = []
  const manager = {
    start: async (opts: { engine: { id: string } }, hooks?: { beforeStart?: () => Promise<void> }) => {
      await hooks?.beforeStart?.()
      started.push(opts.engine.id)
    },
    stopAndWait: async () => {},
    status: () => ({ state: 'stopped', err: null }),
    logPath: () => null,
    target: () => null,
  }
  const registry = { active: () => selected }
  const m = model({ blockCount: 2 })
  const store = { snapshot: () => ({ modelProfiles: {}, vramHeadroomMb: 1024, modelDirs: [] }) }
  const scanner = { get: (key: string) => (key === m.key ? m : undefined) }
  const bench = new BenchRunner(manager as never, store as never, scanner as never, registry as never, 'test', {} as never)
  const r = bench as unknown as RunnerInternals
  r.settleGpu = async () => {}
  r.denseSearch = async (e, s, p, caps, results) => {
    await r.probeVram(e, s, { ...p, ngl: 1 }, caps)
    selected = undefined // the user Disables llama.cpp CUDA in Engines
    await r.probeVram(e, s, { ...p, ngl: 2 }, caps)
    return r.benchAt(e, s, { ...p, ngl: 2 }, caps, results, 'ngl=2')
  }

  bench.start(m.key)
  while (bench.isRunning()) await new Promise((res) => setTimeout(res, 20))

  assert.deepEqual(started, ['cuda'], 'nothing starts once the engine is removed')
  assert.match(bench.status().error ?? '', /its engine was removed during the run/)
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

test('auto-tune telemetry sends a path-shaped model name and engine version as unknown', () => {
  const dir = tmpDir('turbollm-bench-telemetry-')
  try {
    const cfg = { telemetry: { level: 'anon', machineId: '00000000-0000-0000-0000-000000000000' } }
    const { r } = runner({ snapshot: () => cfg, update: () => {}, dir: () => dir })
    const sys: SysInfo = { os: 'win32/x64', cpu: 'Test CPU', cores: 12, ramMB: 32000, gpus: [{ name: 'Test GPU', vramMb: 16000, vendor: 'nvidia' }] }
    const record = { modelKey: 'm|q4|1', tps: 40, ttftMs: 200, vramMb: 9000, ts: '2026-10-13T00:00:00.000Z', params: { ctx: 8192, ngl: 33, nCpuMoe: 0, parallel: 1, kvTypeK: 'f16', flashAttn: 'auto' } }

    r.queueTelemetry(record, model({ name: 'C:\\Users\\alice\\acme-secret-project\\merged-7b' }), sys, '1.0.0', 'C:\\Users\\alice\\llama\\llama-server.exe: unknown option')

    const queued = readQueue(dir)
    assert.equal(queued.length, 1)
    const payload = queued[0].event.payload as { model: { name: string }; engine: { version: string } }
    assert.equal(payload.model.name, 'unknown')
    assert.equal(payload.engine.version, 'unknown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
