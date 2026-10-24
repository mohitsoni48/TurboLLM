// A finished auto-tune's result outlives an engine stop. Every engine stop, load and restart runs the kill switch
// BenchRunner.cancel(), which also dropped the result a finished run holds for its Save/Cancel dialog, though no run was
// left to stop: a tune that finished while the page was closed was gone before the user saw it, whenever the engine was
// stopped in between (the Eject, a model load or restart, a Turbo Link unload). The kill switches now stop only a run
// in flight; the user's own Cancel (POST /bench/cancel, the results dialog's Cancel) and a new run discard a finished
// result. It outlives the process too (a file beside config.json): a finished tune leaves the engine stopped, and the
// Android app's service stops once nothing is loaded and nothing runs. Driven through start() and the real routes, with
// the search cut to one stubbed winner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BenchRunner, type BenchCandidate } from './bench'
import { ConfigStore, getModelProfile } from '../config/config'
import { registerApi } from '../api/routes'
import type { Deps } from '../deps'
import type { LoadProfile } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import { tmpDir } from '../test-support/tmp'

const CAPS = { kvTypes: ['f16', 'q8_0'], flags: [] as string[] }
const CUDA = { id: 'cuda', name: 'llama.cpp CUDA', kind: 'llama-server', binPath: '/e/llama-server', version: 'b1', capabilities: CAPS }

const M: ModelEntry = {
  key: 'm|q4|1', name: 'm', path: '/models/m.gguf', dir: '/models', format: 'gguf',
  sizeBytes: 4_000_000_000, sizeLabel: '4 GB', arch: 'llama', quant: 'Q4_K_M',
  nativeCtx: 8192, blockCount: 2, headCountKv: 8, headDim: 0, moe: false, expertCount: 0,
  nextnLayers: 0, vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true, reasoningEffort: false, embedding: false,
  incomplete: false, parseError: null, loaded: false, hasProfile: false,
  benchTps: null, mtime: '',
}

/** The private surface these tests stub: the search (one winner) and the card lookup (none). */
interface RunnerInternals {
  denseSearch: (e: ModelEntry, s: unknown, p: LoadProfile, ...rest: unknown[]) => Promise<{ cand: BenchCandidate; profile: LoadProfile } | null>
  extractCardSampling: (...a: unknown[]) => Promise<undefined>
}

function winner(p: LoadProfile): { cand: BenchCandidate; profile: LoadProfile } {
  const cand: BenchCandidate = {
    label: 'ngl=3',
    params: { ctx: p.ctx, ngl: 3, nCpuMoe: 0, parallel: 1, kvTypeK: 'f16', flashAttn: 'auto' },
    outcome: 'ok', tps: 42, prefillTps: 900, ttftMs: 120, vramMb: 3000, vramAbsMb: 5000, spillMb: null,
  }
  return { cand, profile: { ...p, ngl: 3 } }
}

/** The model scanner's surface the runner reads. `scanned`: whether a scan has finished (a daemon starting has none). */
function scannerOf(models: ModelEntry[], scanned = true) {
  return {
    get: (key: string) => models.find((m) => m.key === key),
    list: () => ({ models, scanning: false, lastScanAt: scanned ? '2026-10-22T08:00:00.000Z' : '' }),
  }
}

function harness(store = ConfigStore.load(join(tmpDir('tllm-bench-keep-'), 'config.json')), scanner = scannerOf([M])) {
  const stops: string[] = []
  const manager = {
    start: async (_opts: unknown, hooks?: { beforeStart?: () => Promise<void> }) => { await hooks?.beforeStart?.() },
    stopAndWait: async () => {},
    stop: () => { stops.push('stop') },
    status: () => ({ state: 'stopped', err: null, model: null }),
    logPath: () => null,
    target: () => null,
  }
  const registry = { active: () => CUDA }
  const bench = new BenchRunner(manager as never, store, scanner as never, registry as never, 'test', {} as never)
  const r = bench as unknown as RunnerInternals
  r.extractCardSampling = async () => undefined
  const d = { version: 'test', store, registry, manager, scanner, bench, modelRouter: { stopExplicit: () => false } } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  const post = (path: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const settled = async () => { while (bench.isRunning()) await new Promise((res) => setTimeout(res, 20)) }
  return { store, bench, r, post, settled, stops }
}

test('an engine stop after a finished auto-tune keeps its result, and Save still writes it', async () => {
  const h = harness()
  h.r.denseSearch = async (_e, _s, p) => winner(p)
  h.bench.start(M.key)
  await h.settled()
  assert.equal(h.bench.status().result?.tps, 42, 'the finished run holds its winner')

  // The Eject, a model load or restart, a Turbo Link unload.
  assert.equal((await h.post('/api/v1/engine/stop')).status, 202)
  assert.deepEqual(h.stops, ['stop'])

  const st = h.bench.status()
  assert.equal(st.done, true)
  assert.equal(st.result?.tps, 42, 'the results dialog still has the result to show')
  assert.equal(st.result?.params.ngl, 3)
  // Save writes config only: it needs no engine.
  assert.equal((await h.post('/api/v1/bench/save')).status, 200)
  const cfg = h.store.snapshot()
  assert.equal(cfg.benchResults[M.key]?.tps, 42)
  const saved = getModelProfile(cfg, M.key, 'cuda') as LoadProfile | undefined
  assert.equal(saved?.ngl, 3)
  assert.equal(saved?.tunedBy, 'bench')
  assert.equal(h.bench.status().result, undefined, 'saved: the dialog is not shown again')
})

test('the results dialog\'s Cancel discards a kept result, and nothing is saved', async () => {
  const h = harness()
  h.r.denseSearch = async (_e, _s, p) => winner(p)
  h.bench.start(M.key)
  await h.settled()
  await h.post('/api/v1/engine/stop')
  assert.equal(h.bench.status().result?.tps, 42)

  assert.equal((await h.post('/api/v1/bench/cancel')).status, 200)

  assert.equal(h.bench.status().result, undefined)
  const save = await h.post('/api/v1/bench/save')
  assert.equal(save.status, 409)
  assert.equal(((await save.json()) as { error: { code: string } }).error.code, 'no_bench_result')
  assert.equal(h.store.snapshot().benchResults[M.key], undefined)
  assert.equal(getModelProfile(h.store.snapshot(), M.key, 'cuda'), undefined)
})

test('an engine stop during a run still cancels it: the winner it then finds is not held', async () => {
  const h = harness()
  let reached!: () => void
  const searching = new Promise<void>((res) => { reached = res })
  let release!: () => void
  const held = new Promise<void>((res) => { release = res })
  h.r.denseSearch = async (_e, _s, p) => {
    reached()
    await held
    return winner(p)
  }
  h.bench.start(M.key)
  await searching

  await h.post('/api/v1/engine/stop')
  release()
  await h.settled()

  const st = h.bench.status()
  assert.equal(st.done, true)
  assert.equal(st.result, undefined)
  assert.equal((await h.post('/api/v1/bench/save')).status, 409)
})

test('a new run discards the result an earlier one left unsaved', async () => {
  const h = harness()
  h.r.denseSearch = async (_e, _s, p) => winner(p)
  h.bench.start(M.key)
  await h.settled()
  await h.post('/api/v1/engine/stop')

  h.r.denseSearch = async () => null // the second run finds nothing
  h.bench.start(M.key)
  await h.settled()

  assert.equal(h.bench.status().result, undefined)
  assert.equal((await h.post('/api/v1/bench/save')).status, 409)
})

const heldFile = (store: ConfigStore) => join(store.dir(), 'bench-result.json')

test('a held result outlives the process: a runner started on the same config dir holds it, and Save writes it', async () => {
  const first = harness()
  first.r.denseSearch = async (_e, _s, p) => winner(p)
  first.bench.start(M.key)
  await first.settled()
  assert.ok(existsSync(heldFile(first.store)), 'written as the run finished')

  // The next process (Android's service stopped, Quit, a restart) reads it back.
  const next = harness(first.store)
  const st = next.bench.status()
  assert.equal(st.done, true)
  assert.equal(st.modelKey, M.key)
  assert.equal(st.result?.tps, 42, 'the results dialog has it to show')
  assert.equal(st.result?.params.ngl, 3)
  assert.equal((await next.post('/api/v1/bench/save')).status, 200)
  const cfg = next.store.snapshot()
  assert.equal(cfg.benchResults[M.key]?.tps, 42)
  assert.equal((getModelProfile(cfg, M.key, 'cuda') as LoadProfile | undefined)?.ngl, 3)
  assert.equal(next.bench.status().result, undefined)
  assert.equal(existsSync(heldFile(next.store)), false, 'saved: the file is gone')
  assert.equal(harness(next.store).bench.status().result, undefined, 'and the next process holds nothing')
})

test('the results dialog\'s Cancel and a new run delete the held result\'s file', async () => {
  const h = harness()
  h.r.denseSearch = async (_e, _s, p) => winner(p)
  h.bench.start(M.key)
  await h.settled()
  assert.equal((await h.post('/api/v1/bench/cancel')).status, 200)
  assert.equal(existsSync(heldFile(h.store)), false, 'Cancel deletes it')
  assert.equal(harness(h.store).bench.status().result, undefined)

  h.bench.start(M.key)
  await h.settled()
  assert.ok(existsSync(heldFile(h.store)))
  h.r.denseSearch = async () => null
  h.bench.start(M.key)
  await h.settled()
  assert.equal(existsSync(heldFile(h.store)), false, 'a new run deletes it')
})

test('a held result waits for the first model scan, and is dropped once a scan has finished without its model', async () => {
  const first = harness()
  first.r.denseSearch = async (_e, _s, p) => winner(p)
  first.bench.start(M.key)
  await first.settled()

  // The daemon constructs the runner before its first scan has listed any model.
  const scanning = harness(first.store, scannerOf([], false))
  assert.equal(scanning.bench.status().result, undefined, 'not offered before the scan')
  assert.ok(existsSync(heldFile(first.store)), 'nor dropped')
  const listed = harness(first.store, scannerOf([M]))
  assert.equal(listed.bench.status().result?.tps, 42)

  const gone = harness(first.store, scannerOf([]))
  assert.equal(gone.bench.status().result, undefined)
  assert.equal(existsSync(heldFile(first.store)), false, 'its model was deleted: dropped')
  assert.equal((await gone.post('/api/v1/bench/save')).status, 409)
})
