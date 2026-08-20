import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { EXT_ROUTES, buildOpenApiDocument } from './openapi.js'
import { registerExtChatRoutes } from './routes.chats.js'

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
