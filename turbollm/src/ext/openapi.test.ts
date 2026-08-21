import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { EXT_ROUTES, buildOpenApiDocument } from './openapi.js'
import { registerExtChatRoutes } from './routes.chats.js'
import { registerExtRunRoutes } from './routes.runs.js'
import { PublicRunManager } from './run-manager.js'
import { ConversationStore } from '../chat/db.js'
import { ChatStoreRouter } from '../chat/store/router.js'

test('the document is valid OpenAPI 3.1 with a title and version', () => {
  const doc = buildOpenApiDocument('1.0.0')
  assert.equal(doc.openapi, '3.1.0')
  assert.ok(doc.info.title)
  assert.equal(doc.info.version, '1.0.0')
})

test('every manifest route appears in paths under the ext base', () => {
  const doc = buildOpenApiDocument('1.0.0')
  for (const r of EXT_ROUTES) {
    const path = `/api/ext/v1${r.path}`
    assert.ok(doc.paths[path], `missing path ${path}`)
    assert.ok(doc.paths[path][r.method.toLowerCase()], `missing ${r.method} on ${path}`)
  }
})

test('every documented error type is one of the nine frozen types', () => {
  const doc = buildOpenApiDocument('1.0.0')
  const schema = doc.components.schemas.Error as { properties: { error: { properties: { type: { enum: string[] } } } } }
  assert.equal(schema.properties.error.properties.type.enum.length, 9)
})

test('no route is registered that the manifest does not document', () => {
  const app = new Hono()
  const d = { chatStore: { capabilities: {} }, store: { snapshot: () => ({ apiKeys: [] }) } } as never
  registerExtChatRoutes(app, d)

  const documented = new Set(EXT_ROUTES.map((r) => `${r.method} ${r.path}`))
  const registered = app.routes
    .filter((r) => r.path.startsWith('/api/ext/v1') && r.method !== 'ALL')
    .map((r) => `${r.method} ${r.path.replace('/api/ext/v1', '')}`)

  for (const r of registered) {
    assert.ok(documented.has(r), `route ${r} is live but undocumented — add it to EXT_ROUTES`)
  }
})

test('heavy fields are marked optional so include= is discoverable from the schema alone', () => {
  const doc = buildOpenApiDocument('1.0.0')
  const msg = doc.components.schemas.Message as { required: string[] }
  assert.ok(!msg.required.includes('reasoning'), 'reasoning is include-gated, so it cannot be required')
  assert.ok(msg.required.includes('content'))
})

// The live route code (routes.chats.ts, routes.runs.ts) accepts and persists an
// attachments-only message with absent/empty `content` — it only rejects a request when BOTH
// `content` and `attachments` are empty. `MessageInput.required` must not contradict that by
// forcing `content`, which would misdocument the server's own "content OR attachments" rule
// (the exact rule an earlier fix, C4, established for the runtime behavior).
test('MessageInput does not require content, matching the server\'s content-OR-attachments rule', () => {
  const doc = buildOpenApiDocument('1.0.0')
  const input = doc.components.schemas.MessageInput as { required?: string[]; description?: string; properties: Record<string, { description?: string }> }
  assert.ok(!(input.required ?? []).includes('content'), 'content must be optional — an attachments-only message is valid')
  // The OR constraint can't be expressed structurally in a flat `required` list, so it must be
  // documented in prose somewhere on the schema instead of silently dropped.
  const documentedSomewhere =
    (input.description ?? '').toLowerCase().includes('attachments') ||
    (input.properties.content?.description ?? '').toLowerCase().includes('attachments') ||
    (input.properties.attachments?.description ?? '').toLowerCase().includes('content')
  assert.ok(documentedSomewhere, 'the content-OR-attachments rule must be documented in a description since required[] cannot express it')
})

// Test 4 above only exercises registerExtChatRoutes (its `d` fake has no `manager`/`gate`, which
// routes.runs.ts's handlers need) — reviewed and confirmed a real gap: the 5 routes.runs.ts
// routes (POST .../messages/generate, GET /runs, GET /runs/:id, GET /runs/:id/stream,
// POST /runs/:id/cancel — 28% of the live surface) had NO drift-guard coverage at all. This test
// closes that gap the same way test 4 covers routes.chats.ts, reusing the exact construction
// routes.runs.test.ts's own `harness()` (lines 29-63 there) uses — a real ConversationStore over
// a temp directory, wrapped in a real ChatStoreRouter — rather than inventing a different, lighter
// double. (Not literally importing that helper: a `.test.ts` module has its OWN top-level test()
// calls, so importing it here would re-register and re-run every one of routes.runs.test.ts's
// tests a second time whenever this file runs as part of the full suite glob.)
test('no run route is registered that the manifest does not document', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-openapi-'))
  const conv = new ConversationStore(dir)
  try {
    const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
    const d = {
      db: conv,
      chatStore,
      store: { snapshot: () => ({ apiKeys: [] }) },
      manager: { status: () => ({ state: 'running', model: 'test-model' }), target: () => 'http://127.0.0.1:9999' },
    } as never
    const runs = new PublicRunManager()
    const app = new Hono()
    registerExtRunRoutes(app, d, runs, {
      makeBody: () => async () => ({ status: 'complete' as const }),
    })

    const documented = new Set(EXT_ROUTES.map((r) => `${r.method} ${r.path}`))
    const registered = app.routes
      .filter((r) => r.path.startsWith('/api/ext/v1') && r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path.replace('/api/ext/v1', '')}`)

    for (const r of registered) {
      assert.ok(documented.has(r), `route ${r} is live but undocumented — add it to EXT_ROUTES`)
    }
  } finally {
    conv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
