import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAndroidOs, useCodeFeatureEnabled } from './platform'

// The hook's whole job is turning one async query into a three-state answer, so the query
// itself is the thing to fake — mocking it keeps this a test of the DECISION (including the
// pre-load window, which a real fetch would race past) rather than of react-query.
const sysInfo = vi.fn()
vi.mock('./queries', () => ({ useSysInfo: () => sysInfo() }))

describe('isAndroidOs', () => {
  it('matches the Android app / Termux platform pair (ADR-390)', () => {
    expect(isAndroidOs('android/arm64')).toBe(true)
    expect(isAndroidOs('android/x64')).toBe(true)
  })

  it('does not match any desktop platform', () => {
    expect(isAndroidOs('win32/x64')).toBe(false)
    expect(isAndroidOs('linux/x64')).toBe(false)
    expect(isAndroidOs('linux/arm64')).toBe(false)
    expect(isAndroidOs('darwin/arm64')).toBe(false)
  })
})

describe('useCodeFeatureEnabled', () => {
  beforeEach(() => sysInfo.mockReset())

  it('is undefined — not a guess — while sysinfo is still in flight', () => {
    sysInfo.mockReturnValue({ data: undefined, isError: false })
    expect(renderHook(() => useCodeFeatureEnabled()).result.current).toBeUndefined()
  })

  it('is false on Android', () => {
    sysInfo.mockReturnValue({ data: { os: 'android/arm64' }, isError: false })
    expect(renderHook(() => useCodeFeatureEnabled()).result.current).toBe(false)
  })

  it('is true on every desktop platform', () => {
    for (const os of ['win32/x64', 'linux/x64', 'darwin/arm64']) {
      sysInfo.mockReturnValue({ data: { os }, isError: false })
      expect(renderHook(() => useCodeFeatureEnabled()).result.current).toBe(true)
    }
  })

  it('fails OPEN when sysinfo errors, rather than hiding Code on an unidentifiable machine', () => {
    sysInfo.mockReturnValue({ data: undefined, isError: true })
    expect(renderHook(() => useCodeFeatureEnabled()).result.current).toBe(true)
  })
})
