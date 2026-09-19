import { describe, expect, it } from 'vitest'
import { deleteTargetFor } from './engine-delete-target'
import type { Engine } from './types'

const registered = (over: Partial<Engine> & { id: string; name: string; binPath: string }): Engine => ({
  version: '',
  capabilities: { kvTypes: [], flags: [] },
  ...over,
})

describe('deleteTargetFor', () => {
  // A catalog card claims whichever registered engine matches it, and once one is deleted it claims the
  // NEXT. A dialog naming the card ("Delete llama.cpp (Build from Source)?") looks identical both times, so
  // a user who thinks the first delete failed clicks again and destroys a second multi-GB build.
  it('names the REGISTERED engine and its build path, not the card that claimed it', () => {
    const built = registered({ id: 'a', name: 'Prism (llama.cpp fork)-prism', binPath: 'C:/e/build/prismml-eng-llama.cpp-prism/llama-server.exe' })
    expect(deleteTargetFor('a', [built], 'Prism (llama.cpp fork)')).toEqual({
      name: 'Prism (llama.cpp fork)-prism',
      registryId: 'a',
      binPath: 'C:/e/build/prismml-eng-llama.cpp-prism/llama-server.exe',
    })
  })

  it('tells two builds claimed by the same card apart', () => {
    const named = registered({ id: 'named', name: 'llama.cpp (Build from Source)', binPath: 'C:/e/build/ggml-org-llama.cpp-master/llama-server.exe' })
    const legacy = registered({ id: 'legacy', name: 'Llama Build', binPath: 'C:/e/build/ggml-org-llama.cpp/llama-server.exe' })
    const first = deleteTargetFor('named', [named, legacy], 'llama.cpp (Build from Source)')
    const second = deleteTargetFor('legacy', [legacy], 'llama.cpp (Build from Source)')
    expect(first.name).not.toBe(second.name)
    expect(first.binPath).not.toBe(second.binPath)
  })

  it('falls back to the card name, with no path, when the engine is not in the registry list', () => {
    expect(deleteTargetFor('gone', [], 'Prism (llama.cpp fork)')).toEqual({
      name: 'Prism (llama.cpp fork)',
      registryId: 'gone',
      binPath: undefined,
    })
  })
})
