// Turbo Link (ADR-376/382): which machine this install is pointed at.
//
// Two founder-reported bugs are pinned here, and they are different bugs:
//
//  1. The pick must OUTLIVE the chat screen. It was ChatScreen `useState`, and every screen is
//     lazily routed — navigating away unmounted it, so coming back showed the local model as if
//     nothing had been chosen. The store is precisely the thing that does not unmount.
//  2. The pick must reach surfaces that are NOT this browser. `turbollm launch pi` auto-loaded a
//     local model — and spent 180 s failing to — while the UI showed a linked machine selected,
//     because the selection lived only in browser state. It is daemon state now, so a write that
//     never reaches the daemon is the whole failure, not a detail.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setSelectedRemoteModel = vi.fn<(id: string | null) => Promise<unknown>>()
vi.mock('../lib/link-api', () => ({ setSelectedRemoteModel: (id: string | null) => setSelectedRemoteModel(id) }))
const toastError = vi.fn()
vi.mock('../components/ui/sonner', () => ({ toast: { error: (m: string) => toastError(m) } }))

const { useUiStore } = await import('./ui')

describe('ui store: remote model selection', () => {
  beforeEach(() => {
    localStorage.clear()
    setSelectedRemoteModel.mockReset()
    setSelectedRemoteModel.mockResolvedValue({ ok: true })
    toastError.mockReset()
    useUiStore.setState({ remoteModelId: null })
  })

  it('survives a screen unmount — the value lives in the store, not the screen', () => {
    useUiStore.getState().setRemoteModelId('rig/Qwen3-35B')
    expect(useUiStore.getState().remoteModelId).toBe('rig/Qwen3-35B')
  })

  it('persists the pick to the DAEMON, not just this tab', () => {
    useUiStore.getState().setRemoteModelId('rig/Qwen3-35B')
    // This is what `turbollm launch <cli>` reads. Without it the CLI auto-loads a local model.
    expect(setSelectedRemoteModel).toHaveBeenCalledWith('rig/Qwen3-35B')
  })

  it('caches to localStorage so the picker is not blank on first paint', () => {
    useUiStore.getState().setRemoteModelId('rig/Qwen3-35B')
    expect(localStorage.getItem('tllm.remoteModelId')).toBe('rig/Qwen3-35B')
  })

  it('clears both the daemon and the cache when the user goes back to a local model', () => {
    useUiStore.getState().setRemoteModelId('rig/Qwen3-35B')
    useUiStore.getState().setRemoteModelId(null)
    expect(useUiStore.getState().remoteModelId).toBeNull()
    expect(setSelectedRemoteModel).toHaveBeenLastCalledWith(null)
    // Removed, not stored as the string "null" — which would read back as a model id named
    // `null` and resolve to nothing forever.
    expect(localStorage.getItem('tllm.remoteModelId')).toBeNull()
  })

  it('reverts and explains when the daemon refuses the pick', async () => {
    setSelectedRemoteModel.mockRejectedValue(new Error("'rig' is not connected (unreachable)."))
    useUiStore.getState().setRemoteModelId('rig/Qwen3-35B')
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled())
    // A refused pick left showing as selected would 503 on every later turn.
    expect(useUiStore.getState().remoteModelId).toBeNull()
    expect(localStorage.getItem('tllm.remoteModelId')).toBeNull()
  })

  it('adopts the daemon value on a status poll (a pick made on another device)', () => {
    useUiStore.getState().syncRemoteModelId('rig/Qwen3-35B')
    expect(useUiStore.getState().remoteModelId).toBe('rig/Qwen3-35B')
    // Sync is not a user action — it must not write back, or two tabs would ping-pong.
    expect(setSelectedRemoteModel).not.toHaveBeenCalled()
  })

  it('a status poll racing a fresh pick does NOT snap the picker back', async () => {
    let release: (v: unknown) => void = () => {}
    setSelectedRemoteModel.mockReturnValue(new Promise((r) => { release = r }))
    useUiStore.getState().setRemoteModelId('rig/Qwen3-35B')
    // The daemon hasn't seen the new pick yet, so its poll still reports the old value.
    useUiStore.getState().syncRemoteModelId(null)
    expect(useUiStore.getState().remoteModelId).toBe('rig/Qwen3-35B')
    release({ ok: true })
  })
})
