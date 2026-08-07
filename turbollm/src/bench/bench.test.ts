import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickKvQuants, betterBySpeed, ttfMs, TTF_OUTPUT_TOKENS, probeVerdict, spillImproves, kvSpeedAdvisory, parseRocmVramUsed, parseRocmGttUsed, benchPromptTokens, buildBenchMessages } from './bench'
import { SPILL_TOLERANCE_MB } from './spill'

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
// Spill is MEASURED per probe (host-memory delta across the load), not derived from a slope.
// Values are real: dedicated VRAM and the OS shared-memory reading at each nCpuMoe on the founder's
// box (RTX 5070 Ti 16303 MiB, Qwen3.6-35B-A3B IQ3_XXS @ ctx 200704, 2026-08-07), with the 285.3 MiB
// no-spill baseline subtracted.
const MEASURED: Record<number, { vram: number; spill: number | null }> = {
  20: { vram: 13640.9, spill: 0 },
  18: { vram: 14164.9, spill: 0 },
  16: { vram: 14688.9, spill: 0 },
  14: { vram: 15212.9, spill: 0 },
  13: { vram: 15474.9, spill: 0 },
  12: { vram: 15736.9, spill: 0 },
  11: { vram: 15813.2, spill: 186 },
  10: { vram: 15819.7, spill: 442 },
  9: { vram: 15826.2, spill: 698 },
  4: { vram: 15790.0, spill: null }, // vram from the bench's own probe; spill not measured at this point
  3: { vram: 15823.2, spill: 2210 },
  1: { vram: 15782.0, spill: null },
  0: { vram: 15828.6, spill: 2914 },
}
const BUDGET_MB = 16303
const HEADROOM_MB = 375 // the founder's configured value

/** Replays the binary search using the REAL probeVerdict for every decision. `withSpill: false`
 *  passes a null reading — exactly how a machine with no spill telemetry behaves. */
function runSearch(maxN: number, withSpill: boolean): number | null {
  let lo = 0, hi = maxN, bestN: number | null = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const m = MEASURED[mid]
    if (!m) throw new Error(`test gap: no measurement for nCpuMoe=${mid}`)
    const v = probeVerdict({ outcome: 'ok', vramAbsMb: m.vram, spillMb: withSpill ? m.spill : null }, BUDGET_MB, HEADROOM_MB)
    if (v.decision === 'fits') { bestN = mid; hi = mid - 1 } else { lo = mid + 1 }
  }
  return bestN
}

test('search stops at the measured spill allowance (nCpuMoe=10)', () => {
  // n=9 spills 698 MiB — past the 512 allowance — so it is rejected. n=10 spills 442 (under) and
  // leaves 483 MiB free (over the 375 headroom), so it is accepted. No calibration involved.
  assert.equal(runSearch(40, true), 10)
})

test('REGRESSION: with no spill reading the same search walks to nCpuMoe=0 — the reported bug', () => {
  // Every probe from 9 downward reads BELOW the 15928 MiB fit line (16303-375), so the fit check
  // alone calls each one a clean fit and the search keeps taking GPU residency it never gets.
  assert.equal(runSearch(40, false), 0)
})

test('probeVerdict: spill is checked BEFORE the fit test, so the reported reason is the real one', () => {
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: MEASURED[9].vram, spillMb: 698 }, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision === 'offload-more' && v.reason, 'spill')
  assert.equal(v.decision === 'offload-more' && Math.round(v.shortfallMb ?? 0), 698)
})

test('probeVerdict: spill UNDER the allowance is accepted when free VRAM clears headroom', () => {
  // n=11: 186 MiB spill (under 512) with 490 MiB free (over 375) — a legitimate candidate. The
  // window rule means free VRAM above headroom+allowance is a signal to keep searching, not a floor.
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: MEASURED[11].vram, spillMb: 186 }, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision, 'fits')
})

test('probeVerdict: free VRAM below the configured headroom is rejected', () => {
  const v = probeVerdict({ outcome: 'ok', vramAbsMb: 16000, spillMb: 0 }, BUDGET_MB, HEADROOM_MB)
  assert.equal(v.decision === 'offload-more' && v.reason, 'headroom')
})

test('probeVerdict: a hard OOM outranks everything', () => {
  assert.deepEqual(
    probeVerdict({ outcome: 'oom', vramAbsMb: null, spillMb: null }, BUDGET_MB, HEADROOM_MB),
    { decision: 'offload-more', reason: 'oom' },
  )
})

test('probeVerdict: crash/timeout are treated as memory pressure, not as a fit', () => {
  for (const outcome of ['crash', 'timeout'] as const) {
    assert.equal(probeVerdict({ outcome, vramAbsMb: 100, spillMb: 0 }, BUDGET_MB, HEADROOM_MB).decision, 'offload-more')
  }
})

test('probeVerdict: no spill telemetry (Metal, or a localized Windows) behaves as before', () => {
  // Fails OPEN — an unavailable reading must never be reported as a spill, or such a machine gets
  // driven to maximum CPU offload for no reason.
  assert.equal(probeVerdict({ outcome: 'ok', vramAbsMb: 15000, spillMb: null }, BUDGET_MB, HEADROOM_MB).decision, 'fits')
})

test('the measured signal separates fitting from spilling across a 4x model-size range', () => {
  // Matrix run 2026-08-07: six models, 9.4-60.5 GB, on a 16.3 GB card. No-spill baselines cluster
  // tightly (157-198 MiB) regardless of model size; real spill is an order of magnitude away
  // (3199-6343 MiB). That gap is why the 512 MiB allowance is not sensitive to exactly where in it
  // the threshold sits, and why no calibration is needed to tell the two apart.
  const fits = [177, 181, 159, 198, 158, 161]
  const spills = [3199.5, 3647.5, 6343.5]
  assert.ok(Math.max(...fits) < SPILL_TOLERANCE_MB, 'every no-spill reading sits under the allowance')
  assert.ok(Math.min(...spills) > SPILL_TOLERANCE_MB * 6, 'every real spill sits far above it')
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

// ---- parseRocmGttUsed: AMD's host-backed memory, the ROCm counterpart of the WDDM shared counter

test('parseRocmGttUsed: sums host-backed GTT across cards', () => {
  const j = JSON.stringify({
    card0: { 'GTT Total Used Memory (B)': '1000000000' },
    card1: { 'GTT Total Used Memory (B)': '500000000' },
  })
  assert.equal(parseRocmGttUsed(j), 1500)
})

test('parseRocmGttUsed: GTT and VRAM are different fields and must not be conflated', () => {
  // On a DISCRETE card GTT is host RAM reached over PCIe — counting it as VRAM would over-report
  // residency, which is why parseRocmVramUsed reads only the VRAM field. Same payload, two answers.
  const j = JSON.stringify({
    card0: { 'VRAM Total Used Memory (B)': '8000000000', 'GTT Total Used Memory (B)': '2000000000' },
  })
  assert.equal(parseRocmVramUsed(j), 8000)
  assert.equal(parseRocmGttUsed(j), 2000)
})

test('parseRocmGttUsed: zero GTT is 0, not null — "nothing spilled" is a real answer', () => {
  // Deliberately unlike parseRocmVramUsed, where 0 used VRAM means the reading failed. Here 0 is
  // the healthy case and must be reported as such, or every fitting config would look unmeasured.
  assert.equal(parseRocmGttUsed(JSON.stringify({ card0: { 'GTT Total Used Memory (B)': '0' } })), 0)
})

test('parseRocmGttUsed: malformed JSON → null, never throws', () => {
  assert.equal(parseRocmGttUsed('not json at all'), null)
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
