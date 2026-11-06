// Manager announces engine state and generation start/end on the daemon's invalidation bus, so an open page
// refetches /status and the models list when they change instead of polling every two seconds (review 4.14).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ConfigStore } from '../config/config'
import { COALESCE_WINDOW_MS, eventBus } from '../events/bus'
import { Manager } from './manager'
import { tmpDir } from '../test-support/tmp'

function listen(t: TestContext): () => string[] {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const heard = new Set<string>()
  t.after(eventBus.subscribe((keys) => keys.forEach((k) => heard.add(k))))
  return () => {
    t.mock.timers.tick(COALESCE_WINDOW_MS)
    const keys = [...heard].sort()
    heard.clear()
    return keys
  }
}

function manager(): Manager {
  return new Manager(ConfigStore.load(join(tmpDir('tllm-invalidation-'), 'config.json')))
}

test('the first generation starting and the last one ending are announced; the ones between are not', (t) => {
  const drain = listen(t)
  const m = manager()
  m.generationStart()
  assert.deepEqual(drain(), ['models', 'status'])
  m.generationStart()
  m.generationEnd()
  assert.deepEqual(drain(), [])
  m.generationEnd()
  assert.deepEqual(drain(), ['models', 'status'])
})

test('an engine state change is announced', (t) => {
  const drain = listen(t)
  const m = manager()
  ;(m as unknown as { state: string }).state = 'error'
  assert.deepEqual(drain(), ['models', 'status'])
  m.stop()
  assert.deepEqual(drain(), ['models', 'status'], 'clearing the error is a change too')
  m.stop()
  assert.deepEqual(drain(), [], 'stopping a stopped engine changes nothing')
})
