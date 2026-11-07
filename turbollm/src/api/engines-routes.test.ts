import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { createEngineJobs } from './engine-work'
import { registerEngineRoutes } from './engines-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerEngineRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerEngineRoutes(app, {} as Deps, createEngineJobs())
  assert.deepEqual(routeTable(app), [
    'GET /api/v1/engines',
    'GET /api/v1/engines/backends',
    'POST /api/v1/engines/backends/install',
    'POST /api/v1/engines/backends/cancel',
    'POST /api/v1/engines/backends/:id/update',
    'POST /api/v1/engines/backends/:id/enable',
    'DELETE /api/v1/engines/backends/:id',
    'POST /api/v1/engines/mlx',
    'POST /api/v1/engines/rapid-mlx',
    'POST /api/v1/engines/mlx-vlm',
    'POST /api/v1/engines/laya',
    'GET /api/v1/engines/catalog',
    'GET /api/v1/engines/recommendation',
  ])
})
