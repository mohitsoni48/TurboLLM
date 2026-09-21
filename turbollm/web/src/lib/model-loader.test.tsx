// ADR-434 (i)(3): loading a Jev model stops whatever is running, so it asks first — but only
// when something really is running, the same "active work, not an open window" rule as the
// daemon-restart gate. Loading a chat model keeps today's behaviour exactly (divergence row 17).
//
// The rule that matters most here is the failure direction: when the activity probe cannot be
// read, this must fail OPEN to a confirmation, never closed to a silent load. "I couldn't ask"
// is not "nothing is running".
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfirmedLoad, useJevLoadedToast, useModelLoader } from './model-loader'
import { useJevLoadStore } from '../stores/jev-load'
import type { ActiveWork, JevStatus, Status } from './types'

const h = vi.hoisted(() => ({
  loadMutate: vi.fn(),
  getActivity: vi.fn(),
  status: undefined as Status | undefined,
  pathname: '/models',
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  track: vi.fn(),
}))

vi.mock('./queries', () => ({
  useModelActions: () => ({
    load: { mutate: h.loadMutate },
  }),
  useStatus: () => ({ data: h.status }),
}))

vi.mock('./jev-api', () => ({ getActivity: () => h.getActivity() }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, track: (...a: unknown[]) => h.track(...a) }
})

vi.mock('../components/ui/sonner', () => ({
  toast: { success: (...a: unknown[]) => h.toastSuccess(...a), error: (...a: unknown[]) => h.toastError(...a) },
}))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => h.navigate, useLocation: () => ({ pathname: h.pathname }) }
})

// The caller hands over what it already has about the model; the model's own `jev` field is
// what decides, so there is no `isJev` flag a call site can forget (§5 ruling 9).
const JEV = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  jev: { labels: [], nliTemplate: null, architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}
const OTHER_JEV = { ...JEV, key: 'other-jev-key', name: 'deberta v3 nli' }
const CHAT = { key: 'chat-key', name: 'qwen3.8 30b' }

const IDLE: ActiveWork = { items: [], engineGenerating: false }
const CHATTING: ActiveWork = { items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false }
const API_GENERATING: ActiveWork = { items: [], engineGenerating: true }

beforeEach(() => {
  h.loadMutate.mockReset()
  h.getActivity.mockReset()
  h.navigate.mockReset()
  h.toastSuccess.mockReset()
  h.toastError.mockReset()
  h.track.mockReset()
  h.status = undefined
  h.pathname = '/models'
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null, pendingLoadKey: null, loadError: null })
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
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'chat-key', overrides: { ctx: 4096 }, announceFailure: true })
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
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'jev-key', overrides: { ctx: 8192 }, announceFailure: true })
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
    expect(useJevLoadStore.getState().confirm).toEqual({ target: JEV, work: CHATTING, opts: { overrides: { ctx: 8192 } } })
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('carries the caller\'s own handlers into the confirmation, so confirming changes nothing else', async () => {
    h.getActivity.mockResolvedValue(CHATTING)
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { onError, onSuccess }) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm).not.toBeNull())
    expect(useJevLoadStore.getState().confirm?.opts).toEqual({ onError, onSuccess })
  })

  it('counts a generation with no item of its own — an API client mid-request', async () => {
    h.getActivity.mockResolvedValue(API_GENERATING)
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm?.work).toEqual(API_GENERATING))
    expect(h.loadMutate).not.toHaveBeenCalled()
  })

  // The Load buttons only go disabled once a mutation starts, and the activity probe is a
  // round trip before that: two clicks inside that window must not swap the question under a
  // user already reaching for "Load anyway", taking the first caller's callbacks with it.
  it('leaves a question already on screen alone', async () => {
    h.getActivity.mockResolvedValue(CHATTING)
    const onSuccess = vi.fn()
    const result = loader()
    await act(async () => { result.current.requestLoad(JEV, { onSuccess }) })
    await waitFor(() => expect(useJevLoadStore.getState().confirm).not.toBeNull())

    await act(async () => { result.current.requestLoad(OTHER_JEV) })

    expect(useJevLoadStore.getState().confirm).toEqual({ target: JEV, work: CHATTING, opts: { onSuccess } })
    expect(h.loadMutate).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('asks the next question once the first one has been answered', async () => {
    h.getActivity.mockResolvedValue(CHATTING)
    const result = loader()
    await act(async () => { result.current.requestLoad(JEV) })
    await waitFor(() => expect(useJevLoadStore.getState().confirm).not.toBeNull())

    act(() => { useJevLoadStore.getState().setConfirm(null) })
    await act(async () => { result.current.requestLoad(OTHER_JEV) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm?.target).toEqual(OTHER_JEV))
  })

  it('fails OPEN when the probe cannot be read: it still asks, with no work to name', async () => {
    h.getActivity.mockRejectedValue(new Error('offline'))
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { overrides: { ctx: 8192 } }) })

    await waitFor(() => expect(useJevLoadStore.getState().confirm).not.toBeNull())
    expect(useJevLoadStore.getState().confirm).toEqual({ target: JEV, work: null, opts: { overrides: { ctx: 8192 } } })
    expect(h.loadMutate).not.toHaveBeenCalled()
  })
})

// The failure itself is the mutation's to record and to report (`queries.test.tsx`), because
// the surface that fired the load has usually closed by then. What the loader owes a caller is
// that its own handlers still reach the load.
describe('a Jev load that fails', () => {
  it('hands the failure on to a caller that asked to hear about it', async () => {
    h.getActivity.mockResolvedValue(IDLE)
    const onError = vi.fn()
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { onError }) })
    await waitFor(() => expect(h.loadMutate).toHaveBeenCalledTimes(1))

    act(() => { mutateCallbacks().onError?.(new Error('engine refused')) })

    expect(onError).toHaveBeenCalledTimes(1)
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

// QA E17, E31(c): a refused load is never a silent no-op. Every load started here is marked
// for the mutation to report, whether or not the caller passed a handler of its own — the
// report has to outlive the surface, so it cannot be a `mutate()` callback.
describe('a load nobody asked to hear about', () => {
  it('marks a chat load as one the mutation reports', async () => {
    const result = loader()

    await act(async () => { result.current.requestLoad(CHAT) })

    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'chat-key', overrides: undefined, announceFailure: true })
  })

  it('marks a Jev load the same way, handler of its own or not', async () => {
    h.getActivity.mockResolvedValue(IDLE)
    const result = loader()

    await act(async () => { result.current.requestLoad(JEV, { onError: vi.fn() }) })

    await waitFor(() => expect(h.loadMutate).toHaveBeenCalledTimes(1))
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'jev-key', overrides: undefined, announceFailure: true })
  })
})

// ADR-434 (i)(3): answering the confirmation must not change what the load does — same pending
// key, same failure surface, same caller callbacks as the load that was never interrupted.
describe('useConfirmedLoad — the (i)(3) confirmation, accepted', () => {
  function confirmedLoad() {
    return renderHook(() => useConfirmedLoad()).result
  }

  it('claims the toast for this browser, exactly as an unasked Jev load does', () => {
    const result = confirmedLoad()

    act(() => { result.current(JEV, {}) })

    expect(h.loadMutate).toHaveBeenCalledTimes(1)
    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'jev-key', overrides: undefined, announceFailure: true })
    expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key')
  })

  it('still calls the caller\'s onSuccess, so the surface that asked can close itself', () => {
    const onSuccess = vi.fn()
    const result = confirmedLoad()

    act(() => { result.current(JEV, { onSuccess }) })
    mutateCallbacks().onSuccess?.()

    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it('carries the overrides the caller asked for', () => {
    const result = confirmedLoad()

    act(() => { result.current(JEV, { overrides: { ctx: 8192 } }) })

    expect(h.loadMutate.mock.calls[0][0]).toEqual({ key: 'jev-key', overrides: { ctx: 8192 }, announceFailure: true })
  })

  // The confirmation host is mounted for the whole life of the app and renders nothing until
  // it has a question to ask. Reading load state it never shows would re-render it on every
  // transition of every load.
  it('costs nothing to a surface that reads no load state', () => {
    let renders = 0
    renderHook(() => { renders += 1; return useConfirmedLoad() })
    const beforeTheLoad = renders

    act(() => { useJevLoadStore.getState().loadStarted('someone-elses-load') })

    expect(renders).toBe(beforeTheLoad)
  })

  it('still re-renders the surfaces that do read it', () => {
    let renders = 0
    renderHook(() => { renders += 1; return useModelLoader() })
    const beforeTheLoad = renders

    act(() => { useJevLoadStore.getState().loadStarted('someone-elses-load') })

    expect(renders).toBeGreaterThan(beforeTheLoad)
  })
})

// C-7, C-8: the load that is really running, not this hook's own mutation observer — which is
// blind to a load the confirmation dialog fired. `queries.test.tsx` pins the other half: the
// mutation keeps this key itself, so it survives the firing surface closing.
describe('pending state', () => {
  it('reports the load that is running and the key it is loading, whoever started it', () => {
    useJevLoadStore.setState({ pendingLoadKey: 'jev-key' })
    const result = loader()
    expect(result.current.isPending).toBe(true)
    expect(result.current.pendingKey).toBe('jev-key')
  })

  it('names no key while idle', () => {
    const result = loader()
    expect(result.current.isPending).toBe(false)
    expect(result.current.pendingKey).toBeUndefined()
  })

  it('hands on why the last load failed, against the model it was loading', () => {
    useJevLoadStore.setState({ loadError: { key: 'jev-key', message: 'vLLM is not installed.' } })
    expect(loader().current.loadError).toEqual({ key: 'jev-key', message: 'vLLM is not installed.' })
  })
})

// ADR-434 (i)(3): success is announced, never acted on. The toast offers the playground; only
// the user's click goes there. (i)(4): a load this browser did not start — a Routine's pinned
// swap, an API client's auto-swap — gets no toast at all, which is what `pendingJevKey` decides.
const READY: JevStatus = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  labels: ['contradiction', 'entailment', 'neutral'],
  state: 'running',
  slot: 'primary',
}

function statusWith(jev: JevStatus | null): Status {
  return { jev } as unknown as Status
}

function toastAction() {
  return (h.toastSuccess.mock.calls[0][1] as { action: { label: string; onClick: () => void } }).action
}

describe('useJevLoadedToast', () => {
  it('announces the model this browser asked for, once it is really running', () => {
    useJevLoadStore.setState({ pendingJevKey: 'jev-key' })
    h.status = statusWith(READY)

    renderHook(() => useJevLoadedToast())

    expect(h.toastSuccess).toHaveBeenCalledTimes(1)
    expect(h.toastSuccess.mock.calls[0][0]).toBe('qwen3.5 4b nli v2 is ready')
    expect(toastAction().label).toBe('Open Jev Playground')
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('does not fire again on the next status poll', () => {
    useJevLoadStore.setState({ pendingJevKey: 'jev-key' })
    h.status = statusWith(READY)

    const { rerender } = renderHook(() => useJevLoadedToast())
    h.status = statusWith({ ...READY })
    rerender()
    rerender()

    expect(h.toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('never navigates by itself — only the toast action does', () => {
    useJevLoadStore.setState({ pendingJevKey: 'jev-key' })
    h.status = statusWith(READY)

    renderHook(() => useJevLoadedToast())
    expect(h.navigate).not.toHaveBeenCalled()

    act(() => { toastAction().onClick() })

    expect(h.track).toHaveBeenCalledWith('models', 'open_jev_playground_toast')
    expect(h.navigate).toHaveBeenCalledWith('/workspace/jev')
  })

  it('stays quiet on the playground itself, but still stops waiting', () => {
    useJevLoadStore.setState({ pendingJevKey: 'jev-key' })
    h.status = statusWith(READY)
    h.pathname = '/workspace/jev'

    renderHook(() => useJevLoadedToast())

    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('says nothing for a Jev model this browser did not load', () => {
    useJevLoadStore.setState({ pendingJevKey: 'jev-key' })
    h.status = statusWith({ ...READY, key: 'someone-elses-key', name: 'other' })

    renderHook(() => useJevLoadedToast())

    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key')
  })

  it('waits for "running" — a starting engine is not ready', () => {
    useJevLoadStore.setState({ pendingJevKey: 'jev-key' })
    h.status = statusWith({ ...READY, state: 'starting' })

    renderHook(() => useJevLoadedToast())

    expect(h.toastSuccess).not.toHaveBeenCalled()
    expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key')
  })

  it('says nothing when this browser started no load at all', () => {
    h.status = statusWith(READY)

    renderHook(() => useJevLoadedToast())

    expect(h.toastSuccess).not.toHaveBeenCalled()
  })
})
