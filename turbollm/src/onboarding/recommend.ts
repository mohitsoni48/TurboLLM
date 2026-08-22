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

/** The joint-pool constraint (GitHub #164). ONE PHYSICAL POOL MUST BE SPENT ONCE.
 *
 *  `usableVramMb` and `systemRamMb` are two independent budgets on a box with a discrete card —
 *  which is why `fits()` may check an entry's VRAM floor and its RAM floor separately. On a
 *  unified-memory box they are not: the GPU budget IS a slice of the same system RAM (an iGPU-only
 *  laptop gets 50% of RAM by ADR-189's shared-memory heuristic; an AMD APU gets its GTT pool per
 *  ADR-304/306; Apple Silicon has literally one pool). Checking the two floors separately there
 *  spends the same physical bytes twice, and the check PASSES on hardware that cannot hold the
 *  model — an iGPU-only box was handed a plan whose GPU-resident and CPU-resident halves summed to
 *  more memory than the machine has, and got a GREENER verdict than a real 16 GB card would.
 *
 *  The fix is additive and narrow, per the ADRs: the unified budget is NOT deleted (that would
 *  revert ADR-189 and re-open GitHub #85's under-reported APU budget). We only additionally
 *  require that an entry's two floors fit in the single pool they actually share. No-op whenever
 *  `unifiedMemory` is false, so no discrete-GPU box changes behaviour. */
function jointMemoryOk(e: BlessedEntry, hw: HardwareFacts): boolean {
  if (!hw.unifiedMemory) return true
  return (e.minVramMb ?? 0) + (e.minSystemRamMb ?? 0) <= hw.systemRamMb
}

function fits(e: BlessedEntry, hw: HardwareFacts): boolean {
  if (e.minVramMb !== null && hw.usableVramMb < e.minVramMb) return false
  if (e.maxVramMb !== null && hw.usableVramMb >= e.maxVramMb) return false
  // The RAM guard. C-LOW-B depends on expert offload into system RAM; without
  // it the recommendation OOMs on exactly the hardware it was chosen for.
  if (e.minSystemRamMb !== null && hw.systemRamMb < e.minSystemRamMb) return false
  if (!jointMemoryOk(e, hw)) return false
  return true
}

export function recommend(profile: ProfileId, hw: HardwareFacts): Recommendation {
  const role = roleFor(profile)
  // Pro resolves nothing, on any hardware — it picks its own model and quant
  // in Discover. Checked before anything else so no tier can leak an entry.
  if (role === null) return { kind: 'discover', reason: 'pro' }

  let candidates = BLESSED.filter((e) => e.role === role && fits(e, hw))

  // Pass 2 — the RAM-guard fallback. Spec 25 §5.4: "If detected RAM is lower, resolve to
  // C-LOW-A", and §7: "a 16 GB card with 16 GB system RAM must resolve to C-LOW-A, never
  // C-LOW-B". Pass 1 cannot deliver that on its own: the bands are non-overlapping, so once
  // C-LOW-B is rejected on RAM there is nothing left in the card's band and the caller fell
  // through to HF search. That hit 12 GB and 14 GB cards with 16 GB of system RAM — a 3060 12GB
  // or 4070 12GB with 16 GB RAM, an extremely common build — handing them the "you're on your
  // own" experience this feature exists to remove.
  //
  // So: drop only the UPPER band edge and re-match. `minVramMb` still applies, so a card too
  // small for an entry never receives it; `minSystemRamMb` still applies, so this cannot
  // re-admit the very entry the RAM guard just rejected. The effect is to degrade to the
  // largest smaller sibling of the same role, which is exactly what the spec asks for.
  //
  // `jointMemoryOk` is re-applied here for the same reason `minSystemRamMb` is: without it this
  // pass would re-admit verbatim the entry the joint-pool constraint just rejected. That is not
  // hypothetical — on a unified box with ~32 GB of RAM (so a ~16 GB shared GPU budget), C-LOW-B
  // is the only band match, pass 1 rejects it at 12 GB VRAM + 32 GB RAM = 45 GB of demand against
  // a 32 GB pool, every other band then misses, and pass 2 would hand back the exact plan that
  // does not fit. GitHub #164.
  if (candidates.length === 0) {
    candidates = BLESSED.filter(
      (e) =>
        e.role === role &&
        (e.minVramMb === null || hw.usableVramMb >= e.minVramMb) &&
        (e.minSystemRamMb === null || hw.systemRamMb >= e.minSystemRamMb) &&
        jointMemoryOk(e, hw),
    )
  }

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
