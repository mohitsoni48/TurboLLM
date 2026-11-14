import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerModelRoutes } from './models-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerModelRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerModelRoutes(app, {} as Deps)
  assert.deepEqual(routeTable(app), [
    'GET /api/v1/models',
    'POST /api/v1/models/rescan',
    'DELETE /api/v1/models/:key',
    'GET /api/v1/models/:key',
    'PUT /api/v1/models/:key/profile',
    'PUT /api/v1/models/:key/hidden',
    'POST /api/v1/models/:key/profile/reset',
    'GET /api/v1/sysinfo',
    'GET /api/v1/hwstats',
  ])
})
