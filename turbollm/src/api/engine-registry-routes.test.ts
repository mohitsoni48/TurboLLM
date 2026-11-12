import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { createEngineJobs } from './engine-work'
import { registerEngineRegistryRoutes } from './engine-registry-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerEngineRegistryRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerEngineRegistryRoutes(app, {} as Deps, createEngineJobs())
  assert.deepEqual(routeTable(app), [
    'POST /api/v1/engines',
    'POST /api/v1/engines/scan',
    'POST /api/v1/engines/zip',
    'POST /api/v1/engines/zip',
    'POST /api/v1/engines/zip',
    'DELETE /api/v1/engines/zip',
    'DELETE /api/v1/engines/build',
  ])
})
