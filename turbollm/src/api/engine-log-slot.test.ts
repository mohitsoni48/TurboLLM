// GET /api/v1/engine/logs[/stream] used to expose only the primary engine's log, though every pool slot (keep-N,
// embedding, Laya) writes its own engine-<id>-<port>.log that nothing in the UI could reach. `?model=<modelKey>`
// now picks a loaded slot's log. The key is looked up among the router's live slots and never turned into a path,
// so an unknown key (or a traversal attempt) is a 404 and the primary stays the default.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Hono } from 'hono'
import { registerApi } from './routes'
import type { Deps } from '../deps'
import { tmpDir } from '../test-support/tmp'

function fakeApp(primaryLog: string, slots: Record<string, string>) {
  const d = {
    version: 'test',
    store: { snapshot: () => ({}), read: () => ({}), update: (fn: (c: unknown) => void) => fn({}) },
    manager: { status: () => ({ state: 'stopped', model: null }), logPath: () => primaryLog },
    modelRouter: { slotLogs: () => Object.entries(slots).map(([modelKey, logPath]) => ({ modelKey, logPath })) },
  } as unknown as Deps
  const app = new Hono()
  registerApi(app, d)
  return app
}

test('GET /api/v1/engine/logs: ?model selects a pool slot\'s log, the primary stays the default', async () => {
  const dir = tmpDir('tllm-log-slot-')
  const primary = join(dir, 'engine-llama.log')
  const slot = join(dir, 'engine-llama-50123.log')
  writeFileSync(primary, 'primary 1\nprimary 2\n')
  writeFileSync(slot, 'slot 1\n')
  const app = fakeApp(primary, { 'embed-model': slot })

  const none = await (await app.request('/api/v1/engine/logs')).json()
  assert.deepEqual(none, { lines: ['primary 1', 'primary 2'], slots: ['embed-model'] }, 'the slots on offer ride along')

  const picked = await (await app.request('/api/v1/engine/logs?model=embed-model')).json()
  assert.deepEqual(picked, { lines: ['slot 1'], slots: ['embed-model'] })
})

test('GET /api/v1/engine/logs: an unknown model key is a 404, and no key can name a path', async () => {
  const dir = tmpDir('tllm-log-slot-404-')
  const primary = join(dir, 'engine-llama.log')
  writeFileSync(primary, 'primary\n')
  writeFileSync(join(dir, 'secret.txt'), 'secret\n')
  const app = fakeApp(primary, {})

  for (const key of ['nope', '../secret.txt', encodeURIComponent(join(dir, 'secret.txt')), '__proto__', 'constructor']) {
    const res = await app.request(`/api/v1/engine/logs?model=${encodeURIComponent(key)}`)
    assert.equal(res.status, 404, key)
    assert.doesNotMatch(await res.text(), /secret\n|primary\n/)
  }
})

test('GET /api/v1/engine/logs/stream: an unknown model key is a 404 before any stream opens', async () => {
  const dir = tmpDir('tllm-log-slot-stream-')
  const primary = join(dir, 'engine-llama.log')
  writeFileSync(primary, 'primary\n')
  const app = fakeApp(primary, {})
  const res = await app.request('/api/v1/engine/logs/stream?model=nope')
  assert.equal(res.status, 404)
})

test('GET /api/v1/engine/logs/stream: ?model streams the slot\'s log, not the primary\'s', async () => {
  const dir = tmpDir('tllm-log-slot-stream-ok-')
  const primary = join(dir, 'engine-llama.log')
  const slot = join(dir, 'engine-llama-50123.log')
  writeFileSync(primary, 'p\n')
  writeFileSync(slot, 'old slot line\n')
  const app = fakeApp(primary, { 'embed-model': slot })
  const res = await app.request('/api/v1/engine/logs/stream?model=embed-model')
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  await new Promise((r) => setTimeout(r, 600)) // the cursor seeds at the slot log's current end
  writeFileSync(slot, 'old slot line\nnew slot line\n')
  writeFileSync(primary, 'p\nprimary only line\n')
  const dec = new TextDecoder()
  let seen = ''
  const deadline = Date.now() + 3000
  while (!seen.includes('new slot line') && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    seen += dec.decode(value, { stream: true })
  }
  await reader.cancel()
  assert.match(seen, /new slot line/)
  assert.doesNotMatch(seen, /primary only line/)
})
