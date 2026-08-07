// Vendor-neutral VRAM-spill detection for auto-tune's offload search.
//
// WHY THIS EXISTS — absolute VRAM cannot detect spill. When a GPU driver falls back
// to host memory instead of failing an allocation (Windows WDDM does this for every
// vendor; see spill.test.ts for the measurements), the reported used-VRAM pins at the
// card's ceiling and stops responding to placement changes entirely. Measured on an
// RTX 5070 Ti: nCpuMoe 0 / 3 / 9 all read 15823-15828 MiB — a 5 MiB spread — while
// actually spilling 2914 / 2210 / 698 MiB. `overHeadroom()` (bench.ts) asks only
// "is used-VRAM under budget-minus-headroom", so it reads all three as a clean fit
// and the binary search walks straight into a config that silently runs from system
// RAM. That is the entire bug: the search has a FIT input and no SPILL input.
//
// THE SIGNAL — in the unsaturated region, GPU residency is linear in the offload knob.
// So a run can derive its own MiB-per-step slope from its own probes, predict what the
// next candidate SHOULD occupy, and treat any shortfall as spill. Validated against
// Windows' own per-adapter shared-memory counter: the derived shortfall agreed to
// within 0.3 MiB at the spill boundary and stayed within 5% deep into saturation.
//
// WHY DERIVED RATHER THAN READ FROM THE OS — the shared-memory counter that revealed
// this effect is Windows-only. This method needs only *per-adapter used VRAM*, which
// nvidia-smi / rocm-smi / xpu-smi all report, so one implementation covers every
// vendor and OS instead of a per-platform patchwork. It is also self-calibrating: no
// per-model constant, and no dependence on estimateVram() being accurate.
//
// SCOPE — this bounds the search; it does not pick the winner. A config can spill
// nothing and still fail at depth, because the prefill compute buffer is not allocated
// at load time and therefore is invisible to every load-time signal (measured:
// nCpuMoe=12 spills nothing, has more free VRAM than nCpuMoe=3, and still crashes at
// depth while nCpuMoe=3 runs fine). The winner must still be confirmed by a real
// measured run.

/** One probe observation: the offload knob (nCpuMoe or ngl) and the measured
 *  per-adapter VRAM in MiB. `vramMb` is null when the reading was unavailable —
 *  a non-NVIDIA/AMD box, a failed CLI call — and such samples are ignored rather
 *  than treated as zero. */
export interface ResidencySample {
  knob: number
  vramMb: number | null
}

/** Shortfall below which a candidate is NOT called spilling (founder call, 2026-08-07).
 *
 *  A small amount of host-backed memory is normal, not a spill: the OS reported a constant
 *  285.3 MiB of "shared" GPU memory on this adapter even for configs with gigabytes of VRAM
 *  free, i.e. driver/staging overhead rather than model weights displaced to system RAM.
 *  512 clears that baseline with margin.
 *
 *  This is deliberately ONE HALF of the rule. On its own a 512 MiB allowance would wave through
 *  configs that are technically-not-spilling but have no room left for the deep-prefill compute
 *  buffer (measured: nCpuMoe=12 spills nothing, has 566 MiB free, and still crashes at depth).
 *  The other half — requiring free VRAM above headroom + this allowance — lives in
 *  `probeVerdict` (bench.ts). Neither check is sufficient alone. */
export const SPILL_TOLERANCE_MB = 512

/** MiB of GPU residency gained per ONE-unit DECREASE of the knob (for nCpuMoe: moving
 *  one more expert onto the GPU; for ngl the caller passes the negated knob so the
 *  same "lower knob = more resident" convention holds).
 *
 *  Uses the MAXIMUM slope between adjacent samples rather than a least-squares fit, and
 *  that choice is load-bearing: samples taken inside the saturated region have a
 *  near-zero slope (measured 6.5 MiB across a step whose true cost was 262 MiB), so
 *  averaging them in would drag the estimate down, under-predict residency, and mask
 *  the very spill this exists to find. The true unsaturated slope is the largest one
 *  present. Returns null when it cannot be derived — fewer than two readable samples,
 *  or no two samples at different knob values. */
export function residencySlope(samples: ResidencySample[]): number | null {
  const usable = samples
    .filter((s): s is { knob: number; vramMb: number } => typeof s.vramMb === 'number')
    .sort((a, b) => b.knob - a.knob)
  if (usable.length < 2) return null

  let best: number | null = null
  for (let i = 0; i < usable.length - 1; i++) {
    const hi = usable[i]
    const lo = usable[i + 1]
    const dKnob = hi.knob - lo.knob
    if (dKnob <= 0) continue // same knob probed twice — no gradient to read
    const slope = (lo.vramMb - hi.vramMb) / dKnob
    if (best === null || slope > best) best = slope
  }
  return best
}

/** Residency this candidate SHOULD occupy if nothing spills, extrapolated from a
 *  reference sample along `slope`. The reference should come from the low-residency
 *  end of the search (the samples least likely to be saturated). */
export function predictResidencyMb(
  ref: { knob: number; vramMb: number },
  slope: number,
  knob: number,
): number {
  return ref.vramMb + slope * (ref.knob - knob)
}

/** How much of the predicted residency did NOT land in VRAM — i.e. the amount the
 *  driver placed in host memory. Floored at 0: a candidate using less than predicted
 *  is not "negative spill", just a slightly conservative prediction. */
export function spillMb(predictedMb: number, actualMb: number): number {
  return Math.max(0, predictedMb - actualMb)
}

/** The decision the search makes. Fails OPEN — an unknown prediction or an unreadable
 *  VRAM value returns false rather than true, matching `overHeadroom`'s existing
 *  "unknown VRAM never blocks" contract (bench.ts). Claiming a spill we did not measure
 *  would silently drive a box with no VRAM telemetry toward maximum CPU offload, which
 *  is a worse failure than not detecting spill at all. */
export function isSpilling(predictedMb: number | null, actualMb: number | null): boolean {
  if (predictedMb === null || actualMb === null) return false
  return spillMb(predictedMb, actualMb) > SPILL_TOLERANCE_MB
}
