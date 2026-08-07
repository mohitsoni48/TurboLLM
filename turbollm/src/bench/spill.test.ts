// Vendor-neutral VRAM-spill detection (see spill.ts).
//
// Every number in this file is a REAL measurement taken 2026-08-07 on the founder's
// box — RTX 5070 Ti (16303 MiB), Qwen3.6-35B-A3B IQ3_XXS, ctx 200704, mainline
// llama.cpp b10099 cuda — by loading each nCpuMoe and reading Windows'
// `\GPU Adapter Memory(*)\Dedicated Usage` / `Shared Usage` per-adapter counters.
// They are kept verbatim so these tests pin the detector against reality rather
// than against a model of it.
//
// The point of the detector: absolute VRAM CANNOT distinguish "fits" from "spilling"
// once the driver falls back to host memory — nCpuMoe 0/3/9 all read 15823-15828 MiB
// while actually spilling 2914 / 2210 / 698 MiB respectively. Residency shortfall
// against the run's own linear fit CAN.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { residencySlope, predictResidencyMb, spillMb, isSpilling, SPILL_TOLERANCE_MB } from './spill'

// Measured dedicated VRAM (MiB) per nCpuMoe. Perfectly linear from 20 down to 12,
// then it saturates at the card ceiling and stops responding.
const MEASURED: Array<{ knob: number; vramMb: number }> = [
  { knob: 20, vramMb: 13640.9 },
  { knob: 18, vramMb: 14164.9 },
  { knob: 16, vramMb: 14688.9 },
  { knob: 14, vramMb: 15212.9 },
  { knob: 12, vramMb: 15736.9 },
  { knob: 11, vramMb: 15813.2 },
  { knob: 10, vramMb: 15819.7 },
  { knob: 9, vramMb: 15826.2 },
  { knob: 3, vramMb: 15823.2 },
  { knob: 0, vramMb: 15828.6 },
]
const at = (knob: number) => MEASURED.find((m) => m.knob === knob)!

// Ground truth spill, from the OS's own shared-memory counter, net of the constant
// 285.3 MiB baseline it reports even when nothing is spilling.
const BASELINE_SHARED = 285.3
const trueSpill = (sharedMb: number) => sharedMb - BASELINE_SHARED

// ---- residencySlope ---------------------------------------------------------

test('residencySlope: derives MiB-per-expert from the unsaturated region', () => {
  // 20->12 measured four consecutive +524.0 steps over 2 experts each.
  const slope = residencySlope([at(20), at(18), at(16), at(14), at(12)])
  assert.ok(slope !== null)
  assert.ok(Math.abs(slope - 262.0) < 0.5, `expected ~262.0 MiB/expert, got ${slope}`)
})

test('residencySlope: two points are enough (a search may only have two before it must decide)', () => {
  const slope = residencySlope([at(20), at(18)])
  assert.ok(slope !== null)
  assert.ok(Math.abs(slope - 262.0) < 0.5, `got ${slope}`)
})

test('residencySlope: null when it cannot be derived (fewer than 2 usable points)', () => {
  assert.equal(residencySlope([]), null)
  assert.equal(residencySlope([at(20)]), null)
})

test('residencySlope: null when every sample shares one knob value (no gradient to fit)', () => {
  assert.equal(residencySlope([{ knob: 9, vramMb: 15826.2 }, { knob: 9, vramMb: 15825.0 }]), null)
})

test('residencySlope: ignores unknown (null) VRAM readings rather than treating them as zero', () => {
  const slope = residencySlope([at(20), { knob: 19, vramMb: null }, at(18)])
  assert.ok(slope !== null)
  assert.ok(Math.abs(slope - 262.0) < 0.5, `got ${slope}`)
})

// ---- predictResidencyMb + spillMb -------------------------------------------

test('predictResidencyMb: reproduces a measured unsaturated point exactly', () => {
  // Anchored at knob=20, predicting knob=12 (still linear) must land on the measurement.
  const p = predictResidencyMb(at(20), 262.0, 12)
  assert.ok(Math.abs(p - 15736.9) < 1.0, `expected ~15736.9, got ${p}`)
})

test('spillMb: reports ~0 across the whole unsaturated region (no false positives)', () => {
  for (const knob of [18, 16, 14, 12]) {
    const predicted = predictResidencyMb(at(20), 262.0, knob)
    const s = spillMb(predicted, at(knob).vramMb)
    assert.ok(s < 5, `nCpuMoe=${knob} should read as no-spill, got ${s} MiB`)
  }
})

test('spillMb: matches the OS spill counter at the boundary (the case absolute VRAM misses)', () => {
  // nCpuMoe=11 is the first spilling config. Absolute VRAM (15813.2) is BELOW the
  // 15928 fit line, so overHeadroom() calls it a fit — this is the exact miss.
  const predicted = predictResidencyMb(at(20), 262.0, 11)
  const derived = spillMb(predicted, at(11).vramMb)
  const truth = trueSpill(471.3) // 186.0
  assert.ok(Math.abs(derived - truth) < 5, `derived ${derived} vs OS ${truth}`)
})

test('spillMb: tracks the OS counter deep into saturation, where VRAM is completely flat', () => {
  // VRAM reads 15819.7 / 15826.2 / 15823.2 / 15828.6 across these — a 9 MiB spread
  // while true spill ranges 442 -> 2914 MiB. Derived must follow the truth, not the VRAM.
  const cases: Array<[number, number]> = [
    [10, trueSpill(727.3)],  // 442.0
    [9, trueSpill(983.3)],   // 698.0
    [3, trueSpill(2495.3)],  // 2210.0
    [0, trueSpill(3199.3)],  // 2914.0
  ]
  for (const [knob, truth] of cases) {
    const predicted = predictResidencyMb(at(20), 262.0, knob)
    const derived = spillMb(predicted, at(knob).vramMb)
    const errPct = Math.abs(derived - truth) / truth * 100
    assert.ok(errPct < 10, `nCpuMoe=${knob}: derived ${derived.toFixed(1)} vs OS ${truth} (${errPct.toFixed(1)}% off)`)
  }
})

test('spillMb: a candidate short of prediction reports that shortfall as spill', () => {
  // 1000 MiB of predicted residency did not land in VRAM — that IS the spill.
  assert.equal(spillMb(15000, 14000), 1000)
})

test('spillMb: floors at 0 when actual EXCEEDS prediction (a conservative fit, not negative spill)', () => {
  assert.equal(spillMb(14000, 15000), 0)
})

// ---- calibration-gap robustness ---------------------------------------------
//
// Slope error is (reading noise / anchor gap), and it is then MULTIPLIED by the
// extrapolation distance. Too narrow a gap therefore fabricates spill on a config that
// is perfectly fine — which would drive the search to maximum CPU offload, a worse
// regression than the bug spill detection exists to fix. Per-reading noise of ~6 MiB is
// what repeated probes of the same config actually showed on the founder's box.
const NOISE = 6
const TRUE_SLOPE = 262
const BASE = 8400 // residency at maxN (every expert on CPU)

/** Worst-case-noise spill reading for a candidate `distance` steps below the reference,
 *  calibrated from two anchors `gap` apart. Noise is signed to maximally OVER-estimate the
 *  slope (anchors spread apart) and to make the candidate read low — the combination most
 *  likely to invent a spill. */
function worstCaseShortfall(gap: number, distance: number): number {
  const hiAnchor = { knob: 40, vramMb: BASE - NOISE }
  const loAnchor = { knob: 40 - gap, vramMb: BASE + TRUE_SLOPE * gap + NOISE }
  const slope = residencySlope([hiAnchor, loAnchor])!
  const predicted = predictResidencyMb(hiAnchor, slope, 40 - distance)
  const actualTrue = BASE + TRUE_SLOPE * distance - NOISE // real, not spilling, read low
  return spillMb(predicted, actualTrue)
}

test('calibration: a 2-step anchor gap fabricates spill over a long extrapolation (the defect)', () => {
  // 28 steps out, a 2-step gap compounds noise past the tolerance — a false positive.
  assert.ok(worstCaseShortfall(2, 28) > SPILL_TOLERANCE_MB,
    `expected the narrow gap to exceed tolerance, got ${worstCaseShortfall(2, 28).toFixed(1)} MiB`)
})

test('calibration: the shipped proportional gap keeps noise well inside the tolerance', () => {
  // maxN=40 -> gap = round(40/4) = 10. Same 28-step extrapolation, no false spill.
  const shortfall = worstCaseShortfall(10, 28)
  assert.ok(shortfall < SPILL_TOLERANCE_MB,
    `noise alone must not read as spill, got ${shortfall.toFixed(1)} MiB`)
})

test('calibration: a real spill is still caught with the wider gap (no loss of sensitivity)', () => {
  // The smallest real spill measured was 185.7 MiB. It must still clear the tolerance even
  // stacked against worst-case calibration noise working to hide it.
  const hiAnchor = { knob: 40, vramMb: BASE + NOISE }
  const loAnchor = { knob: 30, vramMb: BASE + TRUE_SLOPE * 10 - NOISE } // under-estimates slope
  const slope = residencySlope([hiAnchor, loAnchor])!
  const predicted = predictResidencyMb(hiAnchor, slope, 12)
  const actualSpilling = BASE + TRUE_SLOPE * 28 - 185.7
  assert.ok(spillMb(predicted, actualSpilling) > SPILL_TOLERANCE_MB, 'a real 185.7 MiB spill must still be detected')
})

// ---- isSpilling: the decision the search actually makes ----------------------

test('isSpilling: separates every measured config correctly at the shipped tolerance', () => {
  const slope = residencySlope([at(20), at(18), at(16), at(14)])!
  const verdict = (knob: number) => isSpilling(predictResidencyMb(at(20), slope, knob), at(knob).vramMb)
  // Unsaturated — must NOT be flagged, or the search needlessly gives up GPU residency.
  for (const knob of [18, 16, 14, 12]) assert.equal(verdict(knob), false, `nCpuMoe=${knob} flagged as spilling`)
  // Spilling — must be flagged, including nCpuMoe=11 whose absolute VRAM looks like a fit.
  for (const knob of [11, 10, 9, 3, 0]) assert.equal(verdict(knob), true, `nCpuMoe=${knob} missed`)
})

test('isSpilling: unknown VRAM never claims a spill (matches overHeadroom fail-open contract)', () => {
  // A non-NVIDIA/unreadable box must not have its search silently driven to max offload.
  assert.equal(isSpilling(15998.9, null), false)
})

test('isSpilling: an underived slope cannot manufacture a verdict', () => {
  assert.equal(isSpilling(null, 15813.2), false)
})
