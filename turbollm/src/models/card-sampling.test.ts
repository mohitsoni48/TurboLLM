import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCardSampling,
  clampCardSampling,
  hasAnySampling,
  parseGenerationParams,
  parseLlmSampling,
  buildCardExtractionPrompt,
  relevantCardExcerpt,
  type CardSampling,
} from './card-sampling'

// ─── generation-params sidecar (structured JSON) ────────────────────────────

test('parseGenerationParams: real unsloth/gpt-oss-120b-GGUF `params` file', () => {
  const raw = JSON.stringify({
    stop: ['<|endoftext|>', '<|return|>'],
    temperature: 1.0,
    min_p: 0.0,
    top_k: 0,
    top_p: 1.0,
  })
  // min_p and top_k are legitimately 0 here — not "absent", a real recommendation.
  assert.deepEqual(parseGenerationParams(raw), { temp: 1.0, topP: 1.0, topK: 0, minP: 0 })
})

test('parseGenerationParams: unknown/extra keys are ignored, known ones still parsed', () => {
  const raw = JSON.stringify({ temperature: 0.6, repetition_penalty: 1.1, max_new_tokens: 512 })
  assert.deepEqual(parseGenerationParams(raw), { temp: 0.6 })
})

test('parseGenerationParams: out-of-range values are dropped (same gate as the heuristic)', () => {
  const raw = JSON.stringify({ temperature: 5, top_p: 0.9 })
  assert.deepEqual(parseGenerationParams(raw), { topP: 0.9 })
})

test('parseGenerationParams: empty string → {}', () => {
  assert.deepEqual(parseGenerationParams(''), {})
})

test('parseGenerationParams: invalid JSON → {} (never throws)', () => {
  assert.deepEqual(parseGenerationParams('not json'), {})
})

test('parseGenerationParams: JSON array (not an object) → {}', () => {
  assert.deepEqual(parseGenerationParams('[1,2,3]'), {})
})

// ─── heuristic parse ─────────────────────────────────────────────────────────

test('parseCardSampling: inline recommended-settings line', () => {
  const card = 'We recommend using temperature=0.6, top_p=0.95, top_k=20, min_p=0 for best results.'
  assert.deepEqual(parseCardSampling(card), { temp: 0.6, topP: 0.95, topK: 20, minP: 0 })
})

test('parseCardSampling: markdown table (Qwen-style)', () => {
  const card = [
    '## Best Practices',
    '| Setting | Value |',
    '|---|---|',
    '| Temperature | 0.7 |',
    '| Top-P | 0.8 |',
    '| Top-K | 20 |',
    '| Min-P | 0 |',
  ].join('\n')
  assert.deepEqual(parseCardSampling(card), { temp: 0.7, topP: 0.8, topK: 20, minP: 0 })
})

test('parseCardSampling: bold/colon and leading-dot decimals', () => {
  const card = '**Temperature:** 0.8\n**top_p:** .95\n**Top K**: 40'
  assert.deepEqual(parseCardSampling(card), { temp: 0.8, topP: 0.95, topK: 40 })
})

test('parseCardSampling: partial card (only some knobs stated)', () => {
  // Only temperature is stated in a parseable `name <sep> value` form; the rest are absent.
  assert.deepEqual(parseCardSampling('Recommended: temperature 0.5. Leave other settings at default.'), { temp: 0.5 })
})

test('parseCardSampling: prose-only with no numbers → empty (LLM fallback territory)', () => {
  assert.deepEqual(parseCardSampling('Use a low temperature and a high top-p for creative output.'), {})
})

test('parseCardSampling: out-of-range values are dropped, not clamped', () => {
  // temp 5 (>2), top_p 1.5 (>1) are mis-parses / non-recommendations → dropped; top_k 40 kept.
  assert.deepEqual(parseCardSampling('temperature: 5  top_p: 1.5  top_k: 40'), { topK: 40 })
})

test('parseCardSampling: does not match lookalike words (laptop / attempt / temporary)', () => {
  assert.deepEqual(parseCardSampling('On a laptop, the first attempt is temporary; see section 3.'), {})
})

test('parseCardSampling: empty / missing card → empty', () => {
  assert.deepEqual(parseCardSampling(''), {})
})

test('parseCardSampling: ignores values inside fenced code blocks (usage demos ≠ recommendations)', () => {
  // Verified live against Mistral-7B: `temperature=0` lives in a usage snippet, not a
  // recommendation — it must NOT be extracted (would fall through to the LLM fallback).
  const card = [
    'Here is how to use it:',
    '```python',
    'pipe(messages, temperature=0, top_p=1.0)',
    '```',
    'That is all.',
  ].join('\n')
  assert.deepEqual(parseCardSampling(card), {})
})

test('parseCardSampling: real recommendation in a table survives alongside a code example', () => {
  const card = [
    '| Temperature | 0.6 |',
    '| Top-P | 0.95 |',
    '```python',
    'generate(temperature=0.0)  # demo only',
    '```',
  ].join('\n')
  assert.deepEqual(parseCardSampling(card), { temp: 0.6, topP: 0.95 })
})

test('parseCardSampling: min_p of 0 is kept (presence, not truthiness)', () => {
  const r = parseCardSampling('min_p = 0')
  assert.equal(r.minP, 0)
  assert.equal(hasAnySampling(r), true)
})

// ─── clamp ───────────────────────────────────────────────────────────────────

test('clampCardSampling: rounds top_k, drops out-of-range + non-finite', () => {
  const dirty: CardSampling = { temp: 0.6, topP: 2, topK: 19.6, minP: Number.NaN }
  // topP 2 (>1) dropped; topK rounded to 20; minP NaN dropped; temp kept.
  assert.deepEqual(clampCardSampling(dirty), { temp: 0.6, topK: 20 })
})

// ─── hasAnySampling ──────────────────────────────────────────────────────────

test('hasAnySampling: false on empty, true on any present (incl. 0)', () => {
  assert.equal(hasAnySampling({}), false)
  assert.equal(hasAnySampling({ minP: 0 }), true)
  assert.equal(hasAnySampling({ temp: 0.7 }), true)
})

// ─── LLM fallback JSON parse ─────────────────────────────────────────────────

test('parseLlmSampling: plain JSON object', () => {
  const r = parseLlmSampling('{"temperature":0.6,"top_k":20,"top_p":0.95,"min_p":0.05}')
  assert.deepEqual(r, { temp: 0.6, topK: 20, topP: 0.95, minP: 0.05 })
})

test('parseLlmSampling: fenced JSON with surrounding prose', () => {
  const text = 'Here are the settings:\n```json\n{"temperature": 0.7, "top_p": 0.8, "top_k": null, "min_p": null}\n```\nHope this helps.'
  assert.deepEqual(parseLlmSampling(text), { temp: 0.7, topP: 0.8 })
})

test('parseLlmSampling: numeric strings coerced; out-of-range dropped', () => {
  const r = parseLlmSampling('{"temperature":"0.5","top_k":"40","top_p":3,"min_p":null}')
  assert.deepEqual(r, { temp: 0.5, topK: 40 }) // top_p 3 dropped, min_p null absent
})

test('parseLlmSampling: non-JSON / garbage → empty, never throws', () => {
  assert.deepEqual(parseLlmSampling('I could not find any recommended settings.'), {})
  assert.deepEqual(parseLlmSampling('{ not valid json '), {})
  assert.deepEqual(parseLlmSampling(''), {})
})

// ─── relevant excerpt (long-card windowing) ──────────────────────────────────

test('relevantCardExcerpt: short card returned whole', () => {
  const card = 'A short card with temperature: 0.6.'
  assert.equal(relevantCardExcerpt(card, 8000), card)
})

test('relevantCardExcerpt: long card centers the window on a back-half settings cue', () => {
  // Mimics the unsloth case: recommendation buried ~16k chars into a long card.
  const filler = 'lorem ipsum '.repeat(1400) // ~16.8k chars, no cue
  const card = filler + '\n## Recommended Settings\ntemperature: 1.0, top_p: 0.95, top_k: 64\n' + 'tail '.repeat(400)
  const ex = relevantCardExcerpt(card, 8000)
  assert.ok(ex.length <= 8000)
  assert.ok(ex.includes('temperature: 1.0'), 'excerpt must include the back-half recommendation')
  assert.ok(ex.includes('Recommended Settings'), 'window should include the surrounding heading')
})

test('relevantCardExcerpt: prefers a "recommended settings" heading over an early bare param', () => {
  // An early bare `temperature 0` (a demo) sits in the head; the real recommendation block is
  // deep in the card. The window should center on the heading, not the early demo mention.
  const head = 'Run with temperature 0 for the demo.\n' + 'lorem '.repeat(2000) // ~12k chars
  const card = head + '\n## Recommended Settings\ntemperature: 1.0, top_p: 0.95\n' + 'tail '.repeat(400)
  const ex = relevantCardExcerpt(card, 8000)
  assert.ok(ex.includes('Recommended Settings'), 'window centers on the recommendation heading')
  assert.ok(ex.includes('temperature: 1.0'))
  assert.ok(!ex.includes('for the demo'), 'the early demo mention is outside the window')
})

test('relevantCardExcerpt: cue already in the head → head window', () => {
  const card = 'temperature: 0.6 at the very top\n' + 'x'.repeat(20000)
  const ex = relevantCardExcerpt(card, 8000)
  assert.equal(ex, card.slice(0, 8000))
  assert.ok(ex.includes('temperature: 0.6'))
})

// ─── prompt builder ──────────────────────────────────────────────────────────

test('buildCardExtractionPrompt: embeds (capped) card + asks for JSON-only', () => {
  const prompt = buildCardExtractionPrompt('x'.repeat(20000))
  assert.match(prompt, /ONLY a single JSON object/)
  assert.match(prompt, /"temperature": number\|null/)
  // card capped at 8000 chars, so the whole prompt stays well under the full 20k input.
  assert.ok(prompt.length < 9000)
})
