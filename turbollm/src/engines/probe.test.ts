// Capability-flag extraction from --help output (GitHub #43 regression).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFlags, detectKvTypes } from './probe'

test('captures a normally-documented flag', () => {
  const help = `--cache-type-k TYPE     KV cache data type for K\n--parallel N            number of parallel sequences\n`
  const flags = extractFlags(help)
  assert.ok(flags.includes('--cache-type-k'))
  assert.ok(flags.includes('--parallel'))
})

test('excludes flags only mentioned in a "has been removed" notice', () => {
  const help =
    `--draft, --draft-n, --draft-max N      the argument has been removed. use --spec-draft-n-max or\n` +
    `                                        --spec-ngram-mod-n-max\n` +
    `                                        (env: LLAMA_ARG_DRAFT_MAX)\n` +
    `--draft-min, --draft-n-min N          the argument has been removed. use --spec-draft-n-min or --spec-ngram-mod-n-min\n` +
    `--spec-draft-n-max N                   number of tokens to draft for speculative decoding (default: 3)\n` +
    `--spec-draft-n-min N                   minimum number of draft tokens to use for speculative decoding (default: 0)\n`
  const flags = extractFlags(help)
  assert.ok(!flags.includes('--draft-max'), '--draft-max should not be reported as supported')
  assert.ok(!flags.includes('--draft-min'), '--draft-min should not be reported as supported')
  assert.ok(!flags.includes('--draft'))
  assert.ok(!flags.includes('--draft-n'))
  assert.ok(flags.includes('--spec-draft-n-max'), 'the real successor flag must still be captured')
  assert.ok(flags.includes('--spec-draft-n-min'), 'the real successor flag must still be captured')
})

test('a flag genuinely supported elsewhere is captured even if also named inside a removal notice', () => {
  const help =
    `--mtp-head FNAME                       the argument has been removed. use --model-draft instead\n` +
    `--mtp-head FNAME                       path to the MTP head GGUF\n`
  const flags = extractFlags(help)
  assert.ok(flags.includes('--mtp-head'))
})

// ---- detectKvTypes: turbo2/3/4 detection scoped to --cache-type-k's own help block, not a
// whole-document "turbo" substring search (a real false-positive bug — see probe.ts) ----------

test('detectKvTypes: TurboQuant fork — turbo2/3/4 genuinely listed in --cache-type-k\'s allowed values', () => {
  const help =
    `-ctk,  --cache-type-k TYPE              KV cache data type for K\n` +
    `                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1,\n` +
    `                                        turbo2, turbo3, turbo4\n` +
    `                                        (default: f16)\n` +
    `-ctv,  --cache-type-v TYPE              KV cache data type for V\n`
  const kvTypes = detectKvTypes(help, true)
  assert.ok(kvTypes.includes('turbo2'))
  assert.ok(kvTypes.includes('turbo3'))
  assert.ok(kvTypes.includes('turbo4'))
  assert.ok(kvTypes.includes('f16')) // base KNOWN_KV set still present
})

test('detectKvTypes: ik_llama.cpp — mentions "turbo" nowhere near --cache-type-k, must NOT claim turbo support (the regression this fix targets)', () => {
  const help =
    `  -ctk,  --cache-type-k TYPE      KV cache data type for K (default: f16)\n` +
    `  -ictk, --indexer-cache-type-k TYPE\n` +
    `                                  indexer K-cache data type (default: f16)\n` +
    `  -ctv,  --cache-type-v TYPE      KV cache data type for V (default: f16)\n` +
    `some unrelated later line mentioning turbo boost or a defer-experts turbo scheduler\n`
  const kvTypes = detectKvTypes(help, true)
  assert.ok(!kvTypes.includes('turbo2'))
  assert.ok(!kvTypes.includes('turbo3'))
  assert.ok(!kvTypes.includes('turbo4'))
})

test('detectKvTypes: no --cache-type-k flag at all → f16-only, unprobed-safe default', () => {
  const kvTypes = detectKvTypes('--parallel N   number of parallel sequences\n', false)
  assert.deepEqual(kvTypes, ['f16'])
})

test('detectKvTypes: -draft/-first/-last sibling flags never confused for the main --cache-type-k enum', () => {
  const help =
    `--cache-type-k-draft TYPE   KV cache data type for K for the draft model, includes turbo4 talk unrelated\n` +
    `--cache-type-k TYPE         KV cache data type for K (default: f16)\n`
  const kvTypes = detectKvTypes(help, true)
  assert.ok(!kvTypes.includes('turbo4'), 'the -draft flag\'s text must not leak turbo4 into the main enum')
})
