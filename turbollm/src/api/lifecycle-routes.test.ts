import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { registerLifecycleRoutes } from './lifecycle-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerLifecycleRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerLifecycleRoutes(app, {} as Deps)
  assert.deepEqual(routeTable(app), [
    'POST /api/v1/engine/start',
    'POST /api/v1/engine/stop',
    'POST /api/v1/engine/restart',
    'POST /api/v1/comfyui/acquire',
    'POST /api/v1/comfyui/release',
    'POST /api/v1/comfyui/install',
    'POST /api/v1/comfyui/uninstall',
    'POST /api/v1/daemon/restart',
    'POST /api/v1/daemon/flush',
  ])
})
