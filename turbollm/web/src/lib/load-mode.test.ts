// Which load-config UI a model gets follows the engine that will load it (BUG-004). A Laya model always loads on
// the Laya engine, which has no launch flags, whatever engine is active (ADR-443).
import { describe, expect, it } from 'vitest'
import { loadModeFor } from './load-mode'

describe('loadModeFor', () => {
  it('follows the active engine for an ordinary model', () => {
    expect(loadModeFor({}, 'llama-server')).toBe('llamacpp')
    expect(loadModeFor({}, 'vllm')).toBe('vllm')
    expect(loadModeFor({}, 'mlx')).toBe('mlx')
    expect(loadModeFor({}, undefined)).toBe('none')
  })

  it('gives a Laya model no load knobs, even while llama.cpp is the active engine', () => {
    expect(loadModeFor({ laya: { checkpoints: ['english'] } }, 'llama-server')).toBe('none')
  })
})
