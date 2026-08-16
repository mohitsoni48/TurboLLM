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
import { spillMb, isSpilling, spillFloor, SPILL_TOLERANCE_MB, SPILL_PROXIMITY_MB, SPILL_FLOOR_CAP_MB } from './spill'

// The founder's card, used by every case below that needs a budget.
const CARD = 16303
// A reading taken while the card is saturated — the state a real spill is measured in (see spill.ts:
// once the driver demotes, used-VRAM pins at the ceiling and stops responding to placement).
const SATURATED = 15823

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
  // Those readings were all taken with the card saturated (15823-15828 MiB of 16303), so the
  // proximity corroboration is satisfied throughout and the tolerance alone decides.
  for (const under of [0, 186, 442]) assert.equal(isSpilling(under, SATURATED, CARD), false, `${under} MiB flagged`)
  for (const over of [698, 2210, 2914]) assert.equal(isSpilling(over, SATURATED, CARD), true, `${over} MiB missed`)
})

test('isSpilling: fails OPEN on an unavailable reading', () => {
  // Apple Metal has no discrete VRAM to spill out of; a localized Windows may not resolve the
  // counter name. Both must behave exactly as before spill detection existed — asserting a spill we
  // did not measure would drive those machines to maximum CPU offload for no reason.
  assert.equal(isSpilling(null, SATURATED, CARD), false)
  assert.equal(isSpilling(null, null, 0), false)
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
  for (const f of fits) assert.equal(isSpilling(f, SATURATED, CARD), false)
  for (const s of spills) assert.equal(isSpilling(s, SATURATED, CARD), true)
})

// ---- the fixed-cost floor: host memory a config ALWAYS pins, at any offload -----------------

test('isSpilling: host memory pinned while the card has room to spare is not a spill', () => {
  // Live A/B, 2026-08-15, RTX 5070 Ti (16303 MiB) — Qwen3.8-27B Q3_K_S, ctx 71168, q8_0 KV, ngl=32.
  // The ONLY difference between the two runs is the speculative setting:
  //   speculative=off    shared delta 178 MB   dedicated 7950 MiB
  //   speculative=nextn  shared delta 594 MB   dedicated 9672 MiB
  // Enabling NextN makes llama.cpp build a second (MTP draft) context — "common_speculative_init_
  // result: creating MTP draft context against the target model" in the engine log — and its
  // host-side buffers are pinned into GPU-visible memory, so Windows counts them under shared
  // usage. That is 416 MB the model DELIBERATELY placed in host memory with 6.6 GB of dedicated
  // VRAM still free. It is not the driver demoting anything, and no amount of extra CPU offload
  // removes it.
  assert.equal(isSpilling(178, 7950, CARD), false, 'the no-spec baseline was never in question')
  assert.equal(isSpilling(594, 9672, CARD), false, 'NextN\'s pinned draft buffers are not a spill')
})

test('isSpilling: a fixed floor stays a floor at every offload the search tries', () => {
  // The sweep that exposed this (auto-tune of the same model, 2026-08-15) rejected all six probes
  // and ended "No candidate completed successfully." Spill is DEAD FLAT across the whole range
  // while dedicated VRAM swings 2601 -> 11877 MiB: nothing the offload knob does can shrink it,
  // which is the signature of a fixed cost rather than displaced weights.
  const sweep: Array<[ngl: number, vramAbs: number, spill: number]> = [
    [32, 9981, 594],
    [15, 5971, 594],
    [7, 4079, 592],
    [3, 3129, 594],
    [1, 2601, 588],
    [0, 11877, 594],
  ]
  for (const [ngl, vramAbs, spill] of sweep) {
    assert.equal(isSpilling(spill, vramAbs, CARD), false, `ngl=${ngl} still rejected as spill`)
  }
})

test('isSpilling: still catches every real spill, which is measured at a saturated card', () => {
  // The readings this detector was built for. All were taken with used-VRAM pinned at the ceiling
  // (15823-15828 MiB of 16303) — that pinning IS how the driver behaves once it demotes, so the
  // corroboration below never gets in the way of a genuine spill.
  for (const over of [698, 2210, 2914, 3199.5, 3647.5, 6343.5]) {
    assert.equal(isSpilling(over, SATURATED, CARD), true, `${over} MiB missed`)
  }
  // And the case the spill check exists to catch: 15813 MiB passed a 15928 MiB fit line as a
  // "clean fit" while 698 MiB sat in host memory. Still caught.
  assert.equal(isSpilling(698, 15813, CARD), true)
})

test('isSpilling: corroboration needs a VRAM reading and a budget — without either, fail as before', () => {
  // Unknown VRAM or no GPU budget must not silently disable spill detection; those boxes keep
  // exactly the behaviour they had before the corroboration existed.
  assert.equal(isSpilling(2914, null, CARD), true)
  assert.equal(isSpilling(2914, 9672, 0), true)
})

test('isSpilling: the corroboration line sits between the two regimes with room on both sides', () => {
  // Real spills were measured within 490 MB of the ceiling; the NextN floor sat 6322 MB below it.
  // Anything in that gap works, so the exact value is not load-bearing — but it must clear the
  // measured saturation band by a margin.
  assert.ok(CARD - SATURATED < SPILL_PROXIMITY_MB, 'a saturated card is inside the window')
  assert.ok(SPILL_PROXIMITY_MB < CARD - 9672, 'the NextN reading is well outside it')
})

// ---- spillFloor: measuring the fixed cost from probes the search already runs ----------------

test('spillFloor: only probes with VRAM to spare can measure the floor', () => {
  // Far below the ceiling: the card demonstrably had room, so this reading IS the fixed cost.
  assert.equal(spillFloor(null, 607, 9672, CARD), 607)
  // Tighter reading at another roomy probe lowers the bound.
  assert.equal(spillFloor(607, 594, 14626, CARD), 594)
  // A higher one does not raise it — the floor is the tightest bound seen.
  assert.equal(spillFloor(594, 653, 13682, CARD), 594)
  // Near the ceiling nothing is provable, so such probes never contribute.
  assert.equal(spillFloor(594, 300, SATURATED, CARD), 594)
  assert.equal(spillFloor(null, 300, SATURATED, CARD), null)
})

test('spillFloor: unusable readings leave the floor untouched', () => {
  assert.equal(spillFloor(594, null, 9672, CARD), 594)
  assert.equal(spillFloor(594, 607, null, CARD), 594)
  assert.equal(spillFloor(594, 607, 9672, 0), 594, 'no GPU budget proves nothing')
})

test('the measured floor is what saves the config the search actually wants', () => {
  // The run that proved the proximity rule works, 2026-08-15. The sweep completed and chose
  // ngl=55 — then the post-bench check re-read the SAME NextN floor at a candidate sitting 3 MB
  // inside the proximity window, called it spill, and backed off to ngl=54:
  //     ngl=55  vram 15282  spill 552  ->  5.735 t/s
  //     ngl=54  vram 14984  spill 653  ->  4.309 t/s   (what it handed back: 25% slower)
  // Proximity cannot help here — the winner is SUPPOSED to sit near the ceiling.
  assert.equal(isSpilling(552, 15282, CARD), true, 'proximity alone still rejects the winner')

  // The floor the sweep had already measured, for free, from its own roomy probes.
  let floor: number | null = null
  for (const [spill, vram] of [[607, 9672], [595, 13682], [594, 14626], [594, 15144]] as const) {
    floor = spillFloor(floor, spill, vram, CARD)
  }
  assert.equal(floor, 594, 'ngl=55 at 15144 MiB is inside the window and must not count')
  assert.equal(isSpilling(552, 15282, CARD, floor), false, 'floor subtracted -> no bogus backoff')
  assert.equal(isSpilling(653, 14984, CARD, floor), false)
})

test('subtracting the floor does not hide a real spill — it sharpens it', () => {
  // The no-spill baselines that WOULD be measured as the floor on those same runs were 157-198 MB,
  // so subtracting one moves a genuine 2914 MB spill to ~2730 — nowhere near the tolerance.
  assert.equal(isSpilling(2914, SATURATED, CARD, 198), true)
  assert.equal(isSpilling(698, SATURATED, CARD, 157), true)
  // Even against the much larger NextN floor, real spill still reads as real spill.
  assert.equal(isSpilling(3199.5, SATURATED, CARD, 594), true)
})

test('the baseline is NOT a constant, which is why it is measured rather than assumed', () => {
  // 157-198 MiB across models on a dedicated card, and 285.3 on the same card at 200k ctx. Any
  // hard-coded baseline would be wrong somewhere; the delta sidesteps the question entirely.
  const observed = [157, 159, 161, 177, 181, 198, 285.3]
  assert.ok(Math.max(...observed) - Math.min(...observed) > 100, 'baseline genuinely varies')
  // All of them still sit under the allowance, so none is mistaken for spill.
  for (const b of observed) assert.equal(isSpilling(b, SATURATED, CARD), false)
})

// ---- pooled (multi-GPU): the corroboration is unsound on a summed pool, so it's disabled -----
// From independent Opus review of this fix, 2026-08-16: on a multi-GPU layer split, vramAbsMb and
// budgetMb are both summed across cards. A card can be individually saturated and genuinely
// demoting to host memory while the SUMMED pool still reads as roomy, because another card has
// room — the exact case the corroboration exists to distinguish, made unrecoverable by the sum.

test('isSpilling: pooled=true skips proximity — a real spill is not exempted just because the POOL has room', () => {
  // 2x16 GB layer split, budget=32606. Card 0 saturated and actively demoting 3000 MB; card 1 has
  // 8000 MiB free. Pool reads 23828/32606 — 8778 MB "free", comfortably outside the 1024 MB
  // proximity window — so the unpooled check would exempt a real, measured spill.
  assert.equal(isSpilling(3000, 23828, 32606), false, 'sanity: unpooled DOES get fooled by the sum')
  assert.equal(isSpilling(3000, 23828, 32606, null, true), true, 'pooled: falls back to tolerance, catches it')
})

test('spillFloor: pooled=true never learns — a roomy-looking pool must not teach a floor from a spilling card', () => {
  // Same scenario: without the guard this genuinely-spilling probe becomes the "fixed cost" and
  // is then subtracted from every later candidate too, including ones actually at the pool ceiling.
  assert.equal(spillFloor(null, 3000, 23828, 32606, true), null, 'pooled: nothing learned')
  // Sanity: unpooled DOES learn from it — capped at SPILL_FLOOR_CAP_MB (2048), not the raw 3000,
  // since that cap applies regardless of pooling (see the floor-cap tests below).
  assert.equal(spillFloor(null, 3000, 23828, 32606, false), SPILL_FLOOR_CAP_MB)
})

test('pooled=true still catches an unambiguous spill (both cards at the sum ceiling)', () => {
  // Not exercising the multi-GPU gap here — the pool itself is over tolerance with no free room
  // anywhere, so pooled and unpooled must agree: this is real spill either way.
  assert.equal(isSpilling(2914, 32000, 32606, null, true), true)
  assert.equal(isSpilling(2914, 32000, 32606, null, false), true)
})

test('pooled=true is the default-off path — single-GPU callers are unaffected', () => {
  // Every test above this point calls isSpilling/spillFloor with pooled defaulted (false) and
  // still passes unmodified — the parameter is additive, not a behavior change for the hardware
  // this module was built and validated on.
  assert.equal(isSpilling(594, 9672, CARD), false)
  assert.equal(spillFloor(null, 607, 9672, CARD), 607)
})

// ---- SPILL_FLOOR_CAP_MB: one noisy roomy probe must not permanently mask real spill -----------

test('spillFloor: capped so a spuriously-inflated roomy reading cannot become an unbounded floor', () => {
  // Some OTHER process allocates a large chunk of shared memory during exactly one roomy probe's
  // window — spillFloor has no way to tell that apart from a real fixed cost, but the cap bounds
  // the damage: no floor can ever exceed SPILL_FLOOR_CAP_MB (2048), which sits comfortably under
  // every real spill this module has ever measured (smallest: 698 MB) while clearing every real
  // fixed cost seen so far (NextN: 416 MB) with room to spare.
  const noisy = spillFloor(null, 5000, 9000, CARD) // e.g. another app burst-allocated during this probe
  assert.equal(noisy, SPILL_FLOOR_CAP_MB)
  // A real spill well above the cap is still caught — the cap doesn't just relabel a huge floor
  // as "safe", it stops that floor from ever being trusted enough to clear a genuine spill.
  assert.equal(isSpilling(6343.5, SATURATED, CARD, noisy), true)
})

test('spillFloor: the cap does not interfere with real, sane floors', () => {
  assert.equal(spillFloor(null, 416, 9672, CARD), 416)
  assert.equal(spillFloor(416, 594, 14626, CARD), 416)
})
