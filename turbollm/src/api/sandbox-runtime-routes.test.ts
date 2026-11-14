import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { defaultConfig } from '../config/config'
import type { Deps } from '../deps'
import type { SandboxRuntime, SandboxRuntimeView } from '../sandbox/runtime-install'
import { SandboxRuntimeError } from '../sandbox/runtime-install'
import { registerSandboxRuntimeRoutes } from './sandbox-runtime-routes'

const routeTable = (app: Hono) => app.routes.map((r) => `${r.method} ${r.path}`)

/** A stand-in runtime that records what the routes asked of it. */
function fakeRuntime(over: Partial<SandboxRuntimeView> = {}) {
  const calls: string[] = []
  let view: SandboxRuntimeView = { supported: true, installed: null, downloadBytes: 75e6, diskBytes: 130e6, job: { state: 'idle', doneBytes: 0 }, ...over }
  const rt = {
    view: () => view,
    install: () => { calls.push('install'); view = { ...view, job: { state: 'running', doneBytes: 0 } }; return Promise.resolve() },
    cancel: () => { calls.push('cancel'); return true },
    remove: async () => {
      calls.push('remove')
      if (view.job.state === 'running') throw new SandboxRuntimeError('sandbox_runtime_busy', 'busy')
      return true
    },
  } as unknown as SandboxRuntime
  return { rt, calls }
}

function mkApp(sandbox: boolean, runtime: SandboxRuntime | undefined) {
  const cfg = defaultConfig()
  cfg.daemon.experimental.sandbox = sandbox
  const d = { store: { snapshot: () => cfg, read: () => cfg }, sandboxRuntime: runtime } as unknown as Deps
  const app = new Hono()
  registerSandboxRuntimeRoutes(app, d)
  return app
}

test('registerSandboxRuntimeRoutes mounts its routes in their registration order', () => {
  assert.deepEqual(routeTable(mkApp(false, fakeRuntime().rt)), [
    'GET /api/v1/sandbox/runtime',
    'GET /api/v1/sandbox/runtime',
    'POST /api/v1/sandbox/runtime/install',
    'POST /api/v1/sandbox/runtime/install',
    'DELETE /api/v1/sandbox/runtime/install',
    'DELETE /api/v1/sandbox/runtime/install',
    'DELETE /api/v1/sandbox/runtime',
    'DELETE /api/v1/sandbox/runtime',
  ])
})

test('GET reports the flag and the runtime, whatever the flag', async () => {
  const res = await mkApp(false, fakeRuntime().rt).request('/api/v1/sandbox/runtime')
  assert.equal(res.status, 200)
  const body = await res.json() as Record<string, unknown>
  assert.equal(body.enabled, false)
  assert.equal(body.supported, true)
  assert.equal(body.installed, null)
})

test('install is refused with a typed code while the flag is off, and starts nothing', async () => {
  const { rt, calls } = fakeRuntime()
  const res = await mkApp(false, rt).request('/api/v1/sandbox/runtime/install', { method: 'POST' })
  assert.equal(res.status, 403)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'sandbox_disabled')
  assert.deepEqual(calls, [])
})

test('install with the flag on starts the download and answers 202 at once', async () => {
  const { rt, calls } = fakeRuntime()
  const res = await mkApp(true, rt).request('/api/v1/sandbox/runtime/install', { method: 'POST' })
  assert.equal(res.status, 202)
  assert.deepEqual(calls, ['install'])
  assert.equal(((await res.json()) as SandboxRuntimeView).job.state, 'running')
})

test('install when already installed answers 200', async () => {
  const { rt } = fakeRuntime({ installed: { deno: '2.9.6', pyodide: '0.29.5' } })
  assert.equal((await mkApp(true, rt).request('/api/v1/sandbox/runtime/install', { method: 'POST' })).status, 200)
})

test('a cross-site write is refused before it reaches the runtime', async () => {
  const { rt, calls } = fakeRuntime()
  const res = await mkApp(true, rt).request('/api/v1/sandbox/runtime/install', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(res.status, 403)
  assert.deepEqual(calls, [])
})

test('cancel and remove stay reachable with the flag off', async () => {
  const { rt, calls } = fakeRuntime({ installed: { deno: '2.9.6', pyodide: '0.29.5' } })
  const app = mkApp(false, rt)
  assert.equal((await app.request('/api/v1/sandbox/runtime/install', { method: 'DELETE' })).status, 200)
  assert.equal((await app.request('/api/v1/sandbox/runtime', { method: 'DELETE' })).status, 200)
  assert.deepEqual(calls, ['cancel', 'remove'])
})

test('remove during a download answers 409 with the runtime\'s code', async () => {
  const { rt } = fakeRuntime({ job: { state: 'running', doneBytes: 1 } })
  const res = await mkApp(true, rt).request('/api/v1/sandbox/runtime', { method: 'DELETE' })
  assert.equal(res.status, 409)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'sandbox_runtime_busy')
})

test('every route answers 501 sandbox_unsupported where there is no runtime (Android)', async () => {
  const app = mkApp(true, undefined)
  for (const [method, path] of [['GET', '/api/v1/sandbox/runtime'], ['POST', '/api/v1/sandbox/runtime/install'], ['DELETE', '/api/v1/sandbox/runtime']]) {
    const res = await app.request(path, { method })
    assert.equal(res.status, 501, `${method} ${path}`)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'sandbox_unsupported')
  }
})
