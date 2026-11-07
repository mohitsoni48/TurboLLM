// A finished library scan is announced as `models` on the daemon's invalidation bus, so an open page refetches
// the models list when a download lands or a folder is added, rather than polling for it (review 4.14).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigStore } from '../config/config'
import { eventBus } from '../events/bus'
import { tmpDir } from '../test-support/tmp'
import { Scanner } from './scanner'

test('a scan pass announces `models` once it has finished', async (t) => {
  const root = tmpDir('tllm-scan-invalidation-')
  const store = { dir: () => root, snapshot: () => ({ modelDirs: [root] }), read: () => ({ modelDirs: [root] }) } as unknown as ConfigStore
  const heard: string[] = []
  t.after(eventBus.subscribe((keys) => heard.push(...keys)))

  await new Scanner(store).rescan()
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(heard, ['models'])
})
