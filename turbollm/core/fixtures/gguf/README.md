# GGUF fixtures

Language-neutral fixtures for the GGUF header parser. Every runtime (the Rust crate `turbollm-gguf`, the napi
addon, the Kotlin bindings) must reproduce them exactly.

**The TS oracle is deleted; goldens are the spec.** The TypeScript parser (`src/gguf/`) that wrote them and its
writer `core/scripts/gguf-goldens.ts` were deleted with the switch to the native core (rust-core T22). A golden
changes only when the parser's behaviour changes on purpose, re-blessed from Rust in review.

## Layout

```
core/fixtures/gguf/
  README.md
  corpus.json               real-header corpus manifest (T4)
  hf-listing.json           .gguf names of each corpus HF repo at its pinned revision (quant-name input)
  crafted/.gitignore        "!*.gguf" (the repo ignores *.gguf globally)
  crafted/<id>.gguf         committed; each at most 64 KiB
  golden/<id>.json          { "parse": <exact JSON text>, "cutShort": [[size, bool], ...] }
  golden/quant-names.json   [[fileName, resultOrNull], ...]
  golden/<id>.ts.json       declared divergences only: the TypeScript oracle's own output
  divergences.json          { "<id>": "D-n", ... }
  .corpus-cache/            gitignored; fetched corpus slices (T4)
```

## Formats

- **`parse` is a JSON string** holding the exact compact text the TypeScript oracle produced, so a runtime compares
  bytes without re-serialising the golden: `JSON.stringify(result)` for a success, or
  `JSON.stringify({ error: { code, message } })` for a `GgufError`. The oracle is `parseGgufAsync(path, maxRead)`
  (the daemon's path); the synchronous `parseGguf` is never an oracle.
- **`cutShort`** pairs are `ggufCutShort(<this fixture's file>, size)`. Every crafted golden holds at least the
  file's own size.
- **Generated fixtures** (above the 64 KiB cap) are not committed. Their golden adds
  `"generated": { "recipe", "args", "size", "sha256" }` and, where the test used a read cap, `"maxRead"`.
  A runtime rebuilds the bytes from the recipe (the Rust ports are in
  `crates/turbollm-gguf/tests/support/builders.rs`), must hit the same `sha256`, then compares. Recipes: `big-vocab(tokens, merges)`,
  `huge-description(length)`, `long-name(length)`.
- **`quant-names.json`**: `null` where the TypeScript `quantFromName` returns `"?"`.
- **Declared divergences** (architecture 3.3): `golden/<id>.json` is the expected Rust output and
  `golden/<id>.ts.json` the raw TypeScript output. D-1: each `u32` field and each `headCountKvPerLayer`
  element is truncated, then clamped to `[0, 4294967295]`. D-2: `dataEnd` is recomputed with exact integers.

## Real-header corpus

`corpus.json` is `[{ "id", "repo", "revision", "file", "bytes", "sha256", "fileSize" }]`: a pinned prefix of a real,
ungated GGUF. `bytes` is the smallest 64 KiB-rounded prefix (capped at `fileSize`) the TypeScript oracle parsed to
the same result as a longer prefix; `revision` is a full commit sha (`github:<owner>/<repo>` entries are served by
raw.githubusercontent.com, every other repo by Hugging Face). Slices are fetched by HTTP Range into the
gitignored `.corpus-cache/` and never committed; no token is ever sent.

```
node core/scripts/fetch-gguf-corpus.mjs                    # every entry, sha256-verified; cached good slices are skipped
node core/scripts/fetch-gguf-corpus.mjs --entry <id>       # one entry
node core/scripts/fetch-gguf-corpus.mjs --snapshot-listing # rewrite hf-listing.json from the pinned revisions
```

A corpus golden records `cutShort` at `fileSize` and at `bytes`. A new corpus entry and its golden are written
by hand and reviewed as a spec change: the mode that pinned entries ran the TypeScript oracle and is gone.

## Regenerating

The TS oracle is deleted; goldens are the spec. Nothing regenerates them. They are checked by:

```
cargo xtask goldens-check                       # from core/: the folder is complete and within its rules
cargo test -p turbollm-gguf                     # from core/: Rust reproduces every golden byte for byte
npx tsx --test src/native/gguf.golden.test.ts   # from turbollm/: the napi facade does too
```

## The 33 `gguf.test.ts` cases mapped to fixtures

Legend: **C** crafted file + golden; **Q** rows in `quant-names.json`; **G** generated fixture; **B** Rust
budget test (`crates/turbollm-gguf/tests/budget.rs`). Line numbers are the deleted `src/gguf/gguf.test.ts` at
`0ad9f454`.

| # | Line | Test | Fixture(s) |
|---|---|---|---|
| 1 | 65 | headDim reads attention.key_length directly | C `headdim-key-length` |
| 2 | 81 | headDim falls back to value_length | C `headdim-value-length-fallback` |
| 3 | 93 | headDim is 0 when neither field is declared | C `headdim-absent` |
| 4 | 109 | hybrid SSM, Qwen3.6-27B arch qwen35 | C `hybrid-ssm-qwen35` |
| 5 | 143 | hybrid SSM without a declared layout (Qwen3-Coder-Next) | C `hybrid-ssm-undeclared` |
| 6 | 165 | SWA with per-layer head_count_kv array (Gemma-4-26B-A4B) | C `swa-per-layer-kv` |
| 7 | 203 | SWA with scalar head_count_kv (Gemma-4-E4B) | C `swa-scalar-kv` |
| 8 | 227 | headDimSwa falls back to value_length_swa | C `headdim-swa-value-fallback` |
| 9 | 239 | key_length_swa does not leak into headDim | C `key-length-swa-no-leak` |
| 10 | 254 | scalar sliding_window_pattern degrades to [] | C `swa-scalar-pattern` |
| 11 | 283 | plain dense model: no attention-layout metadata | C `dense-no-layout` |
| 12 | 320 | chat_template with a reasoning_effort branch | C `template-reasoning-effort` |
| 13 | 334 | chat_template without reasoning_effort | C `template-no-reasoning-effort` |
| 14 | 348 | no chat_template | C `template-absent` |
| 15 | 362 | storage-format word in general.name treated as absent | C `bogus-name-safetensors` |
| 16 | 374 | general.name guard: case-insensitive, other container words | C one per name the test uses, `bogus-name-<word>`, plus `bogus-name-upper` |
| 17 | 382 | a real name containing a format word as a substring survives | C `name-contains-format-word` |
| 18 | 391 | quantFromName: standard llama.cpp tokens | Q every name in the test |
| 19 | 397 | quantFromName: APEX tiers | Q every name in the test |
| 20 | 412 | quantFromName falls back to "?" | Q those names with expected `null` (the facade maps `null` to `"?"`) |
| 21 | 421 | no quant read out of ordinary filename text | Q every name in the test |
| 22 | 429 | the LAST anchored match wins | Q every name in the test |
| 23 | 436 | split-file and dot-separated tokens | Q every name in the test |
| 24 | 454 | dataEnd after aligned tensor infos | C `data-end-aligned` |
| 25 | 472 | dataEnd 0 for an unknown tensor type | C `data-end-unknown-type` |
| 26 | 479 | ggufCutShort: shorter than its tensors / cut inside tensor infos / whole | C `cut-short-tensors`, with a `cutShort` pair for every size the test checks |
| 27 | 491 | vocab-only GGUF is not cut short; cut inside its KV it is | C `vocab-only-unaligned`, `cutShort` = `[[len,false],[len-3,true]]` (the `len-3` file is its own crafted file `vocab-only-cut`) |
| 28 | 543 | async = sync on a vocab-heavy GGUF larger than the first read | G `gen-big-vocab` (recipe `big-vocab`, args `[60000, 90000]`); plus T4 asserts at least one corpus entry has `bytes` > 4 MiB |
| 29 | 556 | async = sync on 5 small fixtures | C `async-qwen3`, `async-gemma3-arrays`, `async-tensors`, `async-alignment-256`, `async-vocab-only` |
| 30 | 572 | async fails with the same codes | C `err-not-gguf-html`, `err-truncated-in-vocab` (`bigVocabGguf(2000, 2000)` cut to 40,000 bytes), `err-bad-version-9` |
| 31 | 608 | a huge string value is skipped by seeking | G `gen-huge-description` (40 MiB `general.description`); B requested bytes <= 16 MiB |
| 32 | 619 | header needing more than the cap: too_large, reads <= cap | G `gen-long-name` (3 MiB `general.name`, `maxRead` 1,048,576); B requested bytes <= the cap |
| 33 | 632 | a declared 20 GB string in a short file | C `declared-huge-string` (about 100 bytes); B requested bytes <= 16 MiB |

Fixtures added beside the table to mirror every assertion of a row: `data-end-aligned-256` (row 24's
`general.alignment` 256 file), `cut-short-tensors-short` and `cut-short-in-tensor-info` (row 26's cut files
as files of their own), `cut-short-not-gguf` (row 26's HTML file).

Beyond the 33 (architecture 3.1): truncation inside magic, version, KV block and tensor infos (`trunc-*`);
versions 1-4 (`version-<n>`); every value type 0-12 in a skipped key (`type-<n>`); `nested-array`;
`array-as-scalar`; `unknown-type-13`, `unknown-type-255`; `string-as-number`, `number-as-string`;
`general.file_type` as `""`, `"15"`, `"0x0F"`, `-0`, `1.5` (`ftype-*`); alignment 0, 3, 2^32 and a string
(`align-*`); `ndims-5`; `tensor-type-unknown`; `too-large-string`; `invalid-utf8-key`, `invalid-utf8-value`;
`bogus-name-nonascii`; `duplicate-key-last-wins`; the declared divergences `d1-*` and `d2-offset-above-2p53`.
