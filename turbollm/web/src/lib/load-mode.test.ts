// Which load-config UI a model gets follows the engine that will load it (BUG-004). A Laya model always loads on
// the Laya engine, which has no launch flags, whatever engine is active (ADR-443).
import { describe, expect, it } from 'vitest'
import { loadModeFor } from './load-mode'
import type { Engine } from './types'

describe('loadModeFor', () => {
  it('follows the active engine for an ordinary model', () => {
    expect(loadModeFor({}, { kind: 'llama-server' })).toBe('llamacpp')
    expect(loadModeFor({}, { kind: 'vllm' })).toBe('vllm')
    expect(loadModeFor({}, { kind: 'mlx' })).toBe('mlx')
    expect(loadModeFor({}, { kind: 'litert-lm' })).toBe('litert-lm')
    expect(loadModeFor({}, undefined)).toBe('none')
  })

  it('gives a Laya model no load knobs, even while llama.cpp is the active engine', () => {
    expect(loadModeFor({ laya: { checkpoints: ['english'] } }, { kind: 'llama-server' })).toBe('none')
  })

  // ADR-462: the in-app SDK's LiteRT-LM row takes the LiteRT-LM load options (backend, ctx, threads); its other rows
  // and the pre-ADR-462 single SDK row keep none.
  it('gives the in-app LiteRT-LM row the LiteRT-LM load options', () => {
    expect(loadModeFor({}, { kind: 'turbollm-sdk', formats: ['litertlm'] })).toBe('litert-lm')
  })

  it('Q-1: gives any SDK row that reads only .litertlm (a future NPU row too) the LiteRT-LM load options', () => {
    const npuRow: Pick<Engine, 'kind' | 'formats' | 'sdkEngine'> = {
      kind: 'turbollm-sdk',
      formats: ['litertlm'],
      sdkEngine: { id: 'litert-npu', kind: 'litert-lm', formats: ['litertlm'], backends: ['gpu'] },
    }
    expect(loadModeFor({}, npuRow)).toBe('litert-lm')
  })

  it('gives the in-app llama.cpp row and the legacy SDK row no load knobs', () => {
    expect(loadModeFor({}, { kind: 'turbollm-sdk', formats: ['gguf'] })).toBe('none')
    expect(loadModeFor({}, { kind: 'turbollm-sdk', formats: ['gguf', 'litertlm'] })).toBe('none')
    expect(loadModeFor({}, { kind: 'turbollm-sdk' })).toBe('none')
  })
})
