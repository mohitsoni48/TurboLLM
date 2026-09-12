// Route-level coverage for the two new /compact endpoints (ADR-420). The turn-triggered
// auto-compact path (maybeAutoCompact called from POST /messages and POST /continue) is
// exercised at the unit level in chat-compaction.test.ts — SSE plumbing itself doesn't need
// re-testing here, just that these two standalone endpoints wire correctly to
// compactConversation/clearConversationCompaction and return the right status codes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerChatRoutes } from './chat-routes.js'
import { ConversationStore } from './db.js'
import type { Deps } from '../deps.js'

// Mirrors chat-routes.persist.test.ts's mkHarness() exactly — same field set, same
// cast-through-unknown style, same "omit what's only reached via optional chaining".
function makeApp(): { app: Hono; store: ConversationStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tllm-chat-compaction-route-'))
  const store = new ConversationStore(dir)
  const cfg = {
    modelDefaults: { maxTokens: 0 },
    gateway: { autoSwap: true },
    daemon: { autoGenerateTitles: false, experimental: { memory: false }, autoMemoryEnabled: false },
    tools: { toolPolicies: {}, autoAllowAll: false },
    requestLog: { enabled: false },
  }
  const d = {
    db: store,
    store: { snapshot: () => cfg, dir: () => dir },
    scanner: { get: () => undefined },
    registry: { active: () => ({ kind: 'llama.cpp', id: 'e1', capabilities: {} }) },
    manager: {
      status: () => ({ state: 'running', model: { key: 'm', name: 'Test Model', ctx: 8192 } }),
      target: () => 'http://127.0.0.1:8081',
      currentOpts: () => null,
      generationStart: () => {},
      generationEnd: () => {},
      setLiveGen: () => {},
      recordCompletion: () => {},
    },
    // Only reached when a truthy `model` string is resolved (chat-upstream.ts's
    // `wanted ? d.modelRouter?.resolveRemoteTarget?.(wanted) : undefined`) — a link the
    // request names but that isn't connected, so resolution fails distinguishably from
    // "no model requested, use local".
    modelRouter: {
      resolveRemoteTarget: (wanted: string) =>
        wanted === 'linked-fake/big' ? { status: 503, message: 'rig not connected' } : undefined,
    },
  } as unknown as Deps
  const app = new Hono()
  registerChatRoutes(app, d)
  return { app, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('POST /compact: 404 for a nonexistent conversation', async () => {
  const { app, cleanup } = makeApp()
  try {
    const res = await app.request('/api/v1/conversations/does-not-exist/compact', { method: 'POST' })
    assert.equal(res.status, 404)
  } finally {
    cleanup()
  }
})

test('POST /compact: 400 nothing_to_compact for a too-short conversation', async () => {
  const { app, store, cleanup } = makeApp()
  try {
    const conv = store.createConversation({ title: 'Test' })
    store.addMessage(conv.id, 'user', 'hi')
    const res = await app.request(`/api/v1/conversations/${conv.id}/compact`, { method: 'POST' })
    assert.equal(res.status, 400)
    const body = await res.json() as { error: { code: string } }
    assert.equal(body.error.code, 'nothing_to_compact')
  } finally {
    cleanup()
  }
})

test('DELETE /compact: clears a prior compaction and returns the updated conversation', async () => {
  const { app, store, cleanup } = makeApp()
  try {
    const conv = store.createConversation({ title: 'Test' })
    const msg = store.addMessage(conv.id, 'user', 'hi')
    store.setConversationCompaction(conv.id, { summary: 's', upToMessageId: msg.id, tokensBefore: 1 })
    const res = await app.request(`/api/v1/conversations/${conv.id}/compact`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const body = await res.json() as { compactionSummary?: string }
    assert.equal(body.compactionSummary, undefined)
  } finally {
    cleanup()
  }
})

test('POST /compact: honors the request body\'s `model`, not the conversation\'s stale bound `modelKey` (opus-review I-A)', async () => {
  const { app, store, cleanup } = makeApp()
  try {
    // conv.modelKey is set to a DIFFERENT, disconnected remote than the body names — if the
    // route consulted modelKey at all (even as a fallback), resolution would land on that
    // remote instead. Pins that `b.model` wins outright, not just that it's read when
    // modelKey happens to be empty.
    const conv = store.createConversation({ title: 'Test', modelKey: 'other-rig/small' })
    store.addMessage(conv.id, 'user', 'hi')
    const res = await app.request(`/api/v1/conversations/${conv.id}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'linked-fake/big' }),
    })
    assert.equal(res.status, 503)
    const body = await res.json() as { error: { code: string } }
    assert.equal(body.error.code, 'remote_unavailable')
  } finally {
    cleanup()
  }
})

test('POST /compact: a bodyless request goes LOCAL even when `conv.modelKey` points at a remote — modelKey is never consulted as a fallback (opus-review I-A′, no older client to protect since the daemon ships its own webdist)', async () => {
  const { app, store, cleanup } = makeApp()
  try {
    // If modelKey were read as a fallback, this would hit the disconnected 'linked-fake/big'
    // remote and 503. Instead it must resolve to the (healthy) local engine and fail only on
    // message count, proving modelKey plays no role at all in resolution.
    const conv = store.createConversation({ title: 'Test', modelKey: 'linked-fake/big' })
    store.addMessage(conv.id, 'user', 'hi')
    const res = await app.request(`/api/v1/conversations/${conv.id}/compact`, { method: 'POST' })
    assert.equal(res.status, 400)
    const body = await res.json() as { error: { code: string } }
    assert.equal(body.error.code, 'nothing_to_compact')
  } finally {
    cleanup()
  }
})

test('DELETE /compact: 404 for a nonexistent conversation', async () => {
  const { app, cleanup } = makeApp()
  try {
    const res = await app.request('/api/v1/conversations/does-not-exist/compact', { method: 'DELETE' })
    assert.equal(res.status, 404)
  } finally {
    cleanup()
  }
})
