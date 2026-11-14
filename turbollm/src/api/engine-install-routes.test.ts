import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { createEngineJobs } from './engine-work'
import { registerEngineInstallRoutes } from './engine-install-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerEngineInstallRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerEngineInstallRoutes(app, {} as Deps, createEngineJobs())
  assert.deepEqual(routeTable(app), [
    'POST /api/v1/engines/vllm',
    'POST /api/v1/engines/sglang',
    'POST /api/v1/engines/litert-lm',
    'POST /api/v1/engines/turboquant',
    'POST /api/v1/engines/koboldcpp',
    'POST /api/v1/engines/llamafile',
  ])
})
