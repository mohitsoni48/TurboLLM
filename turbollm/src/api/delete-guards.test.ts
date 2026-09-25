// A model or engine that is running must not be deleted out from under its process. A Laya model is never in the
// primary (ADR-443), so a guard that asks only the primary manager never sees it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { engineDeleteBlocked, modelDeleteBlocked } from './delete-guards'
import type { Deps } from '../deps'
import type { Engine } from '../config/config'
import type { AliveSlot } from '../gateway/model-router'
import type { ModelEntry } from '../models/scanner'

const LAYA = { key: 'laya|laya|1455', name: 'laya', path: '/models/laya', laya: { checkpoints: ['english'] } } as unknown as ModelEntry
const CHAT = { key: 'qwen', name: 'qwen', path: '/models/qwen.gguf' } as unknown as ModelEntry
const LAYA_ENGINE = { id: 'laya-1', kind: 'laya' } as Engine
const LLAMA_ENGINE = { id: 'llama', kind: 'llama-server' } as Engine

function deps(opts: { primary?: { state: string; key: string }; pool?: string[] }): Deps {
  const library = new Map([LAYA, CHAT].map((m) => [m.key, m]))
  const slots: AliveSlot[] = (opts.pool ?? []).map((modelKey) => ({ modelKey, state: 'running', primary: false, lastUsedMs: 0 }))
  const loaded = new Set<string>()
  for (const key of opts.pool ?? []) {
    loaded.add(key)
    loaded.add(library.get(key)?.path ?? '')
  }
  return {
    manager: {
      status: () => ({ state: opts.primary?.state ?? 'stopped', model: opts.primary ? { key: opts.primary.key } : null }),
    },
    modelRouter: { aliveSlots: () => slots, loadedModelKeys: () => loaded },
    scanner: { get: (key: string) => library.get(key) },
    registry: { list: () => ({ engines: [LAYA_ENGINE, LLAMA_ENGINE], activeEngineId: LLAMA_ENGINE.id }) },
  } as unknown as Deps
}

test('modelDeleteBlocked: a Laya model running in its own pool slot cannot be deleted', () => {
  assert.equal(modelDeleteBlocked(deps({ pool: [LAYA.key] }), LAYA), true)
})

test('modelDeleteBlocked: the model in the primary cannot be deleted, by key or by path', () => {
  assert.equal(modelDeleteBlocked(deps({ primary: { state: 'running', key: CHAT.key } }), CHAT), true)
  assert.equal(modelDeleteBlocked(deps({ primary: { state: 'starting', key: CHAT.path } }), CHAT), true)
})

test('modelDeleteBlocked: a model nothing is running can be deleted', () => {
  assert.equal(modelDeleteBlocked(deps({ pool: [LAYA.key], primary: { state: 'stopped', key: CHAT.key } }), CHAT), false)
})

test('engineDeleteBlocked: the Laya engine cannot be removed while a Laya model runs on it, active or not', () => {
  assert.equal(engineDeleteBlocked(deps({ pool: [LAYA.key] }), LAYA_ENGINE), true)
})

test('engineDeleteBlocked: the Laya engine can be removed once no Laya model runs', () => {
  assert.equal(engineDeleteBlocked(deps({ primary: { state: 'running', key: CHAT.key } }), LAYA_ENGINE), false)
})

test('engineDeleteBlocked: the active engine cannot be removed while the primary runs, as before', () => {
  assert.equal(engineDeleteBlocked(deps({ primary: { state: 'running', key: CHAT.key } }), LLAMA_ENGINE), true)
  assert.equal(engineDeleteBlocked(deps({}), LLAMA_ENGINE), false)
})
