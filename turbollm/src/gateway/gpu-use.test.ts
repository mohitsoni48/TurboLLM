// The cards' use as a pool-slot load reads it (placeOnFreeVram): only where the engine's card numbers are the readers'
// (H1 of the 4.7 review), and read at most once per short window (L1), with no nvidia-smi: the card reader is injected.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Engine } from '../config/config'
import type { SysInfo } from '../sysinfo/sysinfo'
import { createGpuUseReader } from './gpu-use'

const gpus = (...names: string[]): SysInfo => ({
  os: 'linux/x64', cpu: 'test', cores: 16, ramMB: 64000,
  gpus: names.map((name) => ({ name, vramMb: 24000, vendor: 'nvidia' as const })),
})
const SAME = gpus('RTX 4090', 'RTX 4090')
const MIXED = gpus('RTX 4090', 'RTX 3090')
const cuda = { binPath: '/data/engines/llama.cpp-b1-cuda/llama-server' } as Engine
const vulkan = { binPath: '/data/engines/llama.cpp-b1-vulkan/llama-server' } as Engine

function reader(sys: SysInfo, env: NodeJS.ProcessEnv = {}) {
  let reads = 0
  let clock = 1000
  const read = createGpuUseReader({
    sys: () => sys, env, now: () => clock, readCards: async () => { reads++; return [100, 200] },
  })
  return { read: (e: Engine, fresh?: boolean) => read(e, '/data/engines/build', fresh), reads: () => reads, advance: (ms: number) => { clock += ms } }
}

test('identical CUDA cards: the reading is returned', async () => {
  const r = reader(SAME)
  assert.deepEqual(await r.read(cuda), { sys: SAME, usedMb: [100, 200] })
})

test('a mixed-model box has no reading: CUDA numbers the fastest card first, not in PCI order', async () => {
  const r = reader(MIXED)
  assert.equal(await r.read(cuda), null)
  assert.equal(r.reads(), 0, 'nothing is read for a placement that cannot be trusted')
})

test('a Vulkan build has no reading: the display GPU is numbered first', async () => {
  const r = reader(SAME)
  assert.equal(await r.read(vulkan), null)
})

for (const v of ['CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'GPU_DEVICE_ORDINAL']) {
  test(`${v} set: no reading, the variable renumbers the cards`, async () => {
    assert.equal(await reader(SAME, { [v]: '1,0' }).read(cuda), null)
  })
}

test('a box without GPUs has no reading', async () => {
  assert.equal(await reader(gpus()).read(cuda), null)
})

test('the reading is cached for a short window, so loads under the swap lock do not each run nvidia-smi', async () => {
  const r = reader(SAME)
  await r.read(cuda)
  r.advance(1500)
  await r.read(cuda)
  assert.equal(r.reads(), 1)
  r.advance(1000)
  await r.read(cuda)
  assert.equal(r.reads(), 2, 'past the window it is read again')
})

test('a fresh reading bypasses the cache (after an eviction the cards have changed)', async () => {
  const r = reader(SAME)
  await r.read(cuda)
  await r.read(cuda, true)
  assert.equal(r.reads(), 2)
})
