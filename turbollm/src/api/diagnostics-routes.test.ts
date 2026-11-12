import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerDiagnosticsRoutes } from './diagnostics-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerDiagnosticsRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerDiagnosticsRoutes(app, {} as Deps)
  assert.deepEqual(routeTable(app), [
    'GET /api/v1/engine/logs',
    'GET /api/v1/engine/logs/stream',
    'GET /api/v1/requests/stream',
    'GET /api/v1/requests',
    'GET /api/v1/requests/:id',
    'DELETE /api/v1/requests',
    'POST /api/v1/bench',
    'POST /api/v1/bench/cancel',
    'POST /api/v1/bench/save',
    'GET /api/v1/bench/log',
  ])
})
