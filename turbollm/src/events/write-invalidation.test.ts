import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { EventBus } from './bus'
import { invalidateOnWrite, keysForWrite } from './write-invalidation'

test('a config-backed write names the families it changes', () => {
  assert.deepEqual(keysForWrite('/api/v1/settings'), ['settings', 'status', 'voice'])
  assert.deepEqual(keysForWrite('/api/v1/engines/llama/update'), ['engines', 'status'])
  assert.deepEqual(keysForWrite('/api/v1/engine/start'), ['engines', 'status'])
  assert.deepEqual(keysForWrite('/api/v1/build/start'), ['engines', 'status'])
  assert.deepEqual(keysForWrite('/api/v1/models/abc/load'), ['models', 'status'])
  assert.deepEqual(keysForWrite('/api/v1/modeldirs'), ['models', 'status'])
  assert.deepEqual(keysForWrite('/api/v1/bench/run'), ['status'])
})

test('remote access and Turbo Link writes name the status they show in', () => {
  assert.deepEqual(keysForWrite('/api/v1/remote/tunnel'), ['status'])
  assert.deepEqual(keysForWrite('/api/v1/links'), ['status'])
  assert.deepEqual(keysForWrite('/api/v1/links/l1/select'), ['status'])
  assert.deepEqual(keysForWrite('/api/v1/linksx'), [])
})

test('paths whose stores announce their own changes, or that nothing caches, name nothing', () => {
  assert.deepEqual(keysForWrite('/api/v1/conversations/c1'), [])
  assert.deepEqual(keysForWrite('/api/v1/settingsx'), [])
  assert.deepEqual(keysForWrite('/api/v1/telemetry/ui'), [])
})

async function respond(method: string, path: string, status: number): Promise<string[][]> {
  const bus = new EventBus(0)
  const heard: string[][] = []
  bus.subscribe((keys) => heard.push([...keys]))
  const app = new Hono()
  app.use('/api/v1/*', invalidateOnWrite(bus))
  app.on(method, path, (c) => c.json({}, status as 200))
  await app.request(path, { method })
  await new Promise((r) => setTimeout(r, 5))
  return heard
}

test('a successful write is announced once it has been answered', async () => {
  assert.deepEqual(await respond('PATCH', '/api/v1/settings', 200), [['settings', 'status', 'voice']])
})

test('a read, or a refused write, is not announced', async () => {
  assert.deepEqual(await respond('GET', '/api/v1/settings', 200), [])
  assert.deepEqual(await respond('PATCH', '/api/v1/settings', 400), [])
})
