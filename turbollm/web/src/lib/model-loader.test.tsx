// ADR-434 (i)(3): loading a Jev model stops whatever is running, so it asks first — but only
// when something really is running, the same "active work, not an open window" rule as the
// daemon-restart gate. Loading a chat model keeps today's behaviour exactly (divergence row 17).
//
// The rule that matters most here is the failure direction: when the activity probe cannot be
// read, this must fail OPEN to a confirmation, never closed to a silent load. "I couldn't ask"
// is not "nothing is running".
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelLoader } from './model-loader'
import { useJevLoadStore } from '../stores/jev-load'
import type { ActiveWork } from './types'

const h = vi.hoisted(() => ({
  loadMutate: vi.fn(),
  getActivity: vi.fn(),
  loadIsPending: false,
  loadVariables: undefined as { key: string } | undefined,
}))

vi.mock('./queries', () => ({
  useModelActions: () => ({
    load: { mutate: h.loadMutate, isPending: h.loadIsPending, variables: h.loadVariables },
  }),
}))

vi.mock('./jev-api', () => ({ getActivity: () => h.getActivity() }))

const JEV = { key: 'jev-key', name: 'qwen3.5 4b nli v2', isJev: true }
const CHAT = { key: 'chat-key', name: 'qwen3.8 30b', isJev: false }

const IDLE: ActiveWork = { items: [], engineGenerating: false }
const CHATTING: ActiveWork = { items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false }
const API_GENERATING: ActiveWork = { items: [], engineGenerating: true }

beforeEach(() => {
  h.loadMutate.mockReset()
  h.getActivity.mockReset()
  h.loadIsPending = false
  h.loadVariables = undefined
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null })
})

function loader() {
  return renderHook(() => useModelLoader()).result
}

/** The options object the hook handed the mutation, i.e. `{ onError, onSuccess }`. */
function mutateCallbacks() {
  return h.loadMutate.mock.calls[0][1] as { onError?: (e: unknown) => void; onSuccess?: () => void }
}

describe('requestLoad — a chat model', () => {
  it('loads at once, exactly as the Models page does today', async () => {
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const result = loader()

    await act(async () => { result.current.requestLoad(CHAT, { overrides: { ctx: 4096 }, onError, onSuccess }) })

    expect(h.loadMutate).toHaveBeenCalledTimes(1)
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'chat-key', overrides: { ctx: 4096 } })
    mutateCallbacks().onSuccess?.()
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('never asks the daemon what is running — that question is only for a Jev load', async () => {
    const result = loader()
    await act(async () => { result.current.requestLoad(CHAT) })
    expect(h.getActivity).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().confirm).toBeNull()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })
})

describe('requestLoad — a Jev model with nothing running', () => {
  it('checks first, then loads without asking', async () => {
    h.getActivity.mockResolvedValue(IDLE)
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { overrides: { ctx: 8192 } }) })

    await waitFor(() => expect(h.loadMutate).toHaveBeenCalledTimes(1))
    expect(h.getActivity).toHaveBeenCalledTimes(1)
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'jev-key', overrides: { ctx: 8192 } })
    expect(useJevLoadStore.getState().confirm).toBeNull()
  })

  it('records the load as this browser\'s, which is what entitles it to a toast', async () => {
    h.getActivity.mockResolvedValue(IDLE)
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV) })

    await waitFor(() => expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key'))
  })
})

describe('requestLoad — a Jev model while work is running', () => {
  it('asks instead of loading, and hands the dialog what it would interrupt', async () => {
    h.getActivity.mockResolvedValue(CHATTING)
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { overrides: { ctx: 8192 } }) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm).not.toBeNull())
    expect(h.loadMutate).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().confirm).toEqual({ target: JEV, work: CHATTING, overrides: { ctx: 8192 } })
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('counts a generation with no item of its own — an API client mid-request', async () => {
    h.getActivity.mockResolvedValue(API_GENERATING)
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm?.work).toEqual(API_GENERATING))
    expect(h.loadMutate).not.toHaveBeenCalled()
  })

  it('fails OPEN when the probe cannot be read: it still asks, with no work to name', async () => {
    h.getActivity.mockRejectedValue(new Error('offline'))
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { overrides: { ctx: 8192 } }) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm).not.toBeNull())
    expect(useJevLoadStore.getState().confirm).toEqual({ target: JEV, work: null, overrides: { ctx: 8192 } })
    expect(h.loadMutate).not.toHaveBeenCalled()
  })
})

describe('a Jev load that fails', () => {
  it('clears the pending key before the caller hears about it, so no toast is left armed', async () => {
    h.getActivity.mockResolvedValue(IDLE)
    let pendingWhenCallerRan: string | null = 'not called'
    const onError = vi.fn(() => { pendingWhenCallerRan = useJevLoadStore.getState().pendingJevKey })
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { onError }) })
    await waitFor(() => expect(h.loadMutate).toHaveBeenCalledTimes(1))

    act(() => { mutateCallbacks().onError?.(new Error('engine refused')) })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(pendingWhenCallerRan).toBeNull()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('still passes a success through to the caller', async () => {
    h.getActivity.mockResolvedValue(IDLE)
    const onSuccess = vi.fn()
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { onSuccess }) })
    await waitFor(() => expect(h.loadMutate).toHaveBeenCalledTimes(1))

    mutateCallbacks().onSuccess?.()
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })
})

describe('pending state', () => {
  it('reports the load mutation\'s own busy state and the key it is loading', () => {
    h.loadIsPending = true
    h.loadVariables = { key: 'jev-key' }
    const result = loader()
    expect(result.current.isPending).toBe(true)
    expect(result.current.pendingKey).toBe('jev-key')
  })

  it('names no key while idle', () => {
    h.loadIsPending = false
    h.loadVariables = { key: 'jev-key' }
    const result = loader()
    expect(result.current.isPending).toBe(false)
    expect(result.current.pendingKey).toBeUndefined()
  })
})
