import { describe, expect, it } from 'vitest'
import { branchLabel, defaultBuildName } from './engine-build-name'

const prism = { id: 'prism', name: 'Prism (llama.cpp fork)' }

describe('defaultBuildName', () => {
  it('appends the branch to a fork card name', () => {
    expect(defaultBuildName(prism, 'prism')).toBe('Prism (llama.cpp fork)-prism')
  })

  it('appends nothing for an unknown (blank) branch instead of inventing "-main"', () => {
    expect(defaultBuildName(prism, '')).toBe('Prism (llama.cpp fork)')
    expect(defaultBuildName(prism, '   ')).toBe('Prism (llama.cpp fork)')
  })

  it('uses the Llama-<branch> convention for the official llama.cpp cards', () => {
    for (const id of ['llama.cpp', 'llama.cpp-cuda-linux', 'llama.cpp-android-source', 'llama.cpp-source']) {
      expect(defaultBuildName({ id, name: 'anything' }, 'master')).toBe('Llama-master')
    }
    expect(defaultBuildName({ id: 'llama.cpp-source', name: 'x' }, '')).toBe('Llama')
  })

  it('falls back to a generic name when the catalog entry has not loaded yet', () => {
    expect(defaultBuildName(undefined, 'main')).toBe('engine-main')
    expect(defaultBuildName(undefined, '')).toBe('engine')
  })
})

describe('branchLabel', () => {
  it('spells out a blank branch as the repo default, and leaves a real branch alone', () => {
    expect(branchLabel('')).toBe('(repo default)')
    expect(branchLabel('main')).toBe('main')
  })
})
