# Dual-GPU reference configs — real user-set configurations to beat

Auto-tune's job is to find, on its own, a configuration at least as good as what a
knowledgeable user would set by hand. These are the hand-set configs we are measured against.
Companion to `DUAL-GPU-AUTOTUNE-REQUIREMENT.md` and `DUAL-GPU-BUGS.md`.

---

## REF-1 · Qwen3.8-27B-UD-Q6_K on 2× RTX 5060 Ti (32 GB total) — **68.33 tok/s**

Posted by a user. This is a *hand-written* `llama-server` command line, not an auto-tune result.

```
--split-mode tensor
--spec-type draft-mtp,ngram-mod
--spec-draft-n-max 2
-c 100000
--cache-type-k q8_0
--cache-type-v q8_0
--flash-attn on
--batch-size 8869
--ubatch-size 531
-ngl 105
-t 8
--fit off
```

Reported result: **68.33 tok/s generation**, 80.04% draft acceptance, 2.77 average draft length.

### What this config actually tells us — each line is a lever auto-tune does or doesn't have

| Lever | Auto-tune today | Notes |
|---|---|---|
| `--split-mode tensor` | ❌ **never tried** | `pickSplitStrategies` only emits `{single-GPU, layer-split}` — see **BUG-6**. This is the single biggest structural gap: a layer split is a sequential pipeline, `tensor`/`row` is the only mode where both cards work the same layer at once. |
| `--spec-type draft-mtp,ngram-mod` | ❌ not a tuned knob | 80% draft acceptance at 2.77 tokens/forward-pass is a large share of the 68 tok/s. Speculative decoding is a *multiplier* on decode, independent of split geometry. |
| `-ngl 105` (all layers) | ✅ probe-driven | Auto-tune searches this and lands on all-resident when it fits. |
| `--cache-type-k/v q8_0` | ⚠️ user-selected | ADR-219 removed the KV sweep; auto-tune runs whatever KV the user picked. ADR-379 fixed the gate that judged a *different* KV than the one that would run. |
| `--flash-attn on` | ✅ | |
| `--batch-size 8869` / `--ubatch-size 531` | ❌ not tuned | Non-default and non-round, so deliberately chosen. Affects prefill far more than decode. |
| `-c 100000` | ✅ | |
| `-t 8` | — | 8 CPU threads; Kaggle T4 boxes have only 4 vCPU. |
| `--fit off` | — | Disables llama.cpp's own auto-fit, i.e. "I have set this by hand, don't second-guess me". |

### Why this is NOT a throughput target for 2× T4

Do not read 68.33 tok/s as a number to chase on Kaggle. The founder's framing is the correct
one: *"We can't match the speed but we need to get the best out of 2 T4s, then anyone with a
better setup will get the best."* The hardware gap is generational, not configurational:

- **5060 Ti is Blackwell (sm_120); T4 is Turing (sm_75)** — seven years and several tensor-core
  generations apart, and ~4× the memory bandwidth.
- Same reason `Q6_K` measures ~3× slower than `Q4_K_XL` on T4 with both fully resident
  (**OBS-1**) while this user runs Q6_K at 68 tok/s: T4 dequant kernels for that format are poor.
  **On T4, use Q4_K_XL-class quants.**

What *is* transferable is the **list of levers**. If auto-tune cannot express
`--split-mode tensor` or speculative decoding at all, then it cannot find this config on *any*
hardware — which is the actual defect, and is hardware-independent.

---

## REF-2 · Founder's single-GPU box, for scale

Qwen-class 27B on one **RTX 5070 Ti**, 200k context, ~100 tok/s. Recorded only to keep
expectations calibrated: a single modern card beats two T4s outright, and a layer split buys
**capacity, not speed**.
