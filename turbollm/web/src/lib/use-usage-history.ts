// Client-side history for the hardware gauges' sparklines (ADR-383, plan task 7).
//
// The daemon deliberately keeps NO history (spec: daemon-side history is a known gap), so the
// ~60 s sparkline window is built here, from the polled samples: a ring buffer of at most
// `size` samples, keyed on `sampledAt`.
//
// The keying matters in two directions. The hwstats query re-delivers the CACHED sample while
// the 1 s sampler has not ticked yet — without the key, every poll would append a duplicate
// and the sparkline would flat-line on stale values. And a slow late response that arrives
// AFTER a newer sample must be dropped, not appended: the sparkline is a timeline, and an
// out-of-order point would bend it backwards.
import { useEffect, useState } from 'react'
import type { HwUsage } from './types'

/** The last `size` of the polled samples, oldest → newest. Returns `[]` until the first
 *  sample lands, which the gauges render as an empty sparkline (not a fabricated flat line). */
export function useUsageHistory(u: HwUsage | undefined, size = 30): HwUsage[] {
  const [history, setHistory] = useState<HwUsage[]>([])

  // React to the sample's IDENTITY, not its object address: the query may hand us a fresh
  // object each poll for the same sample, and rerunning on every render would thrash state.
  const sampledAt = u?.sampledAt
  useEffect(() => {
    if (u === undefined) return
    const sample = u
    setHistory((h) => {
      const last = h[h.length - 1]?.sampledAt
      if (last !== undefined && sample.sampledAt <= last) return h // duplicate or stale
      const next = [...h, sample]
      return next.length > size ? next.slice(next.length - size) : next
    })
  }, [sampledAt, u, size])

  return history
}
