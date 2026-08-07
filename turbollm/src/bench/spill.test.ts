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
import { residencySlope, predictResidencyMb, spillMb, isSpilling, slopeImplausible, SPILL_TOLERANCE_MB, MIN_PLAUSIBLE_SLOPE_FRACTION } from './spill'

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

test('calibration: a wider anchor gap yields a materially more accurate slope', () => {
  // The reason the shipped code uses a proportional gap. Slope error is (noise / gap), so a
  // 10-step gap is ~5x more precise than a 2-step one. With the 512 MiB allowance neither error
  // crosses the spill threshold on this model any more, but accuracy still matters: a model with
  // much larger per-step cost would scale these errors up proportionally.
  const narrow = worstCaseShortfall(2, 28)
  const wide = worstCaseShortfall(10, 28)
  assert.ok(wide < narrow / 3, `wide gap should be far more accurate: narrow=${narrow.toFixed(1)} wide=${wide.toFixed(1)}`)
})

test('calibration: noise alone never reads as spill at the shipped allowance', () => {
  assert.ok(worstCaseShortfall(10, 28) < SPILL_TOLERANCE_MB)
  // Even the old narrow gap is now inside the allowance — the 512 MiB threshold subsumes this
  // class of error entirely. Recorded so nobody re-derives the narrow-gap panic later.
  assert.ok(worstCaseShortfall(2, 28) < SPILL_TOLERANCE_MB)
})

test('calibration: a real spill is still caught, with noise working to hide it', () => {
  // 698 MiB — the spill measured at nCpuMoe=9 — must clear the allowance even when the slope is
  // under-estimated by worst-case noise (which shrinks the predicted residency and hides spill).
  const hiAnchor = { knob: 40, vramMb: BASE + NOISE }
  const loAnchor = { knob: 30, vramMb: BASE + TRUE_SLOPE * 10 - NOISE }
  const slope = residencySlope([hiAnchor, loAnchor])!
  const predicted = predictResidencyMb(hiAnchor, slope, 12)
  const actualSpilling = BASE + TRUE_SLOPE * 28 - 698
  assert.ok(spillMb(predicted, actualSpilling) > SPILL_TOLERANCE_MB, 'a real 698 MiB spill must still be detected')
})

// ---- degenerate-endpoint hazard (found by LIVE testing, 2026-08-07) ----------
//
// Measured on the founder's box during the first live run of spill detection, same
// model/ctx/engine as above. The endpoint nCpuMoe=40 (EVERY expert on CPU) does not lie
// on the same line as the rest of the range: the 40->30 segment reads 269.6 MB/expert
// while 30->25, 25->22 and 22->20 all read exactly 262.0. Calibrating across that endpoint
// inflated the slope by 2.9%, which compounded over 20 steps into a false spill verdict on
// nCpuMoe=20 -- a config with 2.5 GB of VRAM free -- and drove the search into 21-40.
//
// The unit tests could not have caught this: they were built from a single run's data that
// never probed the endpoint. Only driving the real search surfaced it.
const LIVE = { 40: 8462, 30: 11158, 25: 12468, 22: 13254, 21: 13514, 20: 13778 } as const

test('live data: interior segments agree on 262.0 MB/expert; only the endpoint segment disagrees', () => {
  // Residency RISES as nCpuMoe falls, so the gain per expert is (lower-knob reading - higher-knob).
  assert.ok(Math.abs((LIVE[25] - LIVE[30]) / 5 - 262.0) < 0.5, '30->25')
  assert.ok(Math.abs((LIVE[22] - LIVE[25]) / 3 - 262.0) < 0.5, '25->22')
  assert.ok(Math.abs((LIVE[20] - LIVE[22]) / 2 - 262.0) < 0.5, '22->20')
  // The outlier — this is the one the old anchor placement calibrated on.
  assert.ok(Math.abs((LIVE[30] - LIVE[40]) / 10 - 269.6) < 0.5, '40->30 is the outlier')
})

test('REGRESSION: anchoring on the degenerate endpoint corrupts the slope', () => {
  // Exactly what shipped and failed live: anchors [40, 30]. The endpoint is off the line, so the
  // slope comes out 269.6 instead of the true 262.0 and every downstream prediction runs high.
  const slope = residencySlope([{ knob: 40, vramMb: LIVE[40] }, { knob: 30, vramMb: LIVE[30] }])!
  assert.ok(Math.abs(slope - 269.6) < 0.5, `corrupted slope, got ${slope}`)
  const predicted = predictResidencyMb({ knob: 40, vramMb: LIVE[40] }, slope, 20)
  // 76 MiB of phantom shortfall on a config with ~2.5 GB free. Under the 512 MiB allowance this
  // no longer flips the verdict, but at the 64 MiB tolerance originally shipped it DID — which is
  // how the live run was driven into the wrong half of the range.
  const phantom = spillMb(predicted, LIVE[20])
  assert.ok(phantom > 64 && phantom < 100, `expected ~76 MiB of phantom shortfall, got ${phantom.toFixed(1)}`)
})

test('interior anchors recover the true slope and predict the config exactly', () => {
  // The shipped fix: both anchors interior, away from maxN.
  const slope = residencySlope([{ knob: 30, vramMb: LIVE[30] }, { knob: 25, vramMb: LIVE[25] }])!
  assert.ok(Math.abs(slope - 262.0) < 0.5, `expected 262.0, got ${slope}`)
  const predicted = predictResidencyMb({ knob: 30, vramMb: LIVE[30] }, slope, 20)
  assert.equal(isSpilling(predicted, LIVE[20]), false, 'healthy config must not be flagged')
  assert.ok(Math.abs(predicted - LIVE[20]) < 5, `prediction should land on the measurement, got ${predicted}`)
})

// ---- slopeImplausible: catching a calibration taken across saturated anchors --
//
// Found live 2026-08-07 on Ling-3.0-flash (39227328000 bytes, 42 blocks, q8_0 @ 131k ctx) on the
// same 16 GB card. The model is far larger than VRAM, so BOTH calibration anchors were already
// spilling — nCpuMoe=26 read 15754 MiB with only 549 MiB free. The delta between two capped
// readings measures what FIT, not what was requested, so the slope came out 378.5 MB/expert against
// a ~934 MB per-block average. Every prediction built on it under-reported spill by ~12x, and a
// config carrying 4419 MiB of REAL spill (measured via the OS counter) scored 358 MiB and was
// accepted. Under-reporting is the dangerous direction: a badly-spilling config reads as fine.
const LING_BYTES = 39227328000
const LING_BLOCKS = 42
const QWEN_BYTES = 13211155424
const QWEN_BLOCKS = 40

test('slopeImplausible: flags the Ling calibration that let 4.4 GB of spill through', () => {
  // 39227 MB / 42 = 934 MB per block; measured 378.5 is 40% of that.
  assert.equal(slopeImplausible(378.5, LING_BYTES, LING_BLOCKS), true)
})

test('slopeImplausible: does NOT flag the healthy Qwen calibration', () => {
  // 13211 MB / 40 = 330 MB per block; the true measured slope 262.0 is 79% of that. A block holds
  // attention weights that never move with the offload knob, so a healthy slope is always BELOW the
  // per-block average — this is a floor test, not an equality test.
  assert.equal(slopeImplausible(262.0, QWEN_BYTES, QWEN_BLOCKS), false)
})

test('slopeImplausible: claims nothing when the model geometry is unknown', () => {
  // No size or no block count → no expectation to test against, so never assert implausibility.
  assert.equal(slopeImplausible(1, 0, LING_BLOCKS), false)
  assert.equal(slopeImplausible(1, LING_BYTES, 0), false)
})

test('slopeImplausible: the threshold separates the two real cases with margin on both sides', () => {
  const lingPerBlock = LING_BYTES / 1e6 / LING_BLOCKS
  const qwenPerBlock = QWEN_BYTES / 1e6 / QWEN_BLOCKS
  assert.ok(378.5 / lingPerBlock < MIN_PLAUSIBLE_SLOPE_FRACTION, 'Ling is below the floor')
  assert.ok(262.0 / qwenPerBlock > MIN_PLAUSIBLE_SLOPE_FRACTION, 'Qwen is above it')
  // And not marginally: 40% vs 79%, with the threshold at 50%.
  assert.ok(Math.abs(378.5 / lingPerBlock - 0.405) < 0.02)
  assert.ok(Math.abs(262.0 / qwenPerBlock - 0.793) < 0.02)
})

// ---- isSpilling: the decision the search actually makes ----------------------

test('isSpilling: flags configs whose spill exceeds the 512 MiB allowance', () => {
  const slope = residencySlope([at(20), at(18), at(16), at(14)])!
  const verdict = (knob: number) => isSpilling(predictResidencyMb(at(20), slope, knob), at(knob).vramMb)
  // Not spilling at all, or only within the allowance — isSpilling must stay quiet. Note 11 and 10
  // DO spill (185.7 / 441.2 MiB) but under the allowance; they are rejected by the free-VRAM term
  // in probeVerdict instead. This function is deliberately only half the rule.
  for (const knob of [18, 16, 14, 12, 11, 10]) assert.equal(verdict(knob), false, `nCpuMoe=${knob} flagged`)
  // Unambiguous spill, far past the allowance.
  for (const knob of [9, 3, 0]) assert.equal(verdict(knob), true, `nCpuMoe=${knob} missed`)
})

test('isSpilling: unknown VRAM never claims a spill (matches overHeadroom fail-open contract)', () => {
  // A non-NVIDIA/unreadable box must not have its search silently driven to max offload.
  assert.equal(isSpilling(15998.9, null), false)
})

test('isSpilling: an underived slope cannot manufacture a verdict', () => {
  assert.equal(isSpilling(null, 15813.2), false)
})
