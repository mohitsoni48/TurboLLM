// How often the models list refetches. It is the only thing that tells a row its model is loaded, so every load
// that can happen must keep it polling — including a Laya model's, which loads in its own slot while the primary
// stays stopped (ADR-443). Founder-reported, 2026-09-25: the Laya row never showed loading or loaded.
import { describe, expect, it } from 'vitest'
import { modelsRefetchInterval } from './models-poll'
import type { DownloadsList, ModelsList, Status } from './types'

const IDLE_STATUS = { engine: { state: 'stopped' }, laya: null } as unknown as Status
const list = (fields: Partial<ModelsList> = {}) => ({ models: [], scanning: false, ...fields }) as unknown as ModelsList

describe('modelsRefetchInterval', () => {
  it('polls fast while the library is being scanned', () => {
    expect(modelsRefetchInterval(list({ scanning: true }), IDLE_STATUS, undefined)).toBe(1200)
  })

  it('keeps polling while any model is loaded', () => {
    expect(modelsRefetchInterval(list({ models: [{ loaded: true }] as never }), IDLE_STATUS, undefined)).toBe(4000)
  })

  it('polls every second while the primary engine is starting', () => {
    const status = { engine: { state: 'starting' }, laya: null } as unknown as Status
    expect(modelsRefetchInterval(list(), status, undefined)).toBe(1000)
  })

  it('polls every second while a Laya model is starting in its own slot, the primary stopped', () => {
    const status = { engine: { state: 'stopped' }, laya: { key: 'laya', name: 'laya', checkpoints: [], state: 'starting' } } as unknown as Status
    expect(modelsRefetchInterval(list(), status, undefined)).toBe(1000)
  })

  it('polls until a finished download shows up in the library', () => {
    const downloads = { downloads: [{ status: 'done', dest: '/models/new.gguf' }] } as unknown as DownloadsList
    expect(modelsRefetchInterval(list(), IDLE_STATUS, downloads)).toBe(1500)
  })

  // A finished download is matched by LOCATION: the old `dest.endsWith(m.name)` compared a path to the GGUF's
  // display name and never matched, so any file that never becomes a row of its own kept this polling every 1.5 s
  // for the daemon's lifetime.
  describe('a finished download whose file belongs to an already-scanned row stops the poll', () => {
    const done = (...dests: string[]) => ({ downloads: dests.map((dest) => ({ status: 'done', dest })) }) as unknown as DownloadsList
    const gguf = { path: '/m/g/gemma-3-12b-it-Q4_K_M.gguf', dir: '/m/g', name: 'Gemma 3 12b It', mmprojPath: '/m/g/mmproj-F16.gguf' }
    const split = { path: '/m/q/Qwen3-235B-Q4_K_M-00001-of-00003.gguf', dir: '/m/q', name: 'Qwen3 235B' }
    const mlx = { path: '/m/org/Llama-3-8B-mlx', dir: '/m/org', name: 'Llama 3 8B' }
    const win = { path: 'C:\\m\\g\\model.gguf', dir: 'C:\\m\\g', name: 'Model' }
    const lib = list({ models: [gguf, split, mlx, win] as never })

    it('a vision GGUF and its mmproj projector', () => {
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done(gguf.path, '/m/g/mmproj-F16.gguf'))).toBe(false)
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done(win.path, 'C:\\m\\g\\mmproj-model-f16.gguf'))).toBe(false)
    })

    it('every shard of a split GGUF (its row is shard 1)', () => {
      const shards = [1, 2, 3].map((i) => `/m/q/Qwen3-235B-Q4_K_M-0000${i}-of-00003.gguf`)
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done(...shards))).toBe(false)
    })

    it('every component file of a directory (MLX/vLLM) model', () => {
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done(`${mlx.path}/config.json`, `${mlx.path}/model-00001-of-00002.safetensors`))).toBe(false)
    })

    it('but still waits for a NEW model file the scanner has not reached, even in a folder that has a row', () => {
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done('/m/g/gemma-3-12b-it-Q8_0.gguf'))).toBe(1500)
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done('/m/q/Qwen3-235B-Q8_0-00002-of-00004.gguf'))).toBe(1500)
      expect(modelsRefetchInterval(lib, IDLE_STATUS, done('/m/org/Llama-3-8B-mlx-4bit/config.json'))).toBe(1500)
    })
  })

  it('stops polling when nothing is scanning, loaded, loading or downloading', () => {
    expect(modelsRefetchInterval(list(), IDLE_STATUS, undefined)).toBe(false)
  })
})
