import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { AppUpdate } from '../lib/types'

// useAppUpdateState decides whether the rail pill and the Settings block show at all. Its
// queries are mocked at the module level: the test states what the daemon reported.
const state = vi.hoisted(() => ({
  update: undefined as AppUpdate | undefined,
  os: 'linux/x64',
}))

vi.mock('../lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queries')>()
  return {
    ...actual,
    useAppUpdate: () => ({ data: state.update }),
    useStatus: () => ({ data: undefined }),
    useSysInfo: () => ({ data: { os: state.os } }),
  }
})

import { useAppUpdateState } from './AppUpdateControl'

const update = (over: Partial<AppUpdate>): AppUpdate => ({
  installed: '1.0.0',
  latest: '1.1.0',
  hasUpdate: true,
  checkedAt: '2026-10-17T00:00:00.000Z',
  comparable: true,
  ...over,
})

const visible = () => renderHook(() => useAppUpdateState()).result.current.visible

describe('useAppUpdateState', () => {
  // Termux's Node reports android ("android/arm64") as the packaged app's does, and the update
  // was hidden on every android: Termux users never saw the update their npm install can apply.
  it('shows the update on Termux (an npm install on android), not in the packaged Android app', () => {
    state.os = 'android/arm64'
    state.update = update({ method: 'npm_global', canSelfUpdate: true, command: 'npm i -g turbollm@latest' })
    expect(visible()).toBe(true)

    state.update = update({ method: 'android', canSelfUpdate: false, command: '' })
    expect(visible()).toBe(false)
  })

  it('shows nothing when there is nothing newer', () => {
    state.os = 'linux/x64'
    state.update = update({ hasUpdate: false, method: 'npm_global' })
    expect(visible()).toBe(false)
  })
})
