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

/** The decision the search makes. Fails OPEN — an unavailable reading returns false rather than
 *  true, matching `overHeadroom`'s existing "unknown VRAM never blocks" contract (bench.ts).
 *  Claiming a spill we did not measure would drive a machine with no spill telemetry (Apple Metal,
 *  or a Windows install where the counter cannot be resolved) toward maximum CPU offload for no
 *  reason — a worse failure than not detecting spill at all. Those machines simply behave as they
 *  did before spill detection existed. */
export function isSpilling(spill: number | null): boolean {
  if (spill === null) return false
  return spill > SPILL_TOLERANCE_MB
}
