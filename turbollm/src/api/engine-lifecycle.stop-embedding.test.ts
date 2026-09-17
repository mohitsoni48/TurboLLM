// Regression coverage for the eject-targets-the-wrong-engine bug: `stopEngine`
// (`POST /api/v1/engine/stop`, the Models page/topbar "Eject" button) took no model
// identity at all and unconditionally called `d.manager.stop()` — the PRIMARY manager.
// Ejecting an embedding model loaded into its own pool slot (ADR-389) actually stopped
// the chat model instead; retrying then did nothing, since the primary was already
// stopped and the embedding model was never in it. `stopEngine` must route through
// `ModelRouter.stopExplicit` when the given key names an extra slot, and fall back to
// the primary manager (the existing behavior) otherwise — same coexistence rule
// `startEngine`'s `entry.embedding` branch already applies on load.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { stopEngine, type EngineStopBody } from './engine-lifecycle'
import type { Deps } from '../deps'

function mkDeps(stopExplicitTargets: Set<string>) {
  const primaryStopCalls: number[] = []
  const stopExplicitCalls: string[] = []
  const benchCancelCalls: number[] = []

  const manager = {
    stop: () => { primaryStopCalls.push(1) },
  }
  const modelRouter = {
    stopExplicit: (key: string) => {
      stopExplicitCalls.push(key)
      return stopExplicitTargets.has(key)
    },
  }
  const d = {
    manager, modelRouter,
    bench: { cancel: () => { benchCancelCalls.push(1) } },
  } as unknown as Deps

  return { d, primaryStopCalls, stopExplicitCalls, benchCancelCalls }
}

function app(d: Deps) {
  const a = new Hono()
  a.post('/stop', async (c) => {
    let body: EngineStopBody = {}
    try { body = await c.req.json<EngineStopBody>() } catch { /* empty body is valid */ }
    return stopEngine(c, d, body)
  })
  return a
}

test('stopping a model key that names an extra pool slot stops that slot, not the primary', async () => {
  const h = mkDeps(new Set(['bge-m3']))
  const res = await app(h.d).request('/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'bge-m3' }),
  })

  assert.equal(res.status, 202)
  assert.deepEqual(h.stopExplicitCalls, ['bge-m3'])
  assert.deepEqual(h.primaryStopCalls, [], 'the primary (chat) engine must not be touched')
  assert.deepEqual(h.benchCancelCalls, [], 'no kill switch: the primary engine is not going away')
})

test('stopping with no model key falls back to the primary manager (unchanged behavior)', async () => {
  const h = mkDeps(new Set())
  const res = await app(h.d).request('/stop', { method: 'POST' })

  assert.equal(res.status, 202)
  assert.deepEqual(h.stopExplicitCalls, [])
  assert.equal(h.primaryStopCalls.length, 1)
  assert.equal(h.benchCancelCalls.length, 1, 'the kill switch still applies when the primary IS being stopped')
})

test('a model key that names no extra slot (e.g. the primary\'s own model) falls back to stopping the primary', async () => {
  const h = mkDeps(new Set()) // no extra slots at all
  const res = await app(h.d).request('/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'llama-8b' }),
  })

  assert.equal(res.status, 202)
  assert.deepEqual(h.stopExplicitCalls, ['llama-8b'])
  assert.equal(h.primaryStopCalls.length, 1)
  assert.equal(h.benchCancelCalls.length, 1)
})
