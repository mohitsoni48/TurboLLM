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
import { hashKey } from '../auth.js'

type JsonSchemaLike = { required?: string[]; allOf?: { $ref?: string }[] }

// Resolves a schema's FULL effective `required` set, including anything pulled in via
// `allOf: [{ $ref: ... }]` (the exact mechanism `pageOf()` in openapi.ts uses to compose a
// list schema out of the shared `Page` envelope) — a schema's own `properties`/`required`
// block can look complete while still inheriting extra required fields from an `allOf` ref
// that a real response never actually has to satisfy.
function resolveRequired(schema: JsonSchemaLike, schemas: Record<string, JsonSchemaLike>): string[] {
  const required = new Set(schema.required ?? [])
  for (const sub of schema.allOf ?? []) {
    if (!sub.$ref) continue
    const name = sub.$ref.replace('#/components/schemas/', '')
    const resolved = schemas[name]
    assert.ok(resolved, `allOf references unknown schema ${name}`)
    for (const f of resolveRequired(resolved, schemas)) required.add(f)
  }
  return [...required]
}

test('the document is valid OpenAPI 3.1 with a title and version', () => {
  const doc = buildOpenApiDocument('1.0.0')
  assert.equal(doc.openapi, '3.1.0')
  assert.ok(doc.info.title)
  assert.equal(doc.info.version, '1.0.0')
})

test('every manifest route appears in paths under the ext base, using {param} templating', () => {
  const doc = buildOpenApiDocument('1.0.0')
  for (const r of EXT_ROUTES) {
    // The paths KEY is `{id}`-templated (release-gate I11 — a real OpenAPI path key, not
    // Hono's `:id` syntax); `r.path` itself stays `:id`-style everywhere else (see the
    // route-existence tests below, which compare against Hono's own `app.routes`).
    const path = `/api/ext/v1${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`
    assert.ok(doc.paths[path], `missing path ${path}`)
    const op = doc.paths[path][r.method.toLowerCase()] as { parameters?: Array<{ name: string; in: string }> } | undefined
    assert.ok(op, `missing ${r.method} on ${path}`)
    for (const name of (r.path.match(/:([A-Za-z0-9_]+)/g) ?? []).map((s) => s.slice(1))) {
      assert.ok(
        op!.parameters?.some((p) => p.name === name && p.in === 'path'),
        `expected a real path parameter "${name}" on ${r.method} ${path}, not just a templated key`,
      )
    }
  }
})

// Release-gate I11: buildOperation's default status inference (POST+schema -> 201) was wrong
// for these two — POST .../messages/generate really returns 202 (routes.runs.ts), and
// POST /runs/:id/cancel really returns 200 (it updates an existing resource, not creating one).
// The sibling POST /chats/:id/messages entry already correctly documented 202 for the identical
// forwarded behavior via altResponse, which is what made the other two's 201 self-contradictory.
test('POST .../messages/generate documents 202, not the default-inferred 201', () => {
  const doc = buildOpenApiDocument('1.0.0')
  const op = doc.paths['/api/ext/v1/chats/{id}/messages/generate'].post as { responses: Record<string, unknown> }
  assert.ok(op.responses['202'], 'expected a 202 response entry')
  assert.ok(!op.responses['201'], 'must not ALSO claim 201 — that is the wrong status for this route')
})

test('POST /runs/:id/cancel documents 200, not the default-inferred 201', () => {
  const doc = buildOpenApiDocument('1.0.0')
  const op = doc.paths['/api/ext/v1/runs/{id}/cancel'].post as { responses: Record<string, unknown> }
  assert.ok(op.responses['200'], 'expected a 200 response entry')
  assert.ok(!op.responses['201'], 'cancelling an existing run is not resource creation')
})

// Release-gate I11: `owner` decides whose data a call reads or writes — it was undocumented on
// every route, including the ones with no requestSchema (so no other way for a schema reader to
// discover it exists at all).
test('every route without a request body documents owner as an optional query parameter', () => {
  const doc = buildOpenApiDocument('1.0.0')
  const skip = new Set(['GET /capabilities', 'GET /openapi.json'])
  for (const r of EXT_ROUTES) {
    if (r.requestSchema || skip.has(`${r.method} ${r.path}`)) continue
    const path = `/api/ext/v1${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`
    const op = doc.paths[path][r.method.toLowerCase()] as { parameters?: Array<{ name: string; in: string; required: boolean }> }
    const owner = op.parameters?.find((p) => p.name === 'owner')
    assert.ok(owner, `expected an owner query param on ${r.method} ${r.path}`)
    assert.equal(owner!.in, 'query')
    assert.equal(owner!.required, false, "owner defaults to 'default' server-side, so it must not be required")
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

// The drift-guard tests above only check that a route HAS a manifest entry — not that the
// manifest's declared response schema actually matches what the route returns. GET /audit
// slipped through exactly that gap: its `responseSchema: 'AuditPage'` was built with
// `pageOf('AuditRow')`, which wraps the schema in `allOf: [{$ref: 'Page'}]` — and `Page`
// requires `has_more`/`next_cursor`. The real route (routes.chats.ts) only ever returns
// `{ data: [...] }`; `AuditLog.list()` (audit.ts) has no cursor parameter at all, just
// `limit`/`since`. This test hits the real route and checks the real response body against
// the schema's own fully-resolved `required` set (allOf included), so a mismatch between
// "what the schema promises" and "what the handler returns" fails here directly — not just
// "does a manifest entry exist."
test('GET /audit response body satisfies every field its own documented schema requires', async () => {
  const doc = buildOpenApiDocument('1.0.0')
  const operation = doc.paths['/api/ext/v1/audit'].get as {
    responses: Record<string, { content?: { 'application/json'?: { schema: { $ref?: string } } } }>
  }
  const schemaRef = operation.responses['200']?.content?.['application/json']?.schema
  assert.ok(schemaRef?.$ref, 'GET /audit has no documented application/json response schema')
  const schemaName = (schemaRef.$ref as string).replace('#/components/schemas/', '')
  const required = resolveRequired(doc.components.schemas[schemaName] as JsonSchemaLike, doc.components.schemas as Record<string, JsonSchemaLike>)

  const dir = mkdtempSync(join(tmpdir(), 'turbollm-ext-openapi-audit-'))
  const conv = new ConversationStore(dir)
  try {
    const chatStore = new ChatStoreRouter(conv.chatStore, conv.chatStore)
    const key = 'tllm-ext-openapi-audit-drift-test'
    const d = {
      db: conv,
      chatStore,
      store: { snapshot: () => ({ apiKeys: [{ hash: hashKey(key), tenant: 'acme' }] }) },
    } as never
    const app = new Hono()
    registerExtChatRoutes(app, d)

    const res = await app.request('/api/ext/v1/audit', { headers: { Authorization: `Bearer ${key}` } })
    assert.equal(res.status, 200)
    const responseBody = await res.json() as Record<string, unknown>

    for (const field of required) {
      assert.ok(
        field in responseBody,
        `${schemaName} declares "${field}" required, but the real GET /audit response has no such key ` +
        `(got: ${Object.keys(responseBody).join(', ') || '<none>'}) — schema/route drift`,
      )
    }
  } finally {
    conv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
