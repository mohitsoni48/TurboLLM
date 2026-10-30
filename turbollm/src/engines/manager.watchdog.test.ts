// The idle watchdog's timer must not pin a Manager for life: the gateway pool builds a fresh Manager for
// every side-model, Laya or new-slot load and drops it on eject, eviction or a failed load, and an
// interval armed in the constructor kept every one of them (plus a per-minute config clone) alive forever.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { ConfigStore } from '../config/config'
import { Manager, type StartOpts } from './manager'
import { tmpDir } from '../test-support/tmp'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** node rejects "-m <path> --host …" and exits at once: an engine that runs, then is gone. */
function crashingEngine(): StartOpts {
  return {
    engine: {
      id: 'test', name: 'Fake Engine', binPath: process.execPath, kind: 'llama-server',
      version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '',
    },
    model: { key: 'm', name: 'Fake Model', quant: 'Q4', ctx: 4096, vision: false },
    modelPath: join(tmpDir('tllm-fake-model-'), 'model.gguf'),
    extraArgs: [],
  }
}

async function collectedOf(count: number, make: () => Promise<Manager>): Promise<number> {
  let collected = 0
  const registry = new FinalizationRegistry(() => { collected++ })
  for (let i = 0; i < count; i++) registry.register(await make(), i)
  // Up to ~2 s: a just-exited engine's readiness poll (a 500 ms sleep) still holds its Manager briefly.
  for (let round = 0; round < 80 && collected < count; round++) {
    gc()
    await sleep(25)
  }
  return collected
}

test('a dropped Manager whose engine has exited is garbage-collected', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-watchdog-'), 'config.json'))

  const collected = await collectedOf(5, async () => {
    const manager = new Manager(store, { poolSlot: true })
    await manager.start(crashingEngine()) // returns once the engine has left 'starting'
    while (manager.status().state !== 'error') await sleep(20)
    return manager
  })

  assert.equal(collected, 5)
})

test('a dropped Manager that never loaded anything is garbage-collected', async () => {
  const store = ConfigStore.load(join(tmpDir('tllm-watchdog-'), 'config.json'))

  const collected = await collectedOf(20, async () => new Manager(store))

  assert.equal(collected, 20)
})
