import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickKvQuants, betterBySpeed, kvSpeedAdvisory, parseRocmVramUsed, benchPromptTokens, buildBenchMessages } from './bench'

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

// ---- betterBySpeed: output t/s primary, prefill the tie-break ---------------

test('betterBySpeed: clearly higher generation t/s wins', () => {
  assert.equal(betterBySpeed({ tps: 75, prefillTps: 100 }, { tps: 60, prefillTps: 999 }), true)
  assert.equal(betterBySpeed({ tps: 60, prefillTps: 999 }, { tps: 75, prefillTps: 100 }), false)
})

test('betterBySpeed: within 5% on generation → faster prefill breaks the tie', () => {
  // 72 vs 73 is a ~1.4% gap → tie → prefill decides.
  assert.equal(betterBySpeed({ tps: 72, prefillTps: 900 }, { tps: 73, prefillTps: 800 }), true)
  assert.equal(betterBySpeed({ tps: 72, prefillTps: 700 }, { tps: 73, prefillTps: 800 }), false)
})

test('betterBySpeed: a >5% generation deficit is NOT rescued by prefill', () => {
  // 35B reality: turbo4 has faster prefill but ~17% slower generation than q8_0 → q8_0 wins.
  const turbo4 = { tps: 60.3, prefillTps: 983 }
  const q8_0 = { tps: 72.3, prefillTps: 892 }
  assert.equal(betterBySpeed(turbo4, q8_0), false)
  assert.equal(betterBySpeed(q8_0, turbo4), true)
})

test('betterBySpeed: 27B reality — turbo4 wins on both', () => {
  const turbo4 = { tps: 24.6, prefillTps: 1288 }
  const q8_0 = { tps: 10.8, prefillTps: 846 }
  assert.equal(betterBySpeed(turbo4, q8_0), true)
})

test('betterBySpeed: null / zero handling', () => {
  assert.equal(betterBySpeed({ tps: 10, prefillTps: null }, { tps: 0, prefillTps: null }), true)
  assert.equal(betterBySpeed({ tps: null, prefillTps: null }, { tps: null, prefillTps: null }), false)
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
