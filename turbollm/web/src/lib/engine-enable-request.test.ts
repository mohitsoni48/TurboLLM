import { describe, expect, it } from 'vitest'
import type { CatalogEngine } from './types'
import { enableRequestFor } from './engine-enable-request'

function builtCard(overrides: Partial<CatalogEngine> = {}): CatalogEngine {
  return {
    id: 'prism',
    name: 'Prism (llama.cpp fork)',
    homepage: 'https://github.com/PrismML-Eng/llama.cpp',
    sourceBuilt: true,
    sourceBinPath: '/engines/build/prismml-eng-llama.cpp-prism/build/bin/llama-server',
    sourceBranch: 'prism',
    ...overrides,
  } as CatalogEngine
}

describe('enableRequestFor', () => {
  it('re-registers a built engine at its binary, on the branch its folder was built for', () => {
    expect(enableRequestFor(builtCard())).toEqual({
      binPath: '/engines/build/prismml-eng-llama.cpp-prism/build/bin/llama-server',
      name: 'Prism (llama.cpp fork)',
      sourceRepo: 'https://github.com/PrismML-Eng/llama.cpp',
      sourceBranch: 'prism',
      sourceCommit: undefined,
      sourcePatchUrl: undefined,
    })
  })

  it('sends no branch for the bare, blank-branch build folder', () => {
    expect(enableRequestFor(builtCard({ sourceBranch: '' })).sourceBranch).toBeUndefined()
  })

  it('carries the pinned commit and patch, which a pinned card matches its engine on', () => {
    // Without them the registered engine belongs to no card: Enable "works" and the card still says not installed.
    const pinned = builtCard({ id: 'solar-open2', sourceBranch: '', sourceCommit: '846e991ec3c7', patchUrl: 'https://example.test/solar.patch' })
    const request = enableRequestFor(pinned)
    expect(request.sourceCommit).toBe('846e991ec3c7')
    expect(request.sourcePatchUrl).toBe('https://example.test/solar.patch')
  })
})
