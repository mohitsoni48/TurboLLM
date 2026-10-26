// The shared status builder (status-view.ts), which GET /api/v1/status and the Turbo Link façade's status both serve.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildModelStatus } from './status-view'
import type { Deps } from '../deps'

function depsServing(active: { id: string; name: string; kind: string }, serving: { id: string; name: string; kind: string } | null) {
  return {
    registry: { active: () => active },
    manager: {
      status: () => ({ state: serving ? 'running' : 'stopped', err: null, port: 8081, pid: 7, model: null, loadElapsedMs: 0 }),
      currentOpts: () => (serving ? { engine: serving } : null),
      parallelSlots: () => null,
      sessionStats: () => null,
      liveGeneration: () => null,
    },
  } as unknown as Deps
}

const LLAMA = { id: 'llama-1', name: 'llama.cpp (b1234)', kind: 'llama-server' }
const LITERT = { id: 'litert-1', name: 'LiteRT-LM', kind: 'litert-lm' }

// `id`, `name` and `kind` are the active engine's. A model another engine runs (an install or Enable activates an engine
// without stopping the model) was named only by id and kind, so a screen could show the engine running it only as the
// selected one.
test('buildModelStatus names the engine running the model beside the active one', () => {
  const { engine } = buildModelStatus(depsServing(LLAMA, LITERT))

  assert.deepEqual(
    { id: engine.id, name: engine.name, kind: engine.kind, servingId: engine.servingId, servingKind: engine.servingKind, servingName: engine.servingName },
    { id: 'llama-1', name: 'llama.cpp (b1234)', kind: 'llama-server', servingId: 'litert-1', servingKind: 'litert-lm', servingName: 'LiteRT-LM' },
  )
})

test('buildModelStatus serves no engine name while nothing is loaded', () => {
  const { engine } = buildModelStatus(depsServing(LLAMA, null))

  assert.deepEqual([engine.servingId, engine.servingKind, engine.servingName], ['', '', ''])
})
