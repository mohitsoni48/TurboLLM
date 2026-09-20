// The two pieces of Jev-load state that outlive the component that started the load
// (ADR-434 (i)(3)): the pending confirmation, and the key of a load this browser fired.
//
// They live in a store rather than in the screen because ModelDetailDialog closes itself the
// moment it fires a load — a confirmation owned by that dialog would unmount before the user
// ever saw it.
import { beforeEach, describe, expect, it } from 'vitest'
import { useJevLoadStore } from './jev-load'
import type { ActiveWork } from '../lib/types'

const TARGET = { key: 'jev-key', name: 'qwen3.5 4b nli v2', isJev: true }

const BUSY: ActiveWork = { items: [{ kind: 'chat', id: 'c1', label: 'Kitchen test' }], engineGenerating: false }

beforeEach(() => {
  useJevLoadStore.setState({ confirm: null, pendingJevKey: null })
})

describe('useJevLoadStore', () => {
  it('starts with nothing to confirm and no load of its own in flight', () => {
    expect(useJevLoadStore.getState().confirm).toBeNull()
    expect(useJevLoadStore.getState().pendingJevKey).toBeNull()
  })

  it('holds the target, the work it would interrupt and the load overrides', () => {
    useJevLoadStore.getState().setConfirm({ target: TARGET, work: BUSY, overrides: { ctx: 4096 } })
    const { confirm } = useJevLoadStore.getState()
    expect(confirm?.target).toEqual(TARGET)
    expect(confirm?.work).toEqual(BUSY)
    expect(confirm?.overrides).toEqual({ ctx: 4096 })
  })

  it('holds a null work — the probe could not be read, which is not "nothing is running"', () => {
    useJevLoadStore.getState().setConfirm({ target: TARGET, work: null })
    expect(useJevLoadStore.getState().confirm?.work).toBeNull()
  })

  it('clears the confirmation', () => {
    useJevLoadStore.getState().setConfirm({ target: TARGET, work: BUSY })
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
