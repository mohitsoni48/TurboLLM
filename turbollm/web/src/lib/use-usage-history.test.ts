import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useUsageHistory } from './use-usage-history'
import type { HwUsage } from '../lib/types'

const sample = (sampledAt: number, cpuPct: number | null = 50): HwUsage => ({
  cpuPct,
  ram: { usedMb: 8000, totalMb: 32000 },
  gpus: [],
  sampledAt,
})

describe('useUsageHistory', () => {
  it('starts empty for undefined and grows with distinct sampledAt values', () => {
    const { result, rerender } = renderHook(({ u }: { u: HwUsage | undefined }) => useUsageHistory(u), {
      initialProps: { u: undefined as HwUsage | undefined },
    })
    expect(result.current).toEqual([])

    rerender({ u: sample(1000) })
    expect(result.current.map((s) => s.sampledAt)).toEqual([1000])

    rerender({ u: sample(2000, 60) })
    expect(result.current.map((s) => s.sampledAt)).toEqual([1000, 2000])
    expect(result.current[result.current.length - 1].cpuPct).toBe(60)
  })

  it('does NOT double-append a repeated poll of an unchanged sample', () => {
    const { result, rerender } = renderHook(({ u }: { u: HwUsage | undefined }) => useUsageHistory(u), {
      initialProps: { u: sample(1000) },
    })
    // Same sample delivered again (a poll that returned the cached sample): no growth.
    rerender({ u: sample(1000) })
    expect(result.current).toHaveLength(1)
    // And a genuinely newer sample still appends.
    rerender({ u: sample(2000) })
    expect(result.current).toHaveLength(2)
  })

  it('caps the buffer at `size`, keeping the NEWEST samples', () => {
    const { result, rerender } = renderHook(
      ({ u }: { u: HwUsage | undefined }) => useUsageHistory(u, 3),
      { initialProps: { u: undefined as HwUsage | undefined } },
    )
    for (let t = 1000; t <= 5000; t += 1000) rerender({ u: sample(t) })
    // 6 distinct samples through a size-3 buffer: only the last three survive.
    expect(result.current.map((s) => s.sampledAt)).toEqual([3000, 4000, 5000])
  })

  it('drops a stale (out-of-order) sample rather than corrupting the timeline', () => {
    const { result, rerender } = renderHook(({ u }: { u: HwUsage | undefined }) => useUsageHistory(u), {
      initialProps: { u: sample(3000) },
    })
    // A late-arriving older sample must not be appended after a newer one.
    rerender({ u: sample(1000) })
    expect(result.current.map((s) => s.sampledAt)).toEqual([3000])
  })
})
