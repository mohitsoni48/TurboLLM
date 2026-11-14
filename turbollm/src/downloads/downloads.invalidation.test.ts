// A download's record changing state (queued, paused, cancelled, done, errored) is announced on the daemon's
// invalidation bus, so an open page refetches its downloads list then rather than polling (review 4.14).
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DownloadManager, setDownloadGetForTests } from './downloads'
import { COALESCE_WINDOW_MS, eventBus } from '../events/bus'
import { tmpDir } from '../test-support/tmp'

setDownloadGetForTests(() => new Promise(() => {}))

function manager(): DownloadManager {
  const root = tmpDir('tllm-dl-invalidation-')
  const modelDir = join(root, 'models')
  const stateDir = join(root, 'state')
  mkdirSync(modelDir, { recursive: true })
  const store = {
    dir: () => stateDir,
    snapshot: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
    read: () => ({ primaryModelDir: modelDir, modelDirs: [modelDir] }),
  } as unknown as ConstructorParameters<typeof DownloadManager>[0]
  return new DownloadManager(store, () => {}, () => ({}))
}

test('queueing and pausing a download are announced as `downloads`', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const heard: string[][] = []
  t.after(eventBus.subscribe((keys) => heard.push([...keys])))
  const dm = manager()
  const [rec] = await dm.enqueue({ repo: 'owner/repo', rfilename: 'model.gguf', size: 10 })
  t.mock.timers.tick(COALESCE_WINDOW_MS)
  assert.deepEqual(heard, [['downloads']])

  dm.pause(rec.id)
  t.mock.timers.tick(COALESCE_WINDOW_MS)
  assert.deepEqual(heard, [['downloads'], ['downloads']])
})
