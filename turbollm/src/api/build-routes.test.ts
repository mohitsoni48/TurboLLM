import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { createEngineJobs } from './engine-work'
import { registerBuildRoutes } from './build-routes'

/** The method + path of every handler, middleware included, in the order Hono matches them (routes.ts mounts this
 *  module at its place in that order, scalability item 5.1). The handlers' behavior is covered by the route tests that
 *  drive registerApi. */
const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

test('registerBuildRoutes mounts its routes in their registration order', () => {
  const app = new Hono()
  registerBuildRoutes(app, {} as Deps, createEngineJobs())
  assert.deepEqual(routeTable(app), [
    'GET /api/v1/build/prereqs',
    'GET /api/v1/build/git-branches',
    'POST /api/v1/build/run',
    'POST /api/v1/build/cancel',
    'POST /api/v1/build/install-prereq',
    'POST /api/v1/build/cuda',
  ])
})
