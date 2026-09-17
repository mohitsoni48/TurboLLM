// Regression coverage for the eject-targets-the-wrong-engine bug: `stopEngine`
// (`POST /api/v1/engine/stop`, the Models page/topbar "Eject" button) took no model
// identity at all and unconditionally called `d.manager.stop()` — the PRIMARY manager.
// Ejecting an embedding model loaded into its own pool slot (ADR-389) actually stopped
// the chat model instead; retrying then did nothing, since the primary was already
// stopped and the embedding model was never in it. `stopEngine` must route through
// `ModelRouter.stopExplicit` when the given key names an extra slot, and fall back to
// the primary manager (the existing behavior) otherwise — same coexistence rule
// `startEngine`'s `entry.embedding` branch already applies on load.
//
// Second regression (Opus release review, v1.13.4): the FIRST version of this fix treated
// `stopExplicit` returning false as "fall back to the primary" unconditionally — but false
// also means "this key names nothing loaded at all" (a stale/duplicate eject click after
// the slot already drained, or a load that hasn't finished populating extraSlots yet), not
// only "this key names the primary." Conflating the two meant a stale key could still kill
// the PRIMARY (chat) engine — exactly the bug this file exists to prevent, just reached a
// different way. The fallback now only stops the primary when the key actually names its
// currently-loaded model (by key OR path, mirroring ModelRouter's own `keysMatch`);
// anything else is a safe no-op.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { stopEngine, type EngineStopBody } from './engine-lifecycle'
import type { Deps } from '../deps'

function mkDeps(opts: {
  stopExplicitTargets?: Set<string>
  primaryKey?: string | null
  primaryPath?: string
} = {}) {
  const { stopExplicitTargets = new Set(), primaryKey = null, primaryPath } = opts
  const primaryStopCalls: number[] = []
  const stopExplicitCalls: string[] = []
  const benchCancelCalls: number[] = []

  const manager = {
    status: () => ({ state: primaryKey ? 'running' : 'stopped', model: primaryKey ? { key: primaryKey } : null }),
    stop: () => { primaryStopCalls.push(1) },
  }
  const modelRouter = {
    stopExplicit: (key: string) => {
      stopExplicitCalls.push(key)
      return stopExplicitTargets.has(key)
    },
  }
  const scanner = {
    get: (key: string) => (key === primaryKey && primaryPath ? { path: primaryPath } : undefined),
  }
  const d = {
    manager, modelRouter, scanner,
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
  const h = mkDeps({ stopExplicitTargets: new Set(['bge-m3']), primaryKey: 'llama-8b' })
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
  const h = mkDeps({ primaryKey: 'llama-8b' })
  const res = await app(h.d).request('/stop', { method: 'POST' })

  assert.equal(res.status, 202)
  assert.deepEqual(h.stopExplicitCalls, [])
  assert.equal(h.primaryStopCalls.length, 1)
  assert.equal(h.benchCancelCalls.length, 1, 'the kill switch still applies when the primary IS being stopped')
})

test('a model key that names the primary\'s own model falls back to stopping the primary', async () => {
  const h = mkDeps({ primaryKey: 'llama-8b' }) // no extra slots at all
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

test('a model key that names the primary\'s model by its on-disk PATH also stops the primary', async () => {
  const h = mkDeps({ primaryKey: 'llama-8b', primaryPath: 'D:\\models\\llama-8b.gguf' })
  const res = await app(h.d).request('/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'D:\\models\\llama-8b.gguf' }),
  })

  assert.equal(res.status, 202)
  assert.equal(h.primaryStopCalls.length, 1)
})

test('a model key that names NEITHER an extra slot NOR the primary is a safe no-op — the primary is never touched', async () => {
  // Reproduces the second regression: a stale/duplicate eject click (the slot already
  // drained from an earlier request) or a load still mid-flight (extraSlots not yet
  // populated) must never fall through to killing whatever the primary happens to be
  // running right now.
  const h = mkDeps({ primaryKey: 'llama-8b' }) // 'ghost-model' matches nothing
  const res = await app(h.d).request('/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelKey: 'ghost-model' }),
  })

  assert.equal(res.status, 202)
  assert.deepEqual(h.stopExplicitCalls, ['ghost-model'])
  assert.deepEqual(h.primaryStopCalls, [], 'a stale key must not take down an unrelated running engine')
  assert.deepEqual(h.benchCancelCalls, [], 'no kill switch fires for a no-op')
})
