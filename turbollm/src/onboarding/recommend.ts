/** Profile × hardware → one blessed entry (spec 25 §5.2).
 *
 *  Pure by design: no I/O, no clock, no filesystem. The caller supplies
 *  `HardwareFacts` derived from `getSysInfo()`/`estimateVram()`, which keeps
 *  every tier — including hardware nobody owns — unit-testable with no mocks. */

import { BLESSED, type BlessedEntry } from './models'
import { roleFor } from './profiles'
import type { ProfileId } from './state'

export interface HardwareFacts {
  usableVramMb: number
  systemRamMb: number
  unifiedMemory: boolean
}

export type Recommendation =
  | { kind: 'entry'; entry: BlessedEntry; speculative: 'off' }
  | { kind: 'discover'; reason: 'pro' }
  | { kind: 'hf-search'; reason: 'no-fit' }

function fits(e: BlessedEntry, hw: HardwareFacts): boolean {
  if (e.minVramMb !== null && hw.usableVramMb < e.minVramMb) return false
  if (e.maxVramMb !== null && hw.usableVramMb >= e.maxVramMb) return false
  // The RAM guard. C-LOW-B depends on expert offload into system RAM; without
  // it the recommendation OOMs on exactly the hardware it was chosen for.
  if (e.minSystemRamMb !== null && hw.systemRamMb < e.minSystemRamMb) return false
  return true
}

export function recommend(profile: ProfileId, hw: HardwareFacts): Recommendation {
  const role = roleFor(profile)
  // Pro resolves nothing, on any hardware — it picks its own model and quant
  // in Discover. Checked before anything else so no tier can leak an entry.
  if (role === null) return { kind: 'discover', reason: 'pro' }

  const candidates = BLESSED.filter((e) => e.role === role && fits(e, hw))
  if (candidates.length === 0) return { kind: 'hf-search', reason: 'no-fit' }

  // Largest that fits. Enthusiast then takes one step up where a larger
  // sibling of the same role exists — that is how "see what my machine can
  // run" is honoured without a second model.
  const sorted = [...candidates].sort((a, b) => a.bytes - b.bytes)
  let picked = sorted[sorted.length - 1]

  if (profile === 'enthusiast') {
    const bigger = BLESSED
      .filter((e) => e.role === role && e.bytes > picked.bytes)
      .sort((a, b) => a.bytes - b.bytes)[0]
    if (bigger) picked = bigger
  }

  return { kind: 'entry', entry: picked, speculative: 'off' }
}
