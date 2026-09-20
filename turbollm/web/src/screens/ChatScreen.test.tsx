// ADR-434 (f): the Chat model picker must never offer a Jev model — it labels text and cannot
// chat, and a loaded one would turn this whole screen into the playground. Renders the REAL screen
// (its own model-list logic) with the data hooks and heavy children stubbed at their boundary —
// the same "mock at the API boundary, keep the screen's own logic real" discipline as
// CodeSessionScreen.test.tsx.
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelEntry } from '../lib/types'

// jsdom's environment doesn't wire up a working localStorage (the thinking-budget and reasoning-
// effort readers touch it on first render) — same gap CodeSessionScreen.test.tsx works around.
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

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useStatus: () => ({ data: { engine: { state: 'running' } } }),
    useModels: () => ({ data: { models: mockLibrary } }),
    useModelActions: () => ({
      load: { mutate: vi.fn(), isPending: false },
      eject: { mutate: vi.fn(), isPending: false },
    }),
    useModelDetail: () => ({ data: undefined }),
    useEngines: () => ({ data: undefined }),
    useSettings: () => ({ query: { data: undefined } }),
    useSysInfo: () => ({ data: undefined }),
    useChatAgents: () => ({ data: [] }),
    useBuiltinAgentOverrides: () => ({ data: {} }),
  }
})

vi.mock('../lib/chat-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/chat-queries')>()
  return {
    ...actual,
    useConversation: () => ({ data: undefined }),
    useConversationMutations: () => ({ create: { mutateAsync: vi.fn() }, update: { mutate: vi.fn(), mutateAsync: vi.fn() } }),
  }
})

vi.mock('../lib/link-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/link-queries')>()
  return {
    ...actual,
    useLinks: () => ({ data: [] }),
    useRemoteModels: () => ({ data: [] }),
    useLinkStatus: () => ({ data: undefined }),
  }
})

vi.mock('../lib/agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agent-api')>()
  return { ...actual, fetchSkills: () => Promise.resolve([]) }
})

vi.mock('../lib/useIsDesktop', () => ({ useIsDesktop: () => true }))

// pdfjs-dist reads DOMMatrix at import time, which jsdom lacks; no PDF is attached in this test.
vi.mock('../lib/pdf-extract', () => ({ extractPdfText: vi.fn() }))

vi.mock('./chat/ConversationSidebar', () => ({ ConversationSidebar: () => null }))
vi.mock('./chat/ConversationSettingsDialog', () => ({ ConversationSettingsDialog: () => null }))
vi.mock('./models/ModelDetailDialog', () => ({ ModelDetailDialog: () => null }))

let modelsOfferedByPicker: Array<Partial<ModelEntry>> | null = null
vi.mock('../components/ModelLoadMenu', () => ({
  ModelLoadMenu: (props: { models: Array<Partial<ModelEntry>> }) => {
    modelsOfferedByPicker = props.models
    return null
  },
}))

async function renderScreen() {
  const { ChatScreen } = await import('./ChatScreen')
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ChatScreen /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ChatScreen — model picker offers chat models only', () => {
  const chatModel: Partial<ModelEntry> = { key: 'qwen3-8b', name: 'Qwen3 8B', compatibleWithActiveEngine: true }
  const jevModel: Partial<ModelEntry> = {
    key: 'qwen3.5 4b nli v2', name: 'qwen3.5 4b nli v2', compatibleWithActiveEngine: true,
    jev: { labels: ['contradiction', 'entailment', 'neutral'], nliTemplate: 'Premise: {premise} Hypothesis: {hypothesis}', architecture: 'Qwen3_5ForSequenceClassification', verified: true },
  }
  const wrongEngineChatModel: Partial<ModelEntry> = { key: 'gguf-on-vllm', name: 'GGUF on vLLM', compatibleWithActiveEngine: false }

  beforeEach(() => {
    mockLibrary = [chatModel, jevModel, wrongEngineChatModel]
    modelsOfferedByPicker = null
  })

  it('offers the engine-compatible chat model and not the Jev model', async () => {
    await renderScreen()
    await waitFor(() => expect(modelsOfferedByPicker).not.toBeNull())
    expect(modelsOfferedByPicker?.map((m) => m.key)).toEqual(['qwen3-8b'])
  })
})
