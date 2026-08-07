import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceSidebarOpen } from './workspace-sidebar'

describe('useWorkspaceSidebarOpen', () => {
  beforeEach(() => { sessionStorage.clear() })

  it('defaults to expanded (open) when nothing has been remembered yet', () => {
    const { result } = renderHook(() => useWorkspaceSidebarOpen())
    expect(result.current[0]).toBe(true)
  })

  it('setSidebarOpen(false) collapses it and persists the change', () => {
    const { result } = renderHook(() => useWorkspaceSidebarOpen())
    act(() => { result.current[1](false) })
    expect(result.current[0]).toBe(false)
    expect(sessionStorage.getItem('tllm.workspace.sidebarOpen')).toBe('0')
  })

  it('supports a functional updater, same as plain useState', () => {
    const { result } = renderHook(() => useWorkspaceSidebarOpen())
    act(() => { result.current[1]((prev) => !prev) })
    expect(result.current[0]).toBe(false)
    act(() => { result.current[1]((prev) => !prev) })
    expect(result.current[0]).toBe(true)
  })

  it('a fresh mount (simulating switching to a different Workspace screen) picks up the collapsed state left by a previous mount', () => {
    const first = renderHook(() => useWorkspaceSidebarOpen())
    act(() => { first.result.current[1](false) })
    first.unmount()

    // A different screen (e.g. navigating from Code to Chat) mounts its own call to the hook —
    // this is the actual founder-reported flow: collapse in one screen, it should still read
    // collapsed after switching to another.
    const second = renderHook(() => useWorkspaceSidebarOpen())
    expect(second.result.current[0]).toBe(false)
  })

  it('reads a stored expanded value back correctly, not just the collapsed one', () => {
    sessionStorage.setItem('tllm.workspace.sidebarOpen', '1')
    const { result } = renderHook(() => useWorkspaceSidebarOpen())
    expect(result.current[0]).toBe(true)
  })
})
