// Global load-lock regression tests (rules 1 & 2): only ONE model load/reload may be
// in flight at a time, no matter who requests it — even across SEPARATE Manager
// instances (the gateway keep-N pool uses extra Managers). The lock is a static gate
// shared by every Manager, held through readiness, so two engines can never spin up at
// once. This test drives two Managers concurrently and asserts their loads serialise.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { ConfigStore } from '../config/config'
import { Manager, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

const FAKE_MODEL_PATH = join(tmpDir('tllm-fake-model-'), 'does-not-need-to-exist.gguf')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeOpts(): StartOpts {
  return {
    // node rejects these args and exits immediately → a load resolves quickly (state→error)
    // without needing a real engine, so the test exercises the gate, not a live model.
    engine: {
      id: 'test', name: 'Fake Engine', binPath: process.execPath, kind: 'llama-server',
      version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    },
    model: { key: 'm', name: 'Fake Model', quant: 'Q4', ctx: 4096, vision: false },
    modelPath: FAKE_MODEL_PATH,
    extraArgs: [],
  }
}

test('two concurrent loads on different Managers run one-at-a-time (global lock)', async () => {
  const dir = tmpDir('tllm-lock-')
  const store = ConfigStore.load(join(dir, 'config.json'))
  const a = new Manager(store)
  const b = new Manager(store)

  const events: string[] = []
  // The beforeStart hook runs INSIDE the gate, so its ordering proves serialisation:
  // B's hook must not begin until A's entire load (hook + spawn + readiness) has finished.
  const loadA = a.load(fakeOpts(), {
    beforeStart: async () => {
      events.push('a-start')
      await sleep(150)
      events.push('a-end')
    },
  })
  const loadB = b.load(fakeOpts(), {
    beforeStart: async () => {
      events.push('b-start')
    },
  })

  await Promise.all([loadA, loadB])

  // Whichever acquired the gate first must fully finish before the other's hook starts.
  // With A enqueued first that means: a-start, a-end, then b-start — never interleaved.
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start'])
})
