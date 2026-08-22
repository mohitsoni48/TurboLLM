// GitHub #179 — the dense offload search on a unified-memory (APU) box.
//
// The unit-level physics is pinned in spill.test.ts; what this file pins is that the composed
// decision — probeVerdict, driving the SAME binary search denseSearch runs — actually converges to
// a benchable ngl instead of exhausting the range with `bestNgl = null` ("No candidate completed
// successfully", which is what the reporter saw).
//
// New file rather than an addition to bench.test.ts so the #179 change stays reviewable on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeVerdict } from './bench'

// The reporter's readings. `vramAbsMb` is null at every probe because readGpuVramMb only has
// nvidia-smi and rocm-smi backends and rocm-smi is not on Windows — so the APU box has no absolute
// VRAM reading at all, which is what disabled the proximity escape AND the floor accumulator
// together. Spill is large and non-monotonic because on a UMA part it is simply "where the weights
// are", not a measure of displacement.
const APU_BUDGET = 66123
const HEADROOM_MB = 1024
const APU_PROBES: Record<number, number> = { 24: 6235, 11: 3770, 5: 2736, 2: 2138, 0: 11035 }

/** Host-backed GPU memory at `ngl`. The five MEASURED points are used verbatim; anything else is a
 *  linear model through them (~2138 MB at ngl=2 rising ~186 MB per layer, the slope the reporter's
 *  own 2→24 span implies). Extrapolating is unavoidable and harmless here: the pre-fix search never
 *  reached those ngl values to measure them, and every value the model produces is far above
 *  SPILL_TOLERANCE_MB either way — which is exactly the point, since the fix does not depend on the
 *  magnitude at all, only on the memory topology. */
function spillAt(ngl: number): number {
  return APU_PROBES[ngl] ?? Math.round(2138 + 186.2 * (ngl - 2))
}

/** Replays denseSearch's binary search over ngl ∈ [0, blockCount] using the REAL probeVerdict for
 *  every decision — the same loop shape as bench.ts (`fits` ⇒ record and search UP). */
function runNglSearch(blockCount: number, unified: boolean): { best: number | null; probed: number[] } {
  let lo = 0, hi = blockCount, best: number | null = null
  const probed: number[] = []
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const spill = spillAt(mid)
    probed.push(mid)
    const v = probeVerdict({ outcome: 'ok', vramAbsMb: null, spillMb: spill }, APU_BUDGET, HEADROOM_MB, null, false, unified)
    if (v.decision === 'fits') { best = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return { best, probed }
}

test('REGRESSION: the shipped code rejects all five probes and finds no candidate', () => {
  // Exactly the sequence in the issue: 24 → 11 → 5 → 2 → 0, every one called spill, nothing benched.
  const { best, probed } = runNglSearch(49, false)
  assert.deepEqual(probed, [24, 11, 5, 2, 0])
  assert.equal(best, null, 'this null is the "No candidate completed successfully" the reporter saw')
})

test('unified=true: the first probe fits, so the search climbs and returns a benchable ngl', () => {
  // With spill detection off, nothing bounds the search but a real OOM (see below), so it walks up
  // to full offload — the correct answer on a box where "GPU memory" is system memory.
  const { best, probed } = runNglSearch(49, true)
  assert.equal(probed[0], 24, 'same first probe as the failing run — it just fits this time')
  assert.equal(best, 49)
  // …and it is never null, which is the whole point: a t/s measurement finally happens.
  assert.notEqual(best, null)
})

test('unified=true does not disable the OTHER bounds — OOM still rejects', () => {
  // Spill is the only check that goes away. A hard OOM is checked first and is unaffected.
  const v = probeVerdict({ outcome: 'oom', vramAbsMb: null, spillMb: 6235 }, APU_BUDGET, HEADROOM_MB, null, false, true)
  assert.equal(v.decision === 'offload-more' && v.reason, 'oom')
  // Crash/timeout still read as memory pressure too.
  for (const outcome of ['crash', 'timeout'] as const) {
    assert.equal(probeVerdict({ outcome, vramAbsMb: null, spillMb: 100 }, APU_BUDGET, HEADROOM_MB, null, false, true).decision, 'offload-more')
  }
})

test('unified=true: headroom is the only OTHER bound, and it is inert without a VRAM reading', () => {
  // CONSEQUENCE worth stating: overHeadroom returns false on a null vramAbsMb, so on the #179 box
  // OOM becomes the sole bound on the dense search. Where a unified box CAN read absolute VRAM
  // (an APU with rocm-smi on Linux), the headroom gate still works normally.
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: null, spillMb: 11035 }, APU_BUDGET, HEADROOM_MB, null, false, true).decision, 'fits')
  const tight = probeVerdict({ outcome: 'ok', vramAbsMb: 65900, spillMb: 11035 }, APU_BUDGET, HEADROOM_MB, null, false, true)
  assert.equal(tight.decision === 'offload-more' && tight.reason, 'headroom')
})

test('probeVerdict: unified defaults off — every existing caller is unchanged', () => {
  // Discrete card, real spill, unknown VRAM (any Windows AMD box): still rejected, as today.
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: null, spillMb: 2914 }, 16303, 375)
  assert.equal(v.decision === 'offload-more' && v.reason, 'spill')
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: null, spillMb: 2914 }, 16303, 375, null, false, false).decision, 'offload-more')
})

test('CPU-only: no GPU means no probing and a zero budget — untouched by this change', () => {
  // denseSearch never enters the loop (sys.gpus.length === 0 keeps bestNgl at 0) and unifiedMemory-
  // Only is false there, but pin the verdict shape anyway: a 0 budget makes both remaining gates
  // inert, so a probe is a plain 'fits' with or without the flag.
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: null, spillMb: null }, 0, HEADROOM_MB).decision, 'fits')
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: null, spillMb: null }, 0, HEADROOM_MB, null, false, false).decision, 'fits')
})
