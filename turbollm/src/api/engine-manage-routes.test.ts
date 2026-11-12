import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { createEngineJobs } from './engine-work'
import { registerEngineManageRoutes } from './engine-manage-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerEngineManageRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerEngineManageRoutes(app, {} as Deps, createEngineJobs())
  assert.deepEqual(routeTable(app), [
    'PUT /api/v1/engines/:id',
    'DELETE /api/v1/engines/custom-sources/:key',
    'DELETE /api/v1/engines/:id',
    'POST /api/v1/engines/:id/activate',
    'POST /api/v1/engines/:id/update',
    'POST /api/v1/engines/:id/reprobe',
    'GET /api/v1/engines/updates',
  ])
})
