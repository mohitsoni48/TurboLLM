// Regression pins for the in-app SDK's two engine rows (ADR-462, plan D-13; architecture §1.3 I-1 and §7). Both rows
// share one SDK host that holds one model at a time, so nothing may load on a row that is not the active one, and the
// router never keeps a second slot on the SDK. Every behaviour keyed on the kind (tools, vision, embeddings, one model,
// the bearer) holds on both rows. No production code is under change here: a failing pin is a regression to report.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigStore, Engine } from '../config/config'
import type { Manager, StartOpts, Status } from './manager'
import type { ModelEntry, Scanner } from '../models/scanner'
import { engineForModel, type Registry } from './registry'
import { ModelRouter } from '../gateway/model-router'
import { withPinnedModel } from '../routines/model-swap'
import {
  engineHoldsOneModel, engineWithholdsEmbeddings, engineWithholdsTools, engineWithholdsVision,
} from './compat'
import { engineRequestHeaders } from './engine-headers'

const SDK_URL = 'http://sdk.invalid:1'

function sdkRow(id: string, name: string, sdkEngineId: string, formats: ('gguf' | 'litertlm')[]): Engine {
  return {
    id, name, binPath: '', kind: 'turbollm-sdk', version: 'in-app', baseUrl: SDK_URL, addedAt: '',
    capabilities: { kvTypes: [], flags: [] }, sdkEngine: { id: sdkEngineId, kind: sdkEngineId, formats, backends: ['cpu'] },
  }
}

const LLAMA_ROW = sdkRow('sdk-llama', 'llama.cpp (CPU)', 'llama.cpp-cpu', ['gguf'])
const LITERT_ROW = sdkRow('sdk-litert', 'LiteRT-LM', 'litert-lm', ['litertlm'])

function model(key: string, format: ModelEntry['format']): ModelEntry {
  return {
    key, name: key, quant: 'Q4', format, path: `/models/${key}`, arch: 'llama',
    nativeCtx: 4096, vision: false, embedding: false, incomplete: false, parseError: null,
  } as unknown as ModelEntry
}

const RUNNING_GGUF = model('model-p', 'gguf')
const SECOND_GGUF = model('model-b', 'gguf')
const LITERT_MODEL = model('gemma-litert', 'litertlm')

/** The primary Manager: running `key`, recording each model it is asked to load. */
function runningPrimary(key: string) {
  let modelKey = key
  const loads: string[] = []
  const manager = {
    status: (): Status => ({
      state: 'running', err: null, port: 0, pid: 0, loadElapsedMs: 0,
      model: { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false },
    }),
    sessionStats: () => ({ activeRequests: 0 }),
    currentOpts: () => null,
    restartOpts: () => null,
    target: () => 'http://engine.invalid:1',
    touch: () => {},
    load: async (o: StartOpts) => {
      loads.push(o.model.key)
      modelKey = o.model.key
    },
  } as unknown as Manager
  return { manager, loads }
}

/** keep-N 3 with `active` the selected row (both SDK rows registered), model-p in the primary. */
function sdkRouter(active: Engine) {
  const primary = runningPrimary(RUNNING_GGUF.key)
  const newSlots: string[] = []
  const store = {
    snapshot: () => ({ gateway: { autoSwap: true, keepN: 3 }, modelProfiles: {}, comfyui: {}, showAllEngineModels: false }),
    update: (fn: (c: { lastLoaded?: unknown }) => void) => fn({}),
  } as unknown as ConfigStore
  const scanner = {
    list: () => ({ models: [RUNNING_GGUF, SECOND_GGUF, LITERT_MODEL] }),
    get: () => undefined,
  } as unknown as Scanner
  const registry = { active: () => active, layaEngine: () => undefined } as unknown as Registry
  const router = new ModelRouter(store, registry, primary.manager, scanner, undefined, undefined, () => {
    newSlots.push('slot')
    return primary.manager
  })
  return { router, primary, newSlots }
}

test('T-INV-1: with the llama.cpp row active, a .litertlm model resolves to the active row, never the LiteRT-LM one', () => {
  const registry = { active: () => LLAMA_ROW, layaEngine: () => undefined }
  assert.equal(engineForModel(registry, LITERT_MODEL)?.id, LLAMA_ROW.id)
})

test('T-INV-1: a gateway auto-swap to a .litertlm model under the llama.cpp row is the permanent 503, and loads nothing', async () => {
  const { router, primary, newSlots } = sdkRouter(LLAMA_ROW)

  const routed = await router.route(LITERT_MODEL.key)

  assert.ok('status' in routed, JSON.stringify(routed))
  assert.equal(routed.status, 503)
  assert.equal(routed.permanent, true)
  assert.match(routed.message, /^llama\.cpp \(CPU\) can't run this \.litertlm model\./)
  assert.deepEqual(primary.loads, [])
  assert.deepEqual(newSlots, [])
})

test('T-INV-1: a routine pinned to a .litertlm model under the llama.cpp row fails to load (model_unavailable)', async () => {
  const { router, primary } = sdkRouter(LLAMA_ROW)
  let ran = false

  const outcome = await withPinnedModel({ manager: primary.manager, modelRouter: router }, LITERT_MODEL.key, async () => {
    ran = true
  })

  assert.equal(outcome.outcome, 'skip-load-failed')
  assert.equal(ran, false)
  assert.deepEqual(primary.loads, [], 'the restore found the user\'s model still loaded')
})

test('T-INV-1: keep-N 3 on an SDK row keeps one slot: a second model replaces the first in the primary', async () => {
  const { router, primary, newSlots } = sdkRouter(LLAMA_ROW)

  const routed = await router.route(SECOND_GGUF.key)

  assert.ok('target' in routed, JSON.stringify(routed))
  assert.deepEqual(primary.loads, [SECOND_GGUF.key])
  assert.deepEqual(newSlots, [], 'no pool slot on the one-model SDK host')
  assert.deepEqual([...router.loadedModelKeys()], [SECOND_GGUF.key])
})

test('kind-keyed behaviour holds on both SDK rows: tools, vision and embeddings withheld, one model, the SDK bearer', () => {
  for (const row of [LITERT_ROW, LLAMA_ROW]) {
    assert.equal(engineWithholdsTools(row.kind), true, row.name)
    assert.equal(engineWithholdsVision(row.kind), true, row.name)
    assert.equal(engineWithholdsEmbeddings(row.kind), true, row.name)
    assert.equal(engineHoldsOneModel(row.kind), true, row.name)
    const headers = engineRequestHeaders(row.kind, new Headers({ authorization: 'Bearer client-key' }), { TURBOLLM_ANDROID_SDK_TOKEN: 'sdk-tok' })
    assert.equal(headers.get('authorization'), 'Bearer sdk-tok', row.name)
  }
})
