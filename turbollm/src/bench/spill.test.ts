// Direct VRAM-spill measurement (see spill.ts).
//
// Every number here is a REAL reading from the founder's box — RTX 5070 Ti (16303 MiB), 2026-08-07
// — taken from Windows' per-adapter WDDM shared-memory counter while models were loaded.
//
// This file replaced a much larger suite covering a DERIVED approach (extrapolating a per-step
// residency slope from calibration probes). That approach produced six distinct defects in one day
// — a degenerate endpoint corrupting the slope, noise needing a widened anchor gap, anchors that
// were themselves saturated yielding a slope 40% of reality, and a "disable on implausible slope"
// guard that made large models worse — all to estimate a number the OS reports exactly. The tests
// that pinned that machinery are gone with it; what remains pins the measurement.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spillMb, isSpilling, SPILL_TOLERANCE_MB } from './spill'

// ---- spillMb: the delta across a model load ---------------------------------

test('spillMb: reports what the load added to host memory', () => {
  // Ling-3.0-flash at nCpuMoe=25: 1650 MiB of desktop/compositor shared usage before, 6069 after.
  assert.equal(spillMb(1650, 6069), 4419)
})

test('spillMb: taking a DELTA is what makes a shared display harmless', () => {
  // Same 4419 MiB spill on a box whose display sits on the same GPU and already holds ~3 GiB.
  // An absolute reading would call this 7.4 GiB of spill; the delta gets it right.
  assert.equal(spillMb(3000, 7419), 4419)
  // And an idle desktop with the model fitting cleanly reads as no spill, not as 3 GiB of it.
  assert.equal(spillMb(3000, 3000), 0)
})

test('spillMb: floors at 0 — a load that frees shared memory is not negative spill', () => {
  assert.equal(spillMb(500, 400), 0)
})

test('spillMb: null when either reading is unavailable — callers must not read that as "no spill"', () => {
  assert.equal(spillMb(null, 6069), null)
  assert.equal(spillMb(1650, null), null)
  assert.equal(spillMb(null, null), null)
})

// ---- isSpilling: the decision the search makes -------------------------------

test('isSpilling: separates every real reading measured on Qwen3.6-35B-A3B @200k', () => {
  // Baseline 285.3 MiB subtracted. Under the allowance these are driver overhead, not displaced
  // weights; over it, real spill.
  for (const under of [0, 186, 442]) assert.equal(isSpilling(under), false, `${under} MiB flagged`)
  for (const over of [698, 2210, 2914]) assert.equal(isSpilling(over), true, `${over} MiB missed`)
})

test('isSpilling: fails OPEN on an unavailable reading', () => {
  // Apple Metal has no discrete VRAM to spill out of; a localized Windows may not resolve the
  // counter name. Both must behave exactly as before spill detection existed — asserting a spill we
  // did not measure would drive those machines to maximum CPU offload for no reason.
  assert.equal(isSpilling(null), false)
})

test('the measured signal separates fitting from spilling across a 4x model-size range', () => {
  // Matrix run 2026-08-07 — six models, 9.4 to 60.5 GB, one 16.3 GB card, fixed 32k ctx:
  //   qwen3.6-27b   9.4 GB (dense)  177-181   never spilled
  //   qwen3.6-35b  13.2 GB          159       never spilled
  //   ornith 35b   21.2 GB          183-198   3199.5
  //   qwen3.6-35b  31.8 GB          157-158   3647.5
  //   laguna-s-2.1 39.7 GB          161       6343.5
  // No-spill baselines cluster tightly REGARDLESS of model size, and real spill is an order of
  // magnitude away. That 16-39x gap is why a single fixed allowance works with no calibration, and
  // why the threshold is insensitive to exactly where in the gap it sits.
  const fits = [177, 181, 159, 198, 158, 161]
  const spills = [3199.5, 3647.5, 6343.5]
  assert.ok(Math.max(...fits) < SPILL_TOLERANCE_MB, 'every no-spill reading is under the allowance')
  assert.ok(Math.min(...spills) > SPILL_TOLERANCE_MB * 6, 'every real spill is far above it')
  for (const f of fits) assert.equal(isSpilling(f), false)
  for (const s of spills) assert.equal(isSpilling(s), true)
})

test('the baseline is NOT a constant, which is why it is measured rather than assumed', () => {
  // 157-198 MiB across models on a dedicated card, and 285.3 on the same card at 200k ctx. Any
  // hard-coded baseline would be wrong somewhere; the delta sidesteps the question entirely.
  const observed = [157, 159, 161, 177, 181, 198, 285.3]
  assert.ok(Math.max(...observed) - Math.min(...observed) > 100, 'baseline genuinely varies')
  // All of them still sit under the allowance, so none is mistaken for spill.
  for (const b of observed) assert.equal(isSpilling(b), false)
})
