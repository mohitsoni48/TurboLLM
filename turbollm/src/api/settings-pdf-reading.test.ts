// Settings → Tool permissions → "Read PDFs in fetch_url": the running ToolRegistry must see the new value at once.
// It holds its own copy of config.tools (ToolRegistry.updateConfig), so a save that does not refresh it leaves
// fetch_url answering "PDF reading is disabled" until the daemon restarts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { registerApi } from './routes'
import { ConfigStore } from '../config/config'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function mk() {
  const store = ConfigStore.load(join(tmpDir('tllm-pdf-reading-'), 'config.json'))
  const seen: Array<boolean | undefined> = []
  const tools = {
    updateConfig: (cfg: { pdfReading?: boolean }) => { seen.push(cfg.pdfReading) },
    buildToolDefinitions: async () => {},
  }
  const app = new Hono()
  registerApi(app, { version: 'test', store, tools, manager: { status: () => ({ state: 'stopped', model: null }) } } as unknown as Deps)
  const patch = (body: unknown) => app.request('/api/v1/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { patch, seen }
}

test('turning PDF reading on hands the new value to the running tool registry', async () => {
  const { patch, seen } = mk()
  assert.equal((await patch({ pdfReading: true })).status, 200)
  assert.deepEqual(seen, [true])
})

test('turning PDF reading off hands the new value to the running tool registry', async () => {
  const { patch, seen } = mk()
  await patch({ pdfReading: true })
  assert.equal((await patch({ pdfReading: false })).status, 200)
  assert.deepEqual(seen, [true, false])
})
