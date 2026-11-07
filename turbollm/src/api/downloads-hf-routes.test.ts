import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerDownloadsHfRoutes } from './downloads-hf-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerDownloadsHfRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerDownloadsHfRoutes(app, {} as Deps)
  assert.deepEqual(routeTable(app), [
    'GET /api/v1/modeldirs',
    'POST /api/v1/modeldirs',
    'DELETE /api/v1/modeldirs',
    'POST /api/v1/modeldirs/primary',
    'GET /api/v1/hf/search',
    'GET /api/v1/hf/models/:owner/:name',
    'POST /api/v1/hf/token/test',
    'GET /api/v1/downloads',
    'POST /api/v1/downloads',
    'POST /api/v1/downloads/:id/cancel',
    'POST /api/v1/downloads/:id/pause',
    'POST /api/v1/downloads/:id/resume',
    'DELETE /api/v1/downloads/:id',
  ])
})
