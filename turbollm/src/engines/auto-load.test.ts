// Startup auto-load decision and its console lines (spec 05 §7 acceptance #7, ADR-425).
// planAutoLoad decides from the POST-scan config snapshot; skipLine / fallbackLine produce
// the exact one-line reasons. Every expected line below is a literal on purpose: the text
// is a contract (architecture §4.4 plus the AC10 row), not something to rebuild from a template.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultConfig, migrateModelKey, type Config, type ConfigStore, type DevModel, type Engine,
} from '../config/config'
import type { RouteResult } from '../gateway/model-router'
import { Scanner, type ModelEntry } from '../models/scanner'
import type { SysInfo } from '../sysinfo/sysinfo'
import {
  fallbackLine,
  planAutoLoad,
  runAutoLoad,
  skipLine,
  type AutoLoadDeps,
  type AutoLoadPlanInput,
  type AutoLoadSkipReason,
} from './auto-load'
import type { StartOpts } from './manager'
import { buildStartOpts } from './start-opts'
import { tmpDir } from '../test-support/tmp'

const KEY = 'gemma 4 e4b|Q6_K|6217256480'
const LINKED_MODEL = 'workstation/Qwen3-35B'
const DEV_MODEL: DevModel = { modelPath: 'D:\\models\\legacy.gguf', extraArgs: ['-c', '4096'], label: 'Legacy' }

function resumableConfig(overrides: Partial<Config> = {}): Config {
  return { ...defaultConfig(), autoLoadOnStart: true, lastLoaded: { modelKey: KEY, engineId: 'eng-1' }, ...overrides }
}

function linkedConfig(turboLink: boolean, selectedRemoteModel: string, overrides: Partial<Config> = {}): Config {
  const cfg = resumableConfig(overrides)
  const experimental = { ...cfg.daemon.experimental, turboLink }
  return { ...cfg, daemon: { ...cfg.daemon, experimental }, selectedRemoteModel }
}

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    key: KEY, name: 'Gemma 4 E4B', path: 'D:\\models\\gemma.gguf', dir: 'D:\\models',
    format: 'gguf', sizeBytes: 1, sizeLabel: '1 GB', arch: 'gemma4', quant: 'Q6_K', nativeCtx: 4096,
    blockCount: 1, headCountKv: 1, headDim: 1, moe: false, expertCount: 0, nextnLayers: 0,
    vision: false, audio: false, mmprojPath: null, mmprojSizeBytes: 0, hasChatTemplate: true,
    reasoningEffort: false, embedding: false, incomplete: false, parseError: null,
    ...overrides,
  } as unknown as ModelEntry
}

function engineOfKind(kind: string, name = 'llama.cpp'): Engine {
  return {
    id: 'eng-1', name, kind, binPath: 'D:\\engines\\llama-server.exe', version: 'b1',
    capabilities: { kvTypes: [], flags: [] }, addedAt: '2026-09-13T00:00:00.000Z',
  } as unknown as Engine
}

function recordingLibrary(...entries: ModelEntry[]) {
  const lookedUp: string[] = []
  const findModel = (key: string) => {
    lookedUp.push(key)
    return entries.find((e) => e.key === key)
  }
  return { findModel, lookedUp }
}

function planFor(overrides: Partial<AutoLoadPlanInput> = {}) {
  const library = recordingLibrary(entry())
  const input: AutoLoadPlanInput = {
    cfg: resumableConfig(), engine: engineOfKind('llama-server'), comfyBlocked: false,
    findModel: library.findModel, ...overrides,
  }
  return { plan: planAutoLoad(input), lookedUp: library.lookedUp }
}

const LLAMA_SERVER = engineOfKind('llama-server')
const skip = (reason: AutoLoadSkipReason) => ({ kind: 'skip', reason })
const noLibrary = () => undefined

test('auto-load off plans nothing, even with ComfyUI busy and no engine, and consults no library', () => {
  const { plan, lookedUp } = planFor({
    cfg: resumableConfig({ autoLoadOnStart: false }), comfyBlocked: true, engine: undefined,
  })

  assert.deepEqual(plan, { kind: 'disabled' })
  assert.deepEqual(lookedUp, [])
})

test('ComfyUI holding the GPU skips a loadable model without consulting the library', () => {
  const { plan, lookedUp } = planFor({ comfyBlocked: true })

  assert.deepEqual(plan, skip({ code: 'comfyui-busy' }))
  assert.deepEqual(lookedUp, [])
})

test('ComfyUI holding the GPU is reported before a missing engine', () => {
  const { plan } = planFor({ comfyBlocked: true, engine: undefined })

  assert.deepEqual(plan, skip({ code: 'comfyui-busy' }))
})

test('no active engine skips without consulting the library', () => {
  const { plan, lookedUp } = planFor({ engine: undefined })

  assert.deepEqual(plan, skip({ code: 'no-active-engine' }))
  assert.deepEqual(lookedUp, [])
})

test('a last model missing from the library skips with its key', () => {
  const { plan } = planFor({ findModel: noLibrary })

  assert.deepEqual(plan, skip({ code: 'model-not-in-library', modelKey: KEY }))
})

test('an incomplete last model skips as not loadable', () => {
  const { plan } = planFor({ findModel: recordingLibrary(entry({ incomplete: true })).findModel })

  assert.deepEqual(plan, skip({ code: 'model-not-loadable', modelKey: KEY }))
})

test('an unreadable last model skips as not loadable', () => {
  const { plan } = planFor({ findModel: recordingLibrary(entry({ parseError: 'bad header' })).findModel })

  assert.deepEqual(plan, skip({ code: 'model-not-loadable', modelKey: KEY }))
})

test('a GGUF last model on vLLM skips as engine-incompatible on its format', () => {
  const { plan } = planFor({ engine: engineOfKind('vllm', 'vLLM') })

  assert.deepEqual(plan, skip({
    code: 'engine-incompatible', modelKey: KEY, engineName: 'vLLM', engineKind: 'vllm', detail: 'format gguf',
  }))
})

test('an MLX last model with an audio tower on Rapid-MLX skips as engine-incompatible', () => {
  const audioModel = entry({ format: 'mlx', audio: true })
  const { plan } = planFor({
    engine: engineOfKind('rapid-mlx', 'Rapid-MLX'), findModel: recordingLibrary(audioModel).findModel,
  })

  assert.deepEqual(plan, skip({
    code: 'engine-incompatible', modelKey: KEY, engineName: 'Rapid-MLX', engineKind: 'rapid-mlx',
    detail: 'audio tower not supported',
  }))
})

test('a Jev last model on a non-vLLM engine skips because it needs vLLM', () => {
  const jevModel = entry({
    format: 'mlx',
    jev: {
      labels: ['contradiction', 'entailment', 'neutral'],
      nliTemplate: 'Premise: {premise}\nHypothesis: {hypothesis}',
      architecture: 'Qwen3_5ForSequenceClassification',
      verified: true,
    },
  })
  const { plan } = planFor({ engine: engineOfKind('mlx', 'MLX'), findModel: recordingLibrary(jevModel).findModel })

  assert.deepEqual(plan, skip({
    code: 'engine-incompatible', modelKey: KEY, engineName: 'MLX', engineKind: 'mlx',
    detail: 'Needs vLLM (Linux or WSL2)',
  }))
})

test('a loadable GGUF last model on llama-server plans a load onto the active engine', () => {
  const lastModel = entry()
  const { plan } = planFor({ engine: LLAMA_SERVER, findModel: recordingLibrary(lastModel).findModel })

  assert.deepEqual(plan, { kind: 'load-model', entry: lastModel, engine: LLAMA_SERVER })
})

test('a loadable embedding last model still plans an ordinary model load', () => {
  const embeddingModel = entry({ embedding: true })
  const { plan } = planFor({ engine: LLAMA_SERVER, findModel: recordingLibrary(embeddingModel).findModel })

  assert.deepEqual(plan, { kind: 'load-model', entry: embeddingModel, engine: LLAMA_SERVER })
})

test('a last model missing from the library falls back to devModel, remembering why', () => {
  const { plan } = planFor({ cfg: resumableConfig({ devModel: DEV_MODEL }), findModel: noLibrary })

  assert.deepEqual(plan, {
    kind: 'load-dev-model', devModel: DEV_MODEL, engine: LLAMA_SERVER,
    fallbackFrom: { code: 'model-not-in-library', modelKey: KEY },
  })
})

test('a last model that is not loadable falls back to devModel, remembering why', () => {
  const { plan } = planFor({
    cfg: resumableConfig({ devModel: DEV_MODEL }), findModel: recordingLibrary(entry({ incomplete: true })).findModel,
  })

  assert.deepEqual(plan, {
    kind: 'load-dev-model', devModel: DEV_MODEL, engine: LLAMA_SERVER,
    fallbackFrom: { code: 'model-not-loadable', modelKey: KEY },
  })
})

test('a last model the engine cannot load falls back to devModel, remembering why', () => {
  const vllm = engineOfKind('vllm', 'vLLM')
  const { plan } = planFor({ cfg: resumableConfig({ devModel: DEV_MODEL }), engine: vllm })

  assert.deepEqual(plan, {
    kind: 'load-dev-model', devModel: DEV_MODEL, engine: vllm,
    fallbackFrom: {
      code: 'engine-incompatible', modelKey: KEY, engineName: 'vLLM', engineKind: 'vllm', detail: 'format gguf',
    },
  })
})

test('with no last model recorded, devModel loads with nothing to fall back from', () => {
  const cfg = resumableConfig({ devModel: DEV_MODEL, lastLoaded: { modelKey: '', engineId: '' } })
  const { plan } = planFor({ cfg })

  assert.deepEqual(plan, { kind: 'load-dev-model', devModel: DEV_MODEL, engine: LLAMA_SERVER })
})

test('with no last model recorded and no devModel, there is nothing to load', () => {
  const { plan } = planFor({ cfg: resumableConfig({ lastLoaded: { modelKey: '', engineId: '' } }) })

  assert.deepEqual(plan, skip({ code: 'nothing-to-load' }))
})

test('AC10: Turbo Link on with a linked model selected skips a loadable local model', () => {
  const { plan } = planFor({ cfg: linkedConfig(true, LINKED_MODEL) })

  assert.deepEqual(plan, skip({ code: 'remote-model-selected', selectedModel: LINKED_MODEL }))
})

test('AC10: a linked model selection also suppresses the devModel fallback', () => {
  const { plan } = planFor({ cfg: linkedConfig(true, LINKED_MODEL, { devModel: DEV_MODEL }) })

  assert.deepEqual(plan, skip({ code: 'remote-model-selected', selectedModel: LINKED_MODEL }))
})

test('AC10: a stored selection is ignored while Turbo Link is off', () => {
  const lastModel = entry()
  const { plan } = planFor({ cfg: linkedConfig(false, LINKED_MODEL), findModel: recordingLibrary(lastModel).findModel })

  assert.deepEqual(plan, { kind: 'load-model', entry: lastModel, engine: LLAMA_SERVER })
})

test('AC10: Turbo Link on with no selection resumes the local model', () => {
  const lastModel = entry()
  const { plan } = planFor({ cfg: linkedConfig(true, ''), findModel: recordingLibrary(lastModel).findModel })

  assert.deepEqual(plan, { kind: 'load-model', entry: lastModel, engine: LLAMA_SERVER })
})

test('AC10: ComfyUI holding the GPU is reported before a linked model selection', () => {
  const { plan } = planFor({ cfg: linkedConfig(true, LINKED_MODEL), comfyBlocked: true })

  assert.deepEqual(plan, skip({ code: 'comfyui-busy' }))
})

test('AC10: a missing engine is reported before a linked model selection', () => {
  const { plan } = planFor({ cfg: linkedConfig(true, LINKED_MODEL), engine: undefined })

  assert.deepEqual(plan, skip({ code: 'no-active-engine' }))
})

const INCOMPATIBLE_ON_FORMAT_MLX: AutoLoadSkipReason = {
  code: 'engine-incompatible', modelKey: KEY, engineName: 'llama.cpp', engineKind: 'llama-server', detail: 'format mlx',
}
const INCOMPATIBLE_ON_FORMAT_GGUF: AutoLoadSkipReason = {
  code: 'engine-incompatible', modelKey: KEY, engineName: 'llama.cpp', engineKind: 'vllm', detail: 'format gguf',
}
const INCOMPATIBLE_ON_AUDIO: AutoLoadSkipReason = {
  code: 'engine-incompatible', modelKey: KEY, engineName: 'llama.cpp', engineKind: 'rapid-mlx',
  detail: 'audio tower not supported',
}

test('skip line: ComfyUI busy', () => {
  assert.equal(
    skipLine({ code: 'comfyui-busy' }),
    'auto-load skipped: ComfyUI is rendering and holds the GPU; load a model manually once its queue finishes',
  )
})

test('skip line: no active engine', () => {
  assert.equal(skipLine({ code: 'no-active-engine' }), 'auto-load skipped: no active engine; set one up in Engines')
})

test('skip line: nothing to load', () => {
  assert.equal(skipLine({ code: 'nothing-to-load' }), 'auto-load skipped: no last-loaded model recorded yet')
})

test('skip line AC10: linked model selected', () => {
  assert.equal(
    skipLine({ code: 'remote-model-selected', selectedModel: 'workstation/Qwen3-35B' }),
    'auto-load skipped: this install is pointed at linked model "workstation/Qwen3-35B"; '
      + 'pick a model on this machine in the model picker to clear that selection',
  )
})

test('skip line: last model not in the library', () => {
  assert.equal(
    skipLine({ code: 'model-not-in-library', modelKey: KEY }),
    'auto-load skipped: last model "gemma 4 e4b|Q6_K|6217256480" is not in the model library',
  )
})

test('skip line: last model incomplete or unreadable', () => {
  assert.equal(
    skipLine({ code: 'model-not-loadable', modelKey: KEY }),
    'auto-load skipped: last model "gemma 4 e4b|Q6_K|6217256480" is incomplete or unreadable',
  )
})

test('skip line: engine cannot load the format gguf', () => {
  assert.equal(
    skipLine(INCOMPATIBLE_ON_FORMAT_GGUF),
    'auto-load skipped: engine "llama.cpp" (vllm) can\'t load last model "gemma 4 e4b|Q6_K|6217256480" (format gguf)',
  )
})

test('skip line: engine cannot load the format mlx', () => {
  assert.equal(
    skipLine(INCOMPATIBLE_ON_FORMAT_MLX),
    'auto-load skipped: engine "llama.cpp" (llama-server) can\'t load last model "gemma 4 e4b|Q6_K|6217256480" '
      + '(format mlx)',
  )
})

test('skip line: engine cannot load an audio tower', () => {
  assert.equal(
    skipLine(INCOMPATIBLE_ON_AUDIO),
    'auto-load skipped: engine "llama.cpp" (rapid-mlx) can\'t load last model "gemma 4 e4b|Q6_K|6217256480" '
      + '(audio tower not supported)',
  )
})

test('skip line: a Jev last model needs vLLM', () => {
  assert.equal(
    skipLine({
      code: 'engine-incompatible', modelKey: KEY, engineName: 'llama.cpp', engineKind: 'llama-server',
      detail: 'Needs vLLM (Linux or WSL2)',
    }),
    'auto-load skipped: engine "llama.cpp" (llama-server) can\'t load last model "gemma 4 e4b|Q6_K|6217256480" '
      + '(Needs vLLM (Linux or WSL2))',
  )
})

test('fallback line: last model not in the library', () => {
  assert.equal(
    fallbackLine({ code: 'model-not-in-library', modelKey: KEY }, DEV_MODEL),
    'auto-load: last model "gemma 4 e4b|Q6_K|6217256480" is not in the model library; '
      + 'loading legacy devModel "Legacy" instead',
  )
})

test('fallback line: last model incomplete or unreadable', () => {
  assert.equal(
    fallbackLine({ code: 'model-not-loadable', modelKey: KEY }, DEV_MODEL),
    'auto-load: last model "gemma 4 e4b|Q6_K|6217256480" is incomplete or unreadable; '
      + 'loading legacy devModel "Legacy" instead',
  )
})

test('fallback line: engine cannot load the last model', () => {
  assert.equal(
    fallbackLine(INCOMPATIBLE_ON_FORMAT_MLX, DEV_MODEL),
    'auto-load: last model "gemma 4 e4b|Q6_K|6217256480" can\'t be loaded by engine "llama.cpp"; '
      + 'loading legacy devModel "Legacy" instead',
  )
})

test('fallback line refuses a reason that recorded no last model', () => {
  assert.throws(() => fallbackLine({ code: 'nothing-to-load' }, DEV_MODEL), /names no last model/)
})

test('every skip and fallback line is printable ASCII only', () => {
  const lastModelReasons: AutoLoadSkipReason[] = [
    { code: 'model-not-in-library', modelKey: KEY },
    { code: 'model-not-loadable', modelKey: KEY },
    INCOMPATIBLE_ON_FORMAT_GGUF, INCOMPATIBLE_ON_FORMAT_MLX, INCOMPATIBLE_ON_AUDIO,
  ]
  const skipReasons: AutoLoadSkipReason[] = [
    { code: 'comfyui-busy' }, { code: 'no-active-engine' }, { code: 'nothing-to-load' },
    { code: 'remote-model-selected', selectedModel: LINKED_MODEL }, ...lastModelReasons,
  ]
  const lines = [
    ...skipReasons.map(skipLine),
    ...lastModelReasons.map((reason) => fallbackLine(reason, DEV_MODEL)),
  ]

  assert.equal(lines.length, 14)
  for (const line of lines) assert.match(line, /^[\x20-\x7E]+$/)
})

const NO_GPU_MACHINE: SysInfo = { os: 'win32', cpu: 'test', cores: 8, ramMB: 32768, gpus: [] }
const LEGACY_KEY = 'gemma 4 e4b|Q4_K_S|6217256480'
const COMFYUI_BUSY_LINE =
  'auto-load skipped: ComfyUI is rendering and holds the GPU; load a model manually once its queue finishes'
const LINKED_MODEL_LINE =
  'auto-load skipped: this install is pointed at linked model "workstation/Qwen3-35B"; '
  + 'pick a model on this machine in the model picker to clear that selection'

interface RunDepsOptions {
  data?: Config
  initialScan?: Promise<void>
  activeEngine?: () => Engine | undefined
  comfyBlocked?: () => boolean
  findModel?: (key: string) => ModelEntry | undefined
  load?: () => Promise<void>
  loadExplicit?: () => Promise<RouteResult>
}

interface RecordedLoad {
  opts: StartOpts
  insideLock: boolean
  beforeStart?: () => Promise<void>
}

const SKIP_CASES: Array<{ reason: string; options: RunDepsOptions; line: string }> = [
  { reason: 'ComfyUI holding the GPU', options: { comfyBlocked: () => true }, line: COMFYUI_BUSY_LINE },
  {
    reason: 'no active engine', options: { activeEngine: () => undefined },
    line: 'auto-load skipped: no active engine; set one up in Engines',
  },
  {
    reason: 'no last model and no devModel',
    options: { data: resumableConfig({ lastLoaded: { modelKey: '', engineId: '' } }) },
    line: 'auto-load skipped: no last-loaded model recorded yet',
  },
  {
    reason: 'a last model missing from the library', options: { findModel: noLibrary },
    line: 'auto-load skipped: last model "gemma 4 e4b|Q6_K|6217256480" is not in the model library',
  },
  {
    reason: 'an incomplete last model', options: { findModel: recordingLibrary(entry({ incomplete: true })).findModel },
    line: 'auto-load skipped: last model "gemma 4 e4b|Q6_K|6217256480" is incomplete or unreadable',
  },
  {
    reason: 'an engine that cannot load the format', options: { activeEngine: () => engineOfKind('vllm', 'vLLM') },
    line: 'auto-load skipped: engine "vLLM" (vllm) can\'t load last model "gemma 4 e4b|Q6_K|6217256480" '
      + '(format gguf)',
  },
  {
    reason: 'AC10 a linked model selection', options: { data: linkedConfig(true, LINKED_MODEL) },
    line: LINKED_MODEL_LINE,
  },
]

for (const { reason, options, line } of SKIP_CASES) {
  test(`runAutoLoad AC6: ${reason} prints exactly its one skip line and loads nothing`, async () => {
    const { deps, record } = mkRunDeps(options)

    const plan = await runAutoLoad(deps)

    assert.equal(plan.kind, 'skip')
    assert.deepEqual(record.logs, [line])
    assert.deepEqual(record.warns, [])
    assert.deepEqual(record.loads, [])
    assert.deepEqual(record.loadExplicitCalls, [])
  })
}

test('runAutoLoad AC6: auto-load off is silent and loads nothing', async () => {
  const { deps, record } = mkRunDeps({ data: resumableConfig({ autoLoadOnStart: false }) })

  const plan = await runAutoLoad(deps)

  assert.deepEqual(plan, { kind: 'disabled' })
  assert.deepEqual(record.logs, [])
  assert.deepEqual(record.warns, [])
  assert.deepEqual(record.loads, [])
  assert.deepEqual(record.loadExplicitCalls, [])
})

test('runAutoLoad: a throw during PLANNING (before any load step) still warns once and never rejects', async () => {
  // architecture.md §3.4 declares runAutoLoad "Never rejects" for the whole function, not just the
  // carry-out phase. registry.active() throwing is the concrete trigger: a future collaborator
  // failure here must not silently reject the void-called promise in cli.ts and skip printing why.
  const { deps, record } = mkRunDeps({
    activeEngine: () => { throw new Error('registry blew up') },
  })

  await assert.doesNotReject(runAutoLoad(deps))

  assert.equal(record.warns.length, 1)
  assert.ok(record.warns[0].startsWith('auto-load failed: '))
  assert.ok(record.warns[0].includes('registry blew up'))
  assert.deepEqual(record.logs, [])
  assert.deepEqual(record.loads, [])
  assert.deepEqual(record.loadExplicitCalls, [])
  assert.equal(record.markPrimaryLoadedCalls, 0)
})

test('runAutoLoad AC1: waits for the boot scan, then resumes the last model inside the swap lock', async () => {
  const scan = deferred()
  let scanFinished = false
  const library = recordingLibrary(entry())
  const { deps, record } = mkRunDeps({
    initialScan: scan.promise, findModel: (key) => (scanFinished ? library.findModel(key) : undefined),
  })

  const running = runAutoLoad(deps)
  await flush()
  assert.equal(record.loads.length, 0)
  assert.equal(record.snapshotCalls, 0)
  scanFinished = true
  scan.resolve()
  await running

  assert.equal(record.loads.length, 1)
  const [resumed] = record.loads
  assert.equal(resumed.insideLock, true)
  assert.equal(resumed.opts.trigger, 'resume')
  assert.equal(resumed.opts.model.key, KEY)
  assert.equal(record.markPrimaryLoadedCalls, 1)
  assert.equal(record.snapshotCalls, 1)
  assert.equal(record.freeComfyCalls, 0)
  await resumed.beforeStart?.()
  assert.equal(record.freeComfyCalls, 1)
  assert.deepEqual(record.logs, [])
  assert.deepEqual(record.warns, [])
})

test('runAutoLoad D10: a KoboldCpp resume comes from the shared StartOpts builder, with KoboldCpp flags', async () => {
  const koboldcpp = engineOfKind('koboldcpp', 'KoboldCpp')
  const lastModel = entry()
  const { deps, record, data } = mkRunDeps({
    activeEngine: () => koboldcpp, findModel: recordingLibrary(lastModel).findModel,
  })

  await runAutoLoad(deps)

  assert.equal(record.loads.length, 1)
  const expected = buildStartOpts({
    entry: lastModel, engine: koboldcpp, cfg: structuredClone(data), sys: NO_GPU_MACHINE, trigger: 'resume',
  })
  assert.deepEqual(record.loads[0].opts, expected)
  assert.ok(record.loads[0].opts.extraArgs.includes('--contextsize'))
})

test('runAutoLoad D8: ComfyUI starting to render during the scan is seen after the scan', async () => {
  const scan = deferred()
  let scanFinished = false
  const { deps, record } = mkRunDeps({ initialScan: scan.promise, comfyBlocked: () => scanFinished })

  const running = runAutoLoad(deps)
  await flush()
  scanFinished = true
  scan.resolve()
  await running

  assert.deepEqual(record.logs, [COMFYUI_BUSY_LINE])
  assert.deepEqual(record.loads, [])
})

test('runAutoLoad D8: an engine that becomes active during the scan is used after the scan', async () => {
  const scan = deferred()
  let scanFinished = false
  const { deps, record } = mkRunDeps({
    initialScan: scan.promise, activeEngine: () => (scanFinished ? LLAMA_SERVER : undefined),
  })

  const running = runAutoLoad(deps)
  await flush()
  scanFinished = true
  scan.resolve()
  await running

  assert.deepEqual(record.logs, [])
  assert.equal(record.loads.length, 1)
})

// An embedding resume is labelled `trigger: 'gateway_switch'` in `model_load` telemetry, and the router
// rewrites `lastLoaded` to the same key. Both come from the router's own buildOpts/doLoad
// (gateway/model-router.ts:435, 454, 274). They are identical for a manual embedding Load
// (engine-lifecycle.ts:93-98), which architecture §3.4 tells auto-load to mirror (ADR-389). This is
// accepted and recorded as a TODO, not changed here.
test('runAutoLoad ADR-389: an embedding last model goes to its own router slot with only its key', async () => {
  const { deps, record } = mkRunDeps({ findModel: recordingLibrary(entry({ embedding: true })).findModel })

  await runAutoLoad(deps)

  assert.deepEqual(record.loadExplicitCalls, [[KEY]])
  assert.deepEqual(record.loads, [])
  assert.equal(record.markPrimaryLoadedCalls, 0)
  assert.equal(record.updateCalls, 0)
})

test('runAutoLoad ADR-389: a refused embedding load is warned with the router message', async () => {
  const { deps, record } = mkRunDeps({
    findModel: recordingLibrary(entry({ embedding: true })).findModel,
    loadExplicit: () => Promise.resolve({ status: 503, message: 'nope' }),
  })

  await runAutoLoad(deps)

  assert.deepEqual(record.warns, ['auto-load failed: nope'])
})

test('runAutoLoad: a failed load keeps its "auto-load failed" warning and never rejects', async () => {
  const { deps, record } = mkRunDeps({ load: () => Promise.reject(new Error('spawn failed')) })

  await assert.doesNotReject(runAutoLoad(deps))

  assert.equal(record.warns.length, 1)
  assert.ok(record.warns[0].startsWith('auto-load failed: '))
  assert.ok(record.warns[0].includes('spawn failed'))
  assert.deepEqual(record.logs, [])
  assert.equal(record.markPrimaryLoadedCalls, 0)
})

test('runAutoLoad AC7: a last model missing from the library falls back to devModel with one line', async () => {
  const { deps, record } = mkRunDeps({ data: resumableConfig({ devModel: DEV_MODEL }), findModel: noLibrary })

  await runAutoLoad(deps)

  assert.deepEqual(record.logs, [
    'auto-load: last model "gemma 4 e4b|Q6_K|6217256480" is not in the model library; '
      + 'loading legacy devModel "Legacy" instead',
  ])
  assert.equal(record.loads.length, 1)
  assert.deepEqual(record.loads[0].opts, {
    engine: LLAMA_SERVER,
    model: { key: 'D:\\models\\legacy.gguf', name: 'Legacy', quant: '', ctx: 0, vision: false },
    modelPath: 'D:\\models\\legacy.gguf',
    extraArgs: ['-c', '4096'],
    trigger: 'resume',
  })
  assert.equal(record.loads[0].insideLock, true)
  assert.equal(record.markPrimaryLoadedCalls, 1)
})

test('runAutoLoad AC7: with no last model recorded, devModel loads without a line', async () => {
  const data = resumableConfig({ devModel: DEV_MODEL, lastLoaded: { modelKey: '', engineId: '' } })
  const { deps, record } = mkRunDeps({ data })

  await runAutoLoad(deps)

  assert.deepEqual(record.logs, [])
  assert.equal(record.loads.length, 1)
})

test('runAutoLoad AC5: a key the scan migrates resumes under the new key with the saved profile', async () => {
  const data = resumableConfig({
    lastLoaded: { modelKey: LEGACY_KEY, engineId: 'eng-1' },
    modelProfiles: { [LEGACY_KEY]: { 'eng-1': { profile: { ctx: 12345 }, updatedAt: 't' } } },
  })
  const scan = deferred()
  const { deps, store, record } = mkRunDeps({
    data, initialScan: scan.promise, findModel: recordingLibrary(entry()).findModel,
  })

  const running = runAutoLoad(deps)
  await flush()
  store.update((c) => { migrateModelKey(c, LEGACY_KEY, KEY) })
  scan.resolve()
  await running

  assert.deepEqual(record.logs, [])
  assert.equal(record.loads.length, 1)
  assert.equal(record.loads[0].opts.model.key, KEY)
  assert.equal(record.loads[0].opts.profile?.ctx, 12345)
})

test('runAutoLoad AC5 with a real Scanner: the boot scan migrates the key before the resume reads config', async () => {
  const root = tmpDir('turbollm-autoload-test-')
  try {
    writeGguf(root, 'Qwen3.8-27B-UD-IQ2_M.gguf', [
      ['general.architecture', 'qwen3'],
      ['general.file_type', FTYPE_Q4_K_S],
    ])
    const newKey = await scannedKeyOf(root)
    const oldKey = newKey.replace('|IQ2_M|', '|Q4_K_S|')
    assert.notEqual(oldKey, newKey, 'sanity: the key carries the quant segment the migration rewrites')
    const store = cloningConfigStore(root, {
      ...defaultConfig(), modelDirs: [root], autoLoadOnStart: true,
      lastLoaded: { modelKey: oldKey, engineId: 'eng-1' },
      modelProfiles: { [oldKey]: { 'eng-1': { profile: { ctx: 12345 }, updatedAt: 't' } } },
    })
    const scanner = new Scanner(store)
    const initialScan = scanner.rescan()
    const { deps, record } = mkRunDeps()

    await runAutoLoad({ ...deps, initialScan, store, scanner })

    assert.deepEqual(record.logs, [])
    assert.equal(record.loads.length, 1)
    assert.equal(record.loads[0].opts.model.key, newKey)
    assert.equal(record.loads[0].opts.profile?.ctx, 12345)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runAutoLoad AC10: a linked model selected during the scan blocks the local resume', async () => {
  const data = linkedConfig(true, '', { devModel: DEV_MODEL })
  const scan = deferred()
  const { deps, store, record } = mkRunDeps({ data, initialScan: scan.promise })

  const running = runAutoLoad(deps)
  await flush()
  store.update((c) => { c.selectedRemoteModel = LINKED_MODEL })
  scan.resolve()
  await running

  assert.deepEqual(record.logs, [LINKED_MODEL_LINE])
  assert.deepEqual(record.loads, [])
  assert.deepEqual(record.loadExplicitCalls, [])
  assert.deepEqual(record.warns, [])
  assert.equal(record.snapshotCalls, 1)
})

/** Fakes for every runAutoLoad collaborator. `snapshot()` clones like the real ConfigStore
 *  (config.ts:738-740): a snapshot taken before the scan must NOT see the scan's migration. */
function mkRunDeps(options: RunDepsOptions = {}) {
  const data = options.data ?? resumableConfig()
  const record = {
    logs: [] as string[], warns: [] as string[], loads: [] as RecordedLoad[], loadExplicitCalls: [] as unknown[][],
    markPrimaryLoadedCalls: 0, snapshotCalls: 0, updateCalls: 0, freeComfyCalls: 0,
  }
  let inLock = false
  const store = {
    snapshot: () => { record.snapshotCalls++; return structuredClone(data) },
    update: (fn: (c: Config) => void) => { record.updateCalls++; fn(data) },
  }
  const deps: AutoLoadDeps = {
    initialScan: options.initialScan ?? Promise.resolve(),
    store,
    registry: { active: options.activeEngine ?? (() => LLAMA_SERVER) },
    comfy: {
      isBlocked: options.comfyBlocked ?? (() => false),
      freeComfyUIBeforeLoad: async () => { record.freeComfyCalls++ },
    },
    scanner: { get: options.findModel ?? recordingLibrary(entry()).findModel },
    manager: {
      load: (opts, hooks) => {
        record.loads.push({ opts, insideLock: inLock, beforeStart: hooks?.beforeStart })
        return options.load?.() ?? Promise.resolve()
      },
    },
    modelRouter: {
      withSwapLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        inLock = true
        try { return await fn() } finally { inLock = false }
      },
      markPrimaryLoaded: () => { record.markPrimaryLoadedCalls++ },
      loadExplicit: (...args: unknown[]) => {
        record.loadExplicitCalls.push([...args])
        return options.loadExplicit?.() ?? Promise.resolve({ target: 'http://127.0.0.1:2' })
      },
    },
    sysInfo: () => NO_GPU_MACHINE,
    log: (line) => { record.logs.push(line) },
    warn: (line) => { record.warns.push(line) },
  }
  return { deps, store, record, data }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

const flush = () => new Promise<void>((r) => setImmediate(r))

function cloningConfigStore(root: string, data: Config): ConfigStore {
  return {
    dir: () => root,
    snapshot: () => structuredClone(data),
    update: (fn: (c: Config) => void) => { fn(data) },
  } as unknown as ConfigStore
}

async function scannedKeyOf(root: string): Promise<string> {
  const probe = new Scanner(cloningConfigStore(root, { ...defaultConfig(), modelDirs: [root] }))
  await probe.rescan()
  return probe.list().models[0].key
}

const T_UINT32 = 4
const T_STRING = 8
const FTYPE_Q4_K_S = 14

/** Minimal valid GGUF v3 header, copied from scanner.quant-precedence.test.ts (helpers stay local per file). */
function buildGguf(kvs: Array<[string, string | number]>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const str = (s: string) => { const body = Buffer.from(s, 'utf8'); return Buffer.concat([u64(body.length), body]) }
  parts.push(u32(0x46554747), u32(3), u64(0), u64(kvs.length)) // magic, version, tensorCount, kvCount
  for (const [key, value] of kvs) {
    parts.push(str(key))
    if (typeof value === 'string') parts.push(u32(T_STRING), str(value))
    else parts.push(u32(T_UINT32), u32(value))
  }
  return Buffer.concat(parts)
}

// walk() only records .gguf files >= 1 MiB, so pad past that floor.
const MIN_SIZE = (1 << 20) + 16

function writeGguf(dir: string, filename: string, kvs: Array<[string, string | number]>): string {
  const path = join(dir, filename)
  const header = buildGguf(kvs)
  const body = header.length >= MIN_SIZE ? header : Buffer.concat([header, Buffer.alloc(MIN_SIZE - header.length)])
  writeFileSync(path, body)
  return path
}
