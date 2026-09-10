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

test('DELETE /compact: 404 for a nonexistent conversation', async () => {
  const { app, cleanup } = makeApp()
  try {
    const res = await app.request('/api/v1/conversations/does-not-exist/compact', { method: 'DELETE' })
    assert.equal(res.status, 404)
  } finally {
    cleanup()
  }
})
