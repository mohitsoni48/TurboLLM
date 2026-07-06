// Capability-flag extraction from --help output (GitHub #43 regression).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFlags } from './probe'

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
