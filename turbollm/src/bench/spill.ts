// VRAM-spill detection for auto-tune's offload search — by DIRECT MEASUREMENT.
//
// WHY THIS EXISTS — absolute VRAM cannot detect spill. When a GPU driver falls back to host memory
// instead of failing an allocation (Windows WDDM does this for every vendor), the reported
// used-VRAM pins at the card's ceiling and stops responding to placement changes. Measured on an
// RTX 5070 Ti: nCpuMoe 0 / 3 / 9 all read 15823-15828 MiB while actually spilling 2914 / 2210 / 698
// MiB. `overHeadroom()` (bench.ts) reads all three as a clean fit, so the search walks straight
// into a config that silently runs from system RAM. That is the bug: the search had a FIT input and
// no SPILL input.
//
// WHY MEASURED RATHER THAN DERIVED — an earlier revision inferred spill by extrapolating a
// per-step residency slope from calibration probes. It worked on one model and produced six
// distinct defects across others: a degenerate endpoint corrupted the slope; a widened anchor gap
// was needed for noise; anchors on large models were THEMSELVES saturated, yielding a slope 40% of
// reality that under-reported a 4419 MiB spill as 358 MiB; and "disable on implausible slope" made
// large models worse still, because a wrong ruler beat no ruler. All of it was machinery for
// guessing a number the OS already knows exactly.
//
// Measured across six models spanning 9.4-60.5 GB on a 16.3 GB card (2026-08-07), the direct
// reading separates fitting from spilling by 16-39x with ZERO calibration:
//
//   model                     fits (MiB shared)   spills (MiB shared)
//   qwen3.6-27b   9.4 GB      177-181             never spilled
//   qwen3.6-35b  13.2 GB      159 (flat, 5 pts)   never spilled @32k
//   ornith 35b   21.2 GB      183-198             3199.5
//   qwen3.6-35b  31.8 GB      157-158             3647.5
//   laguna-s-2.1 39.7 GB      161                 6343.5
//
// The no-spill baseline is small but NOT constant (157-198 across models, and far higher on a box
// whose display shares the GPU), so callers measure it before the load and pass the delta here.
// That is one extra reading, not a calibration.
//
// SCOPE — spill BOUNDS the search; it does not pick the winner. A config can spill nothing and
// still fail at depth, because the prefill compute buffer is not allocated at load time and is
// therefore invisible to every load-time signal. The winner must still be confirmed by a real
// measured run.

/** How much host-backed GPU memory a load may add before it counts as spilling.
 *
 *  Founder call, 2026-08-07. A small amount is normal, not a spill: driver/staging overhead
 *  measured 157-198 MiB across every model tested, even ones with gigabytes of VRAM free. Real
 *  spill in the same matrix was 3199-6343 MiB. 512 clears the overhead with margin while sitting an
 *  order of magnitude below any true spill, so the threshold is not sensitive to where exactly it
 *  lands in that gap.
 *
 *  Deliberately the DEFAULT stopping point, not a hard limit: configs past it measured faster on
 *  some hardware, and the opt-in `VRAM_HEADROOM_SPILL_MB` hill-climb is the sanctioned way to
 *  explore there — by measuring, not by loosening this. */
export const SPILL_TOLERANCE_MB = 512

/** Host-backed GPU memory this model load added, in MB: the reading taken with the model loaded
 *  minus the one taken before it. Taking a delta is what makes this robust — any static desktop or
 *  compositor usage (which can be gigabytes on a box whose display shares the GPU) cancels out, so
 *  no adapter identification is needed and no per-machine baseline has to be assumed.
 *
 *  Floored at 0: a load that somehow frees shared memory is not "negative spill".
 *  Null when either reading is unavailable — callers must not treat that as "no spill". */
export function spillMb(baselineSharedMb: number | null, loadedSharedMb: number | null): number | null {
  if (baselineSharedMb === null || loadedSharedMb === null) return null
  return Math.max(0, loadedSharedMb - baselineSharedMb)
}

/** How close to its own capacity the GPU must be before host-backed memory is credible as SPILL.
 *
 *  Spill means the driver DEMOTED an allocation it could not fit — and WDDM only does that once
 *  dedicated memory is exhausted. So a load that puts memory on the host while the card still has
 *  gigabytes free did not spill; it pinned host memory ON PURPOSE, and no amount of extra CPU
 *  offload will ever remove it.
 *
 *  Measured 2026-08-15 on the same RTX 5070 Ti (16303 MiB), Qwen3.8-27B Q3_K_S @ ctx 71168:
 *  turning NextN on adds 416 MB of shared usage (178 -> 594) because llama.cpp builds a second
 *  MTP draft context whose host-side buffers are pinned into GPU-visible memory. That 594 clears
 *  {@link SPILL_TOLERANCE_MB} at EVERY offload — dead flat across ngl 0-32 while dedicated VRAM
 *  swung 2601-11877 MiB — so the search rejected all six probes and auto-tune finished with no
 *  winner at all ("No candidate completed successfully"). NextN is only the case that surfaced it;
 *  any engine or fork that pins host buffers lands in the same trap, which is why the guard is
 *  stated in terms of the physics rather than special-cased to speculative decoding.
 *
 *  1024 sits in a wide empty gap, so its exact value is not load-bearing: every real spill in the
 *  matrix above was read with used-VRAM pinned within 490 MB of the ceiling (that pinning IS the
 *  post-demotion behaviour this module documents), while the NextN floor sat 6322 MB below it. */
export const SPILL_PROXIMITY_MB = 1024

/** The decision the search makes: is this candidate's host-backed memory DISPLACED WEIGHTS (real
 *  spill — offload more) or a fixed cost of the configuration (leave the search alone)?
 *
 *  Two conditions, both required. The reading must clear {@link SPILL_TOLERANCE_MB}, and the card
 *  must actually be near enough to full for demotion to be the explanation — see
 *  {@link SPILL_PROXIMITY_MB}. Without the second condition a config-fixed pinned allocation is
 *  indistinguishable from spill, and because it is fixed, the search's only response (offload more)
 *  never reduces it — so every candidate is rejected and the sweep returns nothing.
 *
 *  Fails OPEN — an unavailable reading returns false rather than true, matching `overHeadroom`'s
 *  existing "unknown VRAM never blocks" contract (bench.ts). Claiming a spill we did not measure
 *  would drive a machine with no spill telemetry (Apple Metal, or a Windows install where the
 *  counter cannot be resolved) toward maximum CPU offload for no reason — a worse failure than not
 *  detecting spill at all. Those machines simply behave as they did before spill detection existed.
 *
 *  The corroboration itself fails CLOSED, the other way round: an unknown `vramAbsMb` or a zero
 *  `budgetMb` cannot rule a spill out, so the verdict falls back to the tolerance alone — exactly
 *  the behaviour that shipped before this check existed.
 *
 *  KNOWN LIMITATION (multi-GPU): both figures are summed across cards, so one saturated card
 *  spilling while another sits half-empty can read as "plenty of room" and have its spill
 *  discounted. A layer split balances residency across cards, which makes that lopsided case
 *  unlikely rather than impossible; closing it properly needs a per-adapter reading, which the
 *  WDDM counter can give (it is per-LUID) but `readGpuSharedMb` currently sums away.
 *
 *  @param vramAbsMb ABSOLUTE GPU VRAM in use for this candidate, MB (null when unreadable).
 *  @param budgetMb  The VRAM budget for this split — see `gpuBudgetMb`. 0 when there is no GPU. */
export function isSpilling(
  spill: number | null,
  vramAbsMb: number | null,
  budgetMb: number,
  floorMb: number | null = null,
): boolean {
  if (spill === null) return false
  if (spill - (floorMb ?? 0) <= SPILL_TOLERANCE_MB) return false
  if (vramAbsMb !== null && budgetMb > 0 && vramAbsMb < budgetMb - SPILL_PROXIMITY_MB) return false
  return true
}

/** Accumulate the sweep's measured FLOOR — the host-backed memory this configuration pins no matter
 *  where the offload knob sits — from probes the search is already doing. Free: no extra loads.
 *
 *  A probe only qualifies when its VRAM sits further than {@link SPILL_PROXIMITY_MB} below the
 *  budget. At that distance the card demonstrably had room, so whatever it put in host memory it
 *  put there ON PURPOSE — which makes that reading a direct measurement of the fixed cost, and the
 *  smallest such reading the tightest bound on it.
 *
 *  WHY THIS IS NEEDED ON TOP OF THE PROXIMITY RULE. Proximity alone protects a candidate only while
 *  it is far from the ceiling; the config the search actually WANTS is the one packed right up
 *  against it, where proximity necessarily stops discriminating. Measured live 2026-08-15, the run
 *  that proved the proximity rule works: the sweep found ngl=55 (15282 MiB of 16303 — inside the
 *  proximity window by 3 MB), read the same ~594 MB NextN floor as 552, called it spill, and backed
 *  off to ngl=54 — which benched **4.31 t/s against 55's 5.74**. Auto-tune completed and then
 *  handed back a config 25% slower than the one it had already measured. Subtracting the floor
 *  (594, from the probes at 9672/13682/14626 MiB) leaves 0 and the backoff never fires.
 *
 *  Null floor ⇒ no qualifying probe ran (CPU-only box, unreadable counter, or every probe sat near
 *  the ceiling) ⇒ {@link isSpilling} subtracts nothing and behaves exactly as it does without this. */
export function spillFloor(
  floorMb: number | null,
  spill: number | null,
  vramAbsMb: number | null,
  budgetMb: number,
): number | null {
  if (spill === null || vramAbsMb === null || budgetMb <= 0) return floorMb
  if (vramAbsMb >= budgetMb - SPILL_PROXIMITY_MB) return floorMb // too close to the ceiling to prove anything
  return floorMb === null ? spill : Math.min(floorMb, spill)
}
