import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickKvQuants, betterBySpeed, ttfMs, TTF_OUTPUT_TOKENS, probeVerdict, overHeadroom, spillImproves, kvSpeedAdvisory, parseRocmVramUsed, benchPromptTokens, buildBenchMessages } from './bench'
import { residencySlope, predictResidencyMb } from './spill'

// ---- pickKvQuants: quality-preserving KV sweep, base-first ------------------

test('pickKvQuants: stock llama.cpp (no turbo) → f16 + q8_0 only', () => {
  const stock = ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_1']
  assert.deepEqual(pickKvQuants('f16', stock), ['f16', 'q8_0'])
})

test('pickKvQuants: TurboQuant fork → adds turbo4 (never turbo2/turbo3)', () => {
  const turbo = ['f16', 'q8_0', 'q4_0', 'q5_1', 'turbo2', 'turbo3', 'turbo4']
  assert.deepEqual(pickKvQuants('f16', turbo), ['f16', 'q8_0', 'turbo4'])
})

test('pickKvQuants: base type comes first and is de-duplicated', () => {
  const turbo = ['f16', 'q8_0', 'turbo2', 'turbo3', 'turbo4']
  assert.deepEqual(pickKvQuants('q8_0', turbo), ['q8_0', 'f16', 'turbo4'])
})

test('pickKvQuants: never auto-adds lower-bit types, but keeps the user\'s own choice', () => {
  const stock = ['f16', 'q8_0', 'q4_0', 'q5_1']
  // q4_0 is lower-quality and never *added*, but if the user explicitly set it, it stays (first).
  assert.deepEqual(pickKvQuants('q4_0', stock), ['q4_0', 'f16', 'q8_0'])
  // q5_1 is never a quality-preserving candidate.
  assert.ok(!pickKvQuants('f16', stock).includes('q5_1'))
})

test('pickKvQuants: unprobed engine (empty kvTypes) → base type only', () => {
  assert.deepEqual(pickKvQuants('f16', []), ['f16'])
  assert.deepEqual(pickKvQuants('q8_0', []), ['q8_0'])
})

// ---- ttfMs / betterBySpeed: time-to-a-complete-answer objective --------------
//
// REPLACED the previous "generation t/s primary, prefill as a 5% tie-break" scoring
// (founder call, 2026-08-07). That objective was generation-dominant, and generation
// t/s IMPROVES as more of a MoE model is forced onto the GPU — including past the point
// where it spills into system RAM. So optimizing it systematically selected toward spill:
// it preferred nCpuMoe=3 (spilling 2.5 GB) over nCpuMoe=16 (spilling nothing) purely on a
// 54% generation lead, while n=16 actually finishes a turn 1.33x sooner because at real
// context depth prefill dominates the wall clock.
//
// Both configs below are REAL measurements (2026-08-07, RTX 5070 Ti, Qwen3.6-35B-A3B
// IQ3_XXS @ ctx 200704), normalized to a common 20k-token prompt.

// nCpuMoe=3: spills 2495 MiB. prefill 767 t/s -> 20000/767 = 26075 ms to first token.
const SPILLING = { ttftMs: 26075, tps: 135 }
// nCpuMoe=16: spills nothing, 1614 MiB free. prefill 1450 t/s -> 13793 ms to first token.
const CLEAN = { ttftMs: 13793, tps: 87.5 }

test('ttfMs: combines measured time-to-first-token with generation time for the rest', () => {
  // 26075 ms prefill + 1000 tokens / 135 t/s = 26075 + 7407 = 33482 ms
  assert.ok(Math.abs(ttfMs(SPILLING)! - 33482) < 5, `got ${ttfMs(SPILLING)}`)
  // 13793 ms prefill + 1000 / 87.5 = 13793 + 11429 = 25222 ms
  assert.ok(Math.abs(ttfMs(CLEAN)! - 25222) < 5, `got ${ttfMs(CLEAN)}`)
})

test('ttfMs: null when it cannot be computed — never rank an unmeasured candidate', () => {
  assert.equal(ttfMs({ ttftMs: null, tps: 135 }), null)
  assert.equal(ttfMs({ ttftMs: 26075, tps: null }), null)
  assert.equal(ttfMs({ ttftMs: 26075, tps: 0 }), null) // no divide-by-zero blowup
})

test('betterBySpeed: the NON-spilling config wins, though it generates 54% slower', () => {
  // This is the regression the whole change exists to prevent. Under the old
  // generation-primary objective the spilling config won this comparison.
  assert.equal(betterBySpeed(CLEAN, SPILLING), true)
  assert.equal(betterBySpeed(SPILLING, CLEAN), false)
})

test('betterBySpeed: a big prefill lead CAN now overcome a generation deficit (deliberate)', () => {
  // Directly inverts the old "a >5% generation deficit is NOT rescued by prefill" rule.
  // CLEAN generates 35% slower than SPILLING yet wins on time-to-answer. That inversion
  // is the point, not a side effect.
  assert.ok(CLEAN.tps < SPILLING.tps * 0.95, 'CLEAN must really be the slower generator')
  assert.equal(betterBySpeed(CLEAN, SPILLING), true)
})

test('ttfMs: the output-length lever moves the winner — and the crossover is real', () => {
  // Short answers: prefill dominates, clean config wins big (1.80x).
  assert.ok(ttfMs(CLEAN, 100)! < ttfMs(SPILLING, 100)!)
  // At the shipped 1000, clean still wins (1.33x).
  assert.ok(ttfMs(CLEAN, 1000)! < ttfMs(SPILLING, 1000)!)
  // Past ~3056 tokens generation dominates and the SPILLING config wins again. This is
  // why TTF_OUTPUT_TOKENS must stay below the crossover — documented, not accidental.
  assert.ok(ttfMs(SPILLING, 5000)! < ttfMs(CLEAN, 5000)!)
})

test('TTF_OUTPUT_TOKENS: stays below the measured crossover where spill starts winning', () => {
  assert.equal(TTF_OUTPUT_TOKENS, 1000)
  assert.ok(ttfMs(CLEAN, TTF_OUTPUT_TOKENS)! < ttfMs(SPILLING, TTF_OUTPUT_TOKENS)!)
})

test('betterBySpeed: an uncomputable candidate never wins on a technicality', () => {
  const unmeasured = { ttftMs: null, tps: null }
  assert.equal(betterBySpeed(unmeasured, CLEAN), false)
  assert.equal(betterBySpeed(CLEAN, unmeasured), true)
  assert.equal(betterBySpeed(unmeasured, unmeasured), false)
})

test('betterBySpeed: an exact tie keeps the incumbent rather than churning the winner', () => {
  assert.equal(betterBySpeed({ ...CLEAN }, { ...CLEAN }), false)
})

// ---- probeVerdict + search convergence --------------------------------------
//
// End-to-end proof that fit + spill + load-outcome COMPOSE into the right answer. The
// individual pieces each having correct unit tests does not establish this.
//
// Real measured dedicated VRAM (MiB) per nCpuMoe, RTX 5070 Ti (16303 MiB total),
// Qwen3.6-35B-A3B IQ3_XXS @ ctx 200704, 2026-08-07. Values for 4 and 1 come from the
// daemon's own bench probes (nvidia-smi); the rest from per-adapter perf counters.
const VRAM_AT: Record<number, number> = {
  20: 13640.9, 18: 14164.9, 16: 14688.9, 14: 15212.9, 13: 15474.9, 12: 15736.9,
  11: 15813.2, 10: 15819.7, 9: 15826.2, 4: 15790.0, 3: 15823.2, 1: 15782.0, 0: 15828.6,
}
// nCpuMoe=13 was never probed directly; it sits exactly on the measured 262.0 MiB/expert line
// between 14 and 12, both of which WERE measured. Marked so nobody mistakes it for a reading.
const BUDGET_MB = 16303
const HEADROOM_MB = 375 // the founder's configured value

/** Replays the binary search over nCpuMoe using the REAL probeVerdict for every decision.
 *  `withSpill: false` passes a null prediction, which is exactly how the search behaved
 *  before spill detection existed. */
function runSearch(maxN: number, withSpill: boolean): number | null {
  const slope = residencySlope([{ knob: 20, vramMb: VRAM_AT[20] }, { knob: 18, vramMb: VRAM_AT[18] }])!
  const ref = { knob: 20, vramMb: VRAM_AT[20] }
  let lo = 0, hi = maxN, bestN: number | null = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const vramAbsMb = VRAM_AT[mid]
    if (vramAbsMb === undefined) throw new Error(`test gap: no measurement for nCpuMoe=${mid}`)
    const predicted = withSpill ? predictResidencyMb(ref, slope, mid) : null
    const v = probeVerdict({ outcome: 'ok', vramAbsMb }, predicted, BUDGET_MB, HEADROOM_MB)
    if (v.decision === 'fits') { bestN = mid; hi = mid - 1 } else { lo = mid + 1 }
  }
  return bestN
}

test('search drives to the lowest in-window config (nCpuMoe=10), not the first one it finds', () => {
  // headroom + allowance is a REJECTION CEILING, not an acceptance floor (founder correction):
  // free VRAM above it means there is still room to move experts onto the GPU, so the search must
  // keep going left. The ideal config has free VRAM BETWEEN headroom (375) and headroom+512 (887).
  // Here that bottoms out at nCpuMoe=10: 483 MiB free (in window) and 441 MiB spill (under the
  // 512 allowance). nCpuMoe=9 is rejected — 696.7 MiB of spill clears the allowance.
  assert.equal(runSearch(40, true), 10)
})

test('KNOWN GAP: the lowest in-window config is NOT the fastest — measured, not theorised', () => {
  // Time-to-answer is unimodal in offload, so the fit/spill boundary is not the speed peak.
  // Measured at equal prompt depth on the founder's box: nCpuMoe=13 -> 25.8s, 12 -> 26.7s,
  // 14 -> 31.9s. Performance DEGRADES below 13, yet the window rule alone bottoms out at 10.
  // Bounding the region is therefore necessary but not sufficient; picking the winner inside it
  // needs real measurement (this is what ADR-072's deleted confirmPeak() did). Recorded here so
  // the gap is not mistaken for correct behaviour.
  const TTF_AT: Record<number, number> = { 14: 31.9, 13: 25.8, 12: 26.7 }
  const fastest = Object.entries(TTF_AT).sort((a, b) => a[1] - b[1])[0][0]
  assert.equal(fastest, '13', 'the measured optimum')
  assert.notEqual(runSearch(40, true), 13, 'the window rule alone does not land on it')
})

test('REGRESSION: the original bug — plain fit check alone walks to nCpuMoe=0', () => {
  // Reproduces the pre-fix logic exactly: raw overHeadroom at the user's bare 375 MiB headroom,
  // with no spill input and no compute-buffer margin. Every probe from 9 down reads below the
  // 15928 MiB line, so each looks like a clean fit and the search takes residency it never gets.
  let lo = 0, hi = 40, bestN: number | null = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const v = VRAM_AT[mid]
    if (v === undefined) throw new Error(`test gap: no measurement for nCpuMoe=${mid}`)
    if (!overHeadroom(v, BUDGET_MB, HEADROOM_MB)) { bestN = mid; hi = mid - 1 } else { lo = mid + 1 }
  }
  assert.equal(bestN, 0, 'the reported bug')
})

test('the spill input is what halts the search — the headroom check alone does not', () => {
  // Without spill, every probe from 9 downward still reads under the 15928 MiB headroom line, so
  // the search runs all the way to nCpuMoe=0: the originally reported bug. Spill is the guard that
  // stops it at the allowance.
  assert.equal(runSearch(40, false), 0, 'headroom alone → the original bug')
  assert.equal(runSearch(40, true), 10, 'with spill → stops at the allowance')
})

test('probeVerdict: spill is checked BEFORE the fit test, so the reason reported is the real one', () => {
  // nCpuMoe=9 spills 696.7 MiB (over the 512 allowance) AND is over the fit line. Both would
  // reject it; ordering decides which reason the user sees, and "spilling" is the true cause.
  const predicted = predictResidencyMb({ knob: 20, vramMb: VRAM_AT[20] }, 262.0, 9)
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: VRAM_AT[9] }, predicted, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision === 'offload-more' && v.reason, 'spill')
})

test('probeVerdict: a config spilling UNDER the allowance is ACCEPTED when free VRAM clears headroom', () => {
  // nCpuMoe=11 spills 185.7 MiB — under the 512 allowance — and leaves 490 MiB free, which clears
  // the 375 MiB headroom. That is squarely inside the ideal window, so it is a legitimate candidate.
  // An earlier revision rejected exactly this case by treating headroom+allowance as a floor.
  const predicted = predictResidencyMb({ knob: 20, vramMb: VRAM_AT[20] }, 262.0, 11)
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: VRAM_AT[11] }, predicted, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision, 'fits')
})

test('probeVerdict: free VRAM below the configured headroom is rejected', () => {
  // 16000 MiB used on a 16303 MiB card leaves 303 MiB — under the 375 MiB headroom, so too tight.
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: 16000 }, 16000, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision === 'offload-more' && v.reason, 'headroom')
})

test('dense direction: negating the knob makes HIGHER ngl predict MORE residency', () => {
  // denseSearch passes knob = -ngl so spill.ts's "lower knob = more resident" convention holds
  // for a parameter that works the opposite way from nCpuMoe. A sign error here would be silent:
  // predictions would run backwards and every spilling config would read as a comfortable fit.
  // Synthetic but exact: 300 MiB per layer, anchored at ngl=1 and ngl=5.
  const slope = residencySlope([{ knob: -1, vramMb: 1000 }, { knob: -5, vramMb: 2200 }])!
  assert.ok(Math.abs(slope - 300) < 0.5, `expected 300 MiB/layer, got ${slope}`)
  const ref = { knob: -1, vramMb: 1000 }
  // ngl=9 is 8 layers above the anchor → 1000 + 8*300 = 3400.
  assert.equal(predictResidencyMb(ref, slope, -9), 3400)
  // Actually resident 2500 → 900 MiB went to host memory → spilling, so use FEWER layers.
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: 2500 }, 3400, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision === 'offload-more' && v.reason, 'spill')
  // And a candidate that lands where predicted is not flagged.
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: 3400 }, 3400, BUDGET_MB, HEADROOM_MB).decision, 'fits')
})

test('probeVerdict: a hard OOM outranks everything and never needs a prediction', () => {
  assert.deepEqual(probeVerdict({ outcome: 'oom', vramAbsMb: null }, null, BUDGET_MB, HEADROOM_MB), { decision: 'offload-more', reason: 'oom' })
})

test('probeVerdict: crash/timeout are treated as memory pressure, not as a fit', () => {
  for (const outcome of ['crash', 'timeout'] as const) {
    assert.equal(probeVerdict({ outcome, vramAbsMb: 100 }, null, BUDGET_MB, HEADROOM_MB).decision, 'offload-more')
  }
})

test('probeVerdict: still honors the headroom fit check when nothing is spilling', () => {
  // Comfortably resident but over (budget - headroom) → rejected on headroom, as before.
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: 16000 }, 16000, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision === 'offload-more' && v.reason, 'headroom')
})

test('probeVerdict: unreadable VRAM on a Mac/Intel box behaves exactly as before spill detection', () => {
  // No reading → no spill claimed, no headroom block → the load outcome alone decides.
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: null }, null, BUDGET_MB, HEADROOM_MB).decision, 'fits')
})

// ---- spillImproves: MoE VRAM-spill hill-climb decision (founder-directed, 2026-07-17; extended
// same day to also guard prefill speed) ----------------------------------------------------------

// Founder call 2026-08-07: the default search stops at SPILL_TOLERANCE_MB, and this opt-in
// hill-climb (VRAM_HEADROOM_SPILL_MB) is the sanctioned way to explore past it — so it must use the
// same time-to-answer objective as the rest of the search. It previously required that NEITHER
// generation NOR prefill decrease, which is wrong here: those axes move in OPPOSITE directions when
// spilling, so that rule rejected steps that were genuinely faster overall.
//
// Values are REAL, from the measured curve on the founder's box (16 GB, 200k ctx), converted to a
// 26.5k-token prompt. Time-to-answer improves smoothly down to nCpuMoe=5, then falls off a cliff.
const step = (prefillTps: number, gen: number) => ({ ttftMs: (26500 / prefillTps) * 1000, tps: gen })
const N8 = step(2067.3, 106.0)   // 22.3 s
const N5 = step(2400.4, 114.5)   // 19.8 s
const N3 = step(79.9, 10.1)      // 431.1 s — past the cliff

test('spillImproves: keeps climbing while time-to-answer falls (n=8 → n=5)', () => {
  assert.equal(spillImproves(N8, { outcome: 'ok', ...N5 }), true)
})

test('spillImproves: stops dead at the measured cliff (n=5 → n=3, 19.8s → 431s)', () => {
  assert.equal(spillImproves(N5, { outcome: 'ok', ...N3 }), false)
})

test('spillImproves: a step that trades prefill for generation and WINS is now allowed', () => {
  // The behaviour change. Generation 100→130 but prefill 2000→1900: the old "neither may decrease"
  // rule rejected this outright, yet time-to-answer improves. Rejecting it left real speed on the
  // table, which is why the objective became one combined number.
  const prev = step(2000, 100)
  const cand = step(1900, 130)
  assert.ok(ttfMs(cand)! < ttfMs(prev)!, 'the candidate really is faster overall')
  assert.ok(cand.tps > prev.tps && cand.ttftMs > prev.ttftMs, 'and it really does trade prefill for generation')
  assert.equal(spillImproves(prev, { outcome: 'ok', ...cand }), true)
})

test('spillImproves: an equal step stops the climb — no tie band, keep the safer config', () => {
  assert.equal(spillImproves(N5, { outcome: 'ok', ...N5 }), false)
})

test('spillImproves: a failed spill step (oom/crash/timeout) is never an improvement', () => {
  for (const outcome of ['oom', 'crash', 'timeout'] as const) {
    assert.equal(spillImproves(N5, { outcome, ttftMs: null, tps: null }), false)
  }
})

test('spillImproves: null candidate (benchAt itself returned null) stops the climb', () => {
  assert.equal(spillImproves(N5, null), false)
})

test('spillImproves: an unmeasurable step never climbs, in either direction (fail-safe)', () => {
  // This path trades away the user's configured safety margin, so a step that cannot be SHOWN
  // faster must never be waved through — whether the candidate or the baseline is the blind one.
  assert.equal(spillImproves(N5, { outcome: 'ok', ttftMs: 11040, tps: null }), false)
  assert.equal(spillImproves(N5, { outcome: 'ok', ttftMs: null, tps: 114.5 }), false)
  assert.equal(spillImproves({ ttftMs: null, tps: null }, { outcome: 'ok', ...N5 }), false)
})

// ---- kvSpeedAdvisory: ADR-219 — auto-tune no longer picks the KV type, just notes when a
// nominally-smaller one is available and the result is slow --------------------------------

test('kvSpeedAdvisory: fast result (>=20 tok/s) → no advisory even if a smaller type exists', () => {
  assert.equal(kvSpeedAdvisory(25, 'turbo4', ['f16', 'q8_0', 'q4_0', 'turbo4']), null)
})

test('kvSpeedAdvisory: slow result + a real nominally-smaller type available → advisory names it', () => {
  const msg = kvSpeedAdvisory(10.4, 'turbo4', ['f16', 'q8_0', 'q4_0', 'turbo4'])
  assert.ok(msg)
  assert.match(msg, /turbo4/)
  assert.match(msg, /q4_0/)
})

test('kvSpeedAdvisory: slow result but already at the smallest available type → no advisory', () => {
  assert.equal(kvSpeedAdvisory(5, 'q4_0', ['f16', 'q8_0', 'q4_0']), null)
})

test('kvSpeedAdvisory: NON-turbo current type on a TurboQuant fork must never recommend a turbo type (regression — caught in independent review before merge)', () => {
  // f16/q8_0 are the common case (most users aren't on turbo* to begin with). Turbo types must
  // be excluded from the candidate pool regardless of what the CURRENT type is — a prior version
  // gated the exclusion on the current type already being turbo, so it silently did nothing here
  // and recommended turbo2 (the smallest nominal size) instead of a real standard type.
  const supported = ['f16', 'q8_0', 'q4_0', 'turbo2', 'turbo3', 'turbo4']
  const msgF16 = kvSpeedAdvisory(10, 'f16', supported)
  assert.ok(msgF16)
  assert.match(msgF16, /q4_0|q8_0/)
  assert.doesNotMatch(msgF16, /turbo/)

  const msgQ80 = kvSpeedAdvisory(10, 'q8_0', supported)
  assert.ok(msgQ80)
  assert.match(msgQ80, /q4_0/)
  assert.doesNotMatch(msgQ80, /turbo/)
})

test('kvSpeedAdvisory: unprobed engine (empty kvTypes) → no advisory, nothing to suggest', () => {
  assert.equal(kvSpeedAdvisory(5, 'f16', []), null)
})

test('kvSpeedAdvisory: null tps treated as 0 (slow) — still checks for a smaller type', () => {
  assert.ok(kvSpeedAdvisory(null, 'f16', ['f16', 'q4_0']))
})

// ---- parseRocmVramUsed: AMD live VRAM reading (ADR-217 — the headroom gate was fully inert on
// AMD before this; readGpuVramMb falls back to this when the box has an AMD GPU) ---------------

test('parseRocmVramUsed: single card sums used memory in MB', () => {
  const memJson = JSON.stringify({
    card0: { 'VRAM Total Memory (B)': '25753026560', 'VRAM Total Used Memory (B)': '1234567890' },
  })
  assert.equal(parseRocmVramUsed(memJson), 1235) // 1234567890 / 1e6, rounded
})

test('parseRocmVramUsed: multiple cards are summed, not just the first', () => {
  const memJson = JSON.stringify({
    card0: { 'VRAM Total Used Memory (B)': '1000000000' },
    card1: { 'VRAM Total Used Memory (B)': '2000000000' },
  })
  assert.equal(parseRocmVramUsed(memJson), 3000) // (1e9 + 2e9) / 1e6
})

test('parseRocmVramUsed: a card missing the used-memory key contributes 0, not a throw', () => {
  const memJson = JSON.stringify({
    card0: { 'VRAM Total Used Memory (B)': '1000000000' },
    card1: { 'Some Other Field': 'x' },
  })
  assert.equal(parseRocmVramUsed(memJson), 1000)
})

test('parseRocmVramUsed: zero used memory across every card → null (not 0)', () => {
  const memJson = JSON.stringify({ card0: { 'VRAM Total Used Memory (B)': '0' } })
  assert.equal(parseRocmVramUsed(memJson), null)
})

test('parseRocmVramUsed: malformed JSON → null, never throws', () => {
  assert.equal(parseRocmVramUsed('not json'), null)
  assert.equal(parseRocmVramUsed(''), null)
})

// ---- benchPromptTokens / buildBenchMessages: bench depth tracks the CONFIGURED ctx, uncapped
// (ADR-217 round 2 — a shallow bench measured 26 tok/s while a real 22k-token conversation at the
// same ctx measured 10 tok/s; the founder wants auto-tune to predict the second number) ----------

test('benchPromptTokens: targets 75% of ctx, capped at 32k (ADR-217 round 3)', () => {
  assert.equal(benchPromptTokens(8_192), 6_144) // under the cap — unaffected
  assert.equal(benchPromptTokens(40_000), 30_000) // under the cap — unaffected
  assert.equal(benchPromptTokens(200_000), 32_000) // 150k uncapped measured 3.2 tok/s — worse than real chat, not just slower
  assert.equal(benchPromptTokens(1_000_000), 32_000) // cap holds regardless of how large ctx gets configured
})

test('benchPromptTokens: floors small ctx at 256', () => {
  assert.equal(benchPromptTokens(100), 256)
  assert.equal(benchPromptTokens(0), 256)
})

test('buildBenchMessages: small ctx needs no filler — system + the fixed question only', () => {
  const messages = buildBenchMessages(256) // benchPromptTokens(256) floors to 256 tokens ≈ 1024 chars, under the system prompt's own length
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[messages.length - 1].role, 'user')
  assert.match(messages[messages.length - 1].content, /TCP and UDP/)
})

test('buildBenchMessages: large ctx pads with filler user/assistant pairs to reach depth', () => {
  const shallow = buildBenchMessages(8_192)
  const deep = buildBenchMessages(200_000)
  assert.ok(deep.length > shallow.length, 'a deep target needs more filler turns than a shallow one')
  const totalChars = (msgs: { content: string }[]) => msgs.reduce((n, m) => n + m.content.length, 0)
  assert.ok(totalChars(deep) > totalChars(shallow))
  // Every message role alternates user/assistant between the system prompt and the final question.
  for (let i = 1; i < deep.length - 1; i++) {
    assert.equal(deep[i].role, i % 2 === 1 ? 'user' : 'assistant')
  }
  assert.equal(deep[deep.length - 1].role, 'user')
})

test('buildBenchMessages: deterministic — same ctx always produces the identical message list', () => {
  assert.deepEqual(buildBenchMessages(50_000), buildBenchMessages(50_000))
})
