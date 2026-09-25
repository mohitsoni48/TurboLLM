import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Deps } from '../deps'
import { ScannerError } from '../models/scanner'
import { registerApi } from './routes'

for (const [code, status] of [['unsafe_model_delete', 409], ['no_such_model', 404]] as const) {
  test(`model deletion returns ${status} for ${code} and preserves the explanation`, async () => {
    const app = new Hono()
    const message = 'Real target: /external/model.gguf. Manage it directly at its real location.'
    registerApi(app, {
      scanner: {
        get: () => ({ key: 'model', path: '/library/model.gguf' }),
        delete: async () => { throw new ScannerError(code, message) },
      },
      manager: { status: () => ({ state: 'stopped' }) },
      modelRouter: { loadedModelKeys: () => new Set<string>() },
    } as unknown as Deps)
    const response = await app.request('/api/v1/models/model', { method: 'DELETE' })
    assert.equal(response.status, status)
    const body = await response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, code)
    assert.equal(body.error.message, message)
  })
}
