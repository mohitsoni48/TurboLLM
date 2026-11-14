// slotLogs() is what GET /api/v1/engine/logs?model= selects from: the log of each alive POOL slot, never the primary's,
// and nothing for a slot whose engine has stopped. Slots are seeded straight into the router with fake managers, so no
// engine is ever started.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelRouter } from './model-router'

type FakeManager = { status: () => { state: string; model: null }; logPath: () => string }
const fakeManager = (state: string, logPath: string): FakeManager => ({ status: () => ({ state, model: null }), logPath: () => logPath })

function routerWithSlots(slots: Record<string, FakeManager>): ModelRouter {
  const primary = fakeManager('running', '/logs/engine-llama.log')
  const router = new ModelRouter({} as never, {} as never, primary as never, {} as never, undefined)
  const extra = (router as unknown as { extraSlots: Map<string, unknown> }).extraSlots
  for (const [modelKey, manager] of Object.entries(slots)) extra.set(modelKey, { manager, modelKey, lastUsedMs: 0 })
  return router
}

test('slotLogs lists each alive pool slot with its own log, not the primary\'s', () => {
  const router = routerWithSlots({
    embed: fakeManager('running', '/logs/engine-llama-50123.log'),
    chat2: fakeManager('starting', '/logs/engine-llama-50124.log'),
  })
  assert.deepEqual(router.slotLogs(), [
    { modelKey: 'embed', logPath: '/logs/engine-llama-50123.log' },
    { modelKey: 'chat2', logPath: '/logs/engine-llama-50124.log' },
  ])
})

test('slotLogs leaves out a stopped slot and a slot with no log yet', () => {
  const router = routerWithSlots({
    stopped: fakeManager('stopped', '/logs/engine-llama-50125.log'),
    nolog: fakeManager('running', ''),
  })
  assert.deepEqual(router.slotLogs(), [])
})
