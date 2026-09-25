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

  it('stops polling when nothing is scanning, loaded, loading or downloading', () => {
    expect(modelsRefetchInterval(list(), IDLE_STATUS, undefined)).toBe(false)
  })
})
