// The two pieces of Jev-load state that outlive the component that started the load
// (ADR-434 (i)(3)): the pending confirmation, and the key of a load this browser fired.
//
// They live in a store rather than in the screen because ModelDetailDialog closes itself the
// moment it fires a load — a confirmation owned by that dialog would unmount before the user
// ever saw it.
import { beforeEach, describe, expect, it } from 'vitest'
import { useJevLoadStore } from './jev-load'
import type { ActiveWork } from '../lib/types'

const TARGET = {
  key: 'jev-key',
  name: 'qwen3.5 4b nli v2',
  jev: { labels: [], nliTemplate: null, architecture: 'Qwen3_5ForSequenceClassification', verified: true },
}

const BUSY: ActiveWork = { items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false }

beforeEach(() => {
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null, pendingLoadKey: null, loadError: null })
})

describe('useJevLoadStore', () => {
  it('starts with nothing to confirm and no load of its own in flight', () => {
    expect(useJevLoadStore.getState().confirm).toBeNull()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  // The whole options object, not just the overrides: answering the question must not drop the
  // callbacks the surface that asked for the load is waiting on (ADR-434 (i)(3)).
  it('holds the target, the work it would interrupt and everything the caller asked for', () => {
    const onSuccess = () => {}
    useJevLoadStore.getState().setConfirm({ target: TARGET, work: BUSY, opts: { overrides: { ctx: 4096 }, onSuccess } })
    const { confirm } = useJevLoadStore.getState()
    expect(confirm?.target).toEqual(TARGET)
    expect(confirm?.work).toEqual(BUSY)
    expect(confirm?.opts).toEqual({ overrides: { ctx: 4096 }, onSuccess })
  })

  it('holds a null work — the probe could not be read, which is not "nothing is running"', () => {
    useJevLoadStore.getState().setConfirm({ target: TARGET, work: null, opts: {} })
    expect(useJevLoadStore.getState().confirm?.work).toBeNull()
  })

  it('clears the confirmation', () => {
    useJevLoadStore.getState().setConfirm({ target: TARGET, work: BUSY, opts: {} })
    useJevLoadStore.getState().setConfirm(null)
    expect(useJevLoadStore.getState().confirm).toBeNull()
  })

  it('remembers and clears the key of a Jev load this browser fired', () => {
    useJevLoadStore.getState().setPendingJevKey('jev-key')
    expect(useJevLoadStore.getState().pendingJevKey).toBe('jev-key')
    useJevLoadStore.getState().setPendingJevKey(null)
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('is not persisted — a reload must not resurrect a dialog or a stale toast', () => {
    expect('persist' in useJevLoadStore).toBe(false)
  })
})

describe('the load every surface reads', () => {
  const store = () => useJevLoadStore.getState()

  it('names the load that is running, and lets go when that same load settles', () => {
    store().loadStarted('model-a')
    expect(store().pendingLoadKey).toBe('model-a')

    store().loadSettled('model-a')

    expect(store().pendingLoadKey).toBeNull()
  })

  // The daemon loads one model at a time (ADR-285), so a second load while one is running is
  // refused and settles at once. The load that is really running keeps the key.
  it('keeps the running load when a second one is started and refused', () => {
    store().loadStarted('model-a')
    store().loadStarted('model-b')
    store().loadFailed('model-b', 'Another model is loading.')
    store().loadSettled('model-b')

    expect(store().pendingLoadKey).toBe('model-a')
  })

  it('gives back the "is ready" claim of the load that failed', () => {
    store().setPendingJevKey('jev-key')

    store().loadFailed('jev-key', 'Out of VRAM')

    expect(store().pendingJevKey).toBeNull()
    expect(store().loadError).toEqual({ key: 'jev-key', message: 'Out of VRAM' })
  })

  it('keeps a claim that another model\'s failure has nothing to do with', () => {
    store().setPendingJevKey('jev-key')

    store().loadFailed('chat-key', 'Out of VRAM')

    expect(store().pendingJevKey).toBe('jev-key')
  })
})
