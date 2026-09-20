// ADR-434 (f): the Code launchpad's composer starts an agent session, and a Jev model labels
// text and can never drive one. Renders the REAL screen (its own model-list logic) with the heavy
// children and the data hooks stubbed at their boundary — the same "mock at the API boundary,
// keep the screen's own logic real" discipline as CodeSessionScreen.test.tsx.
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '../../lib/types'

// jsdom's environment doesn't wire up a working localStorage — same gap CodeSessionScreen.test.tsx
// and CodeComposer.test.tsx work around.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
})

let mockLibrary: Array<Partial<ModelEntry>> = []

vi.mock('../../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: mockLibrary } }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useGitBranch: () => ({ data: undefined }),
  }
})

vi.mock('../../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/link-queries')>()
  return { ...actual, useLinks: () => ({ data: [] }), useRemoteModels: () => ({ data: [] }) }
})

vi.mock('../../lib/code-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-queries')>()
  return { ...actual, useCodeStats: () => ({ data: undefined }) }
})

vi.mock('../../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))

vi.mock('../chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('../engines/FsBrowser', () => ({ FsBrowser: () => null }))
vi.mock('../models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))
vi.mock('./CodeActivityHeatmap', () => ({ CodeActivityHeatmap: () => null }))

let modelsOfferedByComposer: Array<Partial<ModelEntry>> | null = null
vi.mock('./CodeComposer', () => ({
  CodeComposer: (props: { models: Array<Partial<ModelEntry>> }) => {
    modelsOfferedByComposer = props.models
    return null
  },
}))

async function renderScreen() {
  const { CodeHomeScreen } = await import('./CodeHomeScreen')
  return render(<MemoryRouter><CodeHomeScreen /></MemoryRouter>)
}

describe('CodeHomeScreen — model picker offers chat models only', () => {
  const chatModel: Partial<ModelEntry> = { key: 'qwen3-8b', name: 'Qwen3 8B', compatibleWithActiveEngine: true }
  const jevModel: Partial<ModelEntry> = {
    key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', compatibleWithActiveEngine: true,
    jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: 'Premise: {premise} Hypothesis: {hypothesis}', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
  }
  const wrongEngineChatModel: Partial<ModelEntry> = { key: 'gguf-on-vllm', name: 'GGUF on vLLM', compatibleWithActiveEngine: false }

  beforeEach(() => {
    mockLibrary = [chatModel, jevModel, wrongEngineChatModel]
    modelsOfferedByComposer = null
  })

  it('offers the engine-compatible chat model and not the Jev model', async () => {
    await renderScreen()
    await waitFor(() => expect(modelsOfferedByComposer).not.toBeNull())
    expect(modelsOfferedByComposer?.map((m) => m.key)).toEqual(['qwen3-8b'])
  })
})
