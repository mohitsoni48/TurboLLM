// Capability-flag extraction from --help output (GitHub #43 regression).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFlags, detectKvTypes, parseEnumList, classifyFlag, extractSpecTypeValues } from './probe'

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

test('detectKvTypes: BeeLlama-shaped fork — kvarn2-8 discovered with ZERO BeeLlama-specific code (generic path)', () => {
  const help =
    `-ctk,  --cache-type-k TYPE              KV cache data type for K\n` +
    `                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1,\n` +
    `                                        kvarn2, kvarn3, kvarn4, kvarn5, kvarn6, kvarn7, kvarn8\n` +
    `                                        (default: f16)\n` +
    `-ctv,  --cache-type-v TYPE              KV cache data type for V\n`
  const kvTypes = detectKvTypes(help, true)
  for (const t of ['kvarn2', 'kvarn3', 'kvarn4', 'kvarn5', 'kvarn6', 'kvarn7', 'kvarn8']) assert.ok(kvTypes.includes(t), `expected ${t} in ${kvTypes}`)
  assert.ok(kvTypes.includes('f16')) // base KNOWN_KV set still present
})

// ---- parseEnumList: generic "allowed values: a, b, c" / "[a|b|c]" extraction --------------

test('parseEnumList: extracts a comma-separated "allowed values:" list, including a wrapped line', () => {
  const block =
    `\n                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1,\n` +
    `                                        kvarn2, kvarn3, kvarn4, kvarn5, kvarn6, kvarn7, kvarn8`
  const values = parseEnumList(block)
  assert.deepEqual(values, ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'kvarn2', 'kvarn3', 'kvarn4', 'kvarn5', 'kvarn6', 'kvarn7', 'kvarn8'])
})

test('parseEnumList: extracts a bracket/pipe list when there is no "allowed values:" phrase', () => {
  assert.deepEqual(parseEnumList('  [none|draft-mtp|nextn]  which speculative mode to use'), ['none', 'draft-mtp', 'nextn'])
})

test('parseEnumList: a single bracketed word is NOT treated as an enum (needs 2+ values)', () => {
  assert.deepEqual(parseEnumList('an experimental [beta] flag'), [])
})

test('parseEnumList: no list of any kind → empty', () => {
  assert.deepEqual(parseEnumList('KV cache data type for K (default: f16)'), [])
})

// ---- classifyFlag: generic per-flag kind detection (enum/boolean/valued) -------------------

test('classifyFlag: BeeLlama-shaped --cache-type-k resolves kvarn2-8 via the generic path (no hardcoding)', () => {
  const help =
    `-ctk,  --cache-type-k TYPE              KV cache data type for K\n` +
    `                                        allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1,\n` +
    `                                        kvarn2, kvarn3, kvarn4, kvarn5, kvarn6, kvarn7, kvarn8\n` +
    `                                        (default: f16)\n` +
    `-ctv,  --cache-type-v TYPE              KV cache data type for V\n`
  const info = classifyFlag('--cache-type-k', help)
  assert.equal(info.kind, 'enum')
  assert.ok(info.enumValues?.includes('kvarn2'))
  assert.ok(info.enumValues?.includes('kvarn8'))
})

test('classifyFlag: a flag with an ALL-CAPS placeholder and no enum list is "valued"', () => {
  const help = `--threads N                            number of threads to use during generation\n`
  assert.deepEqual(classifyFlag('--threads', help), { name: '--threads', kind: 'valued' })
})

test('classifyFlag: a flag with no placeholder (runs straight into lowercase prose) is "boolean"', () => {
  const help = `--jinja                                use jinja templating for the chat template\n`
  assert.deepEqual(classifyFlag('--jinja', help), { name: '--jinja', kind: 'boolean' })
})

test('classifyFlag: ambiguous text (placeholder present but no real enum) degrades to "valued", never throws', () => {
  const help = `--some-flag TYPE   an experimental [beta] flag\n`
  assert.deepEqual(classifyFlag('--some-flag', help), { name: '--some-flag', kind: 'valued' })
})

test('classifyFlag: a flag absent from the help text at all degrades to "valued", never throws', () => {
  assert.deepEqual(classifyFlag('--totally-unknown', 'no mention of it anywhere\n'), { name: '--totally-unknown', kind: 'valued' })
})

// ---- classifyFlag: C1/C2/I3 regression fixtures (final-review findings) -------------------

// The enum-bearing block must come AFTER the flag under test: classifyFlag only ever scans
// FORWARD from its own match, so the earlier shape of this fixture (enum block first) could not
// reproduce the bleed-forward bug at all and passed against the pre-fix code too.
test('classifyFlag: a flag whose block boundary is a FLUSH-LEFT (column 0) next flag, not indented', () => {
  const help =
    `--no-host\n` +
    `--cache-type-k TYPE\n` +
    `                                        allowed values: f32, f16, bf16, turbo4\n` +
    `                                        (default: f16)\n`
  const info = classifyFlag('--no-host', help)
  assert.equal(info.kind, 'boolean')
  assert.equal(info.enumValues, undefined)
})

test('classifyFlag: a next-flag line indented past 8 columns still terminates the PRECEDING flag\'s block (ik_llama.cpp indents 176 real flag lines at column 9)', () => {
  const help =
    `--no-host\n` +
    `         --cache-type-k TYPE\n` +
    `                                        allowed values: f32, f16, bf16, turbo4\n`
  const info = classifyFlag('--no-host', help)
  assert.equal(info.kind, 'boolean')
  assert.equal(info.enumValues, undefined)
})

test('classifyFlag: a multi-alias comma list on one line resolves the REAL trailing placeholder, not "boolean" from the comma after the first alias', () => {
  const help = `-n,    --predict, --n-predict N        number of tokens to predict (default: -1, -1 = infinity)\n`
  assert.deepEqual(classifyFlag('--predict', help), { name: '--predict', kind: 'valued' })
  assert.deepEqual(classifyFlag('--n-predict', help), { name: '--n-predict', kind: 'valued' })
})

test('classifyFlag: a flag that is a literal PREFIX of an earlier, unrelated sibling flag is not classified from the sibling\'s text', () => {
  // Real llama.cpp --help is grouped by section, not sorted, so --chat-template-kwargs really
  // does print before --chat-template.
  const help =
    `--chat-template-kwargs STRING          sets additional params for the json template parser\n` +
    `--chat-template JINJA_TEMPLATE         set custom jinja chat template\n`
  assert.equal(classifyFlag('--chat-template', help).kind, 'valued')
})

test('classifyFlag: a flag named inside ANOTHER flag\'s description prose is not mistaken for its own definition', () => {
  // Real ik_llama.cpp: --in-prefix-bos's description quotes `--in-prefix`, and that mention
  // appears BEFORE the real --in-prefix definition line.
  const help =
    `         --in-prefix-bos          prefix BOS to user inputs, preceding the \`--in-prefix\` string\n` +
    `         --in-prefix STRING       string to prefix user inputs with (default: empty)\n` +
    `         --in-suffix STRING       string to suffix after user inputs with (default: empty)\n`
  assert.equal(classifyFlag('--in-prefix', help).kind, 'valued')
})

test('classifyFlag: a bracket enum written directly after the flag, no "allowed values:" label', () => {
  const help = `--spec-type [none|draft|nextn]         which speculative decoding mode to use\n`
  const info = classifyFlag('--spec-type', help)
  assert.equal(info.kind, 'enum')
  assert.deepEqual(info.enumValues, ['none', 'draft', 'nextn'])
})

test('classifyFlag: a lowercase/symbolic placeholder that is NOT ALL-CAPS is still classified valued, not boolean', () => {
  const help = `--rope-scale <0...100>                 RoPE scaling factor\n`
  const info = classifyFlag('--rope-scale', help)
  assert.equal(info.kind, 'valued')
})

test('classifyFlag: a bare boolean flag at true end-of-line (zero trailing spaces before newline) is still boolean', () => {
  const help = `--no-mmproj\nsome other line\n`
  const info = classifyFlag('--no-mmproj', help)
  assert.equal(info.kind, 'boolean')
})

// ---- extractSpecTypeValues: DFlash never showed up as an option for ik_llama.cpp because its
// --help prints the --spec-type enum on its own continuation line ("types: none, draft,
// dflash, ...") instead of directly after the flag like mainline/beellama/TurboQuant do — the
// old regex only matched the latter form. Fixtures below are the real --help text from each
// engine, captured live. ---------------------------------------------------------------------

test('extractSpecTypeValues: mainline/beellama/TurboQuant comma list directly after the flag', () => {
  const help =
    `--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache\n` +
    `                                        comma-separated list of types of speculative decoding to use (default:\n` +
    `                                        none)\n`
  const values = extractSpecTypeValues(help)
  assert.ok(values.includes('draft-dflash'))
  assert.ok(values.includes('draft-mtp'))
  assert.ok(!values.includes('speculative'), 'must not pick up words from the trailing description prose')
})

test('extractSpecTypeValues: bracket/pipe form (TurboQuant-style)', () => {
  const help = `--spec-type [none|draft|nextn]         which speculative decoding mode to use\n`
  assert.deepEqual(extractSpecTypeValues(help).sort(), ['draft', 'nextn', 'none'])
})

test('extractSpecTypeValues: ik_llama.cpp\'s real --help — enum on its own "types:" continuation line', () => {
  const help =
    `  --spec-type SPEC[:k=v,...]      canonical speculative stage entry; repeat for a supported two-stage chain.\n` +
    `                                  types: none, draft, dflash, dspark, mtp, ngram-cache, ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod, suffix\n` +
    `                                  examples: --spec-type mtp:n_max=1,p_min=0.0\n` +
    `                                            --model-draft draft.gguf --spec-type dflash:n_max=4\n` +
    `                                            --spec-type ngram-mod:n_max=64,n_min=2,ngram_size_n=8 --spec-type mtp:n_max=1,p_min=0.0\n` +
    `                                            --spec-type "suffix:n_max=16,n_min=2,suffix_min_match_len=5,suffix_max_depth=64,suffix_corpus='/tmp/spec,type-corpus.json'"\n`
  const values = extractSpecTypeValues(help)
  assert.deepEqual(
    values.sort(),
    ['dflash', 'draft', 'dspark', 'mtp', 'ngram-cache', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-simple', 'none', 'suffix'],
  )
})

test('extractSpecTypeValues: an unrelated "types of X" mention elsewhere does not false-positive', () => {
  const help = `some flag         does something with types of widgets, not speculative decoding\n`
  assert.deepEqual(extractSpecTypeValues(help), [])
})
