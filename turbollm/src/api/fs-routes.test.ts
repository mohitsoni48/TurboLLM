import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerFsRoutes } from './fs-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerFsRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerFsRoutes(app, {} as Deps)
  assert.deepEqual(routeTable(app), [
    'GET /api/v1/fs/browse',
    'GET /api/v1/fs/git-branch',
  ])
})
