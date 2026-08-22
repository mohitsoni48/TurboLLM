# Dual-GPU bugs — found on a real 2× Tesla T4 box

All of these were reproduced on Kaggle 2× Tesla T4 (15360 MB each, **30720 MB pooled**)
running TurboLLM **v1.11.6**, unless marked otherwise. Companion to
`DUAL-GPU-AUTOTUNE-REQUIREMENT.md`.

Status key: **FIXED (PR #190)** · **OPEN** · **UNEXPLAINED** (real observation, no diagnosis)

---

## Theme 1 — "multi-GPU" was written as `gpus[0]` in at least four places

The pooled budget is the correct one for the default layer split (`gpuBudgetMb` sums every
card). Every site below instead read the *first* card and reported half the machine.

### BUG-1 · Onboarding recommends a model for half the hardware — **FIXED (PR #190)**
- **Where:** `turbollm/src/api/onboarding-routes.ts`, `hardwareFactsFromSysInfo()`
- **Was:** `const primaryVramMb = info.gpus[0]?.vramMb ?? 0` → `usableVramMb`
- **Impact:** `usableVramMb` feeds `recommend()`, which picks the model band from
  `minVramMb`/`maxVramMb`. A 2×16 GB box resolved against **15 GB** and was offered a model
  it could hold twice over — silently, no warning.
- **Fix:** use `detectHardware(info).vramMb`, which already sums the primary vendor and drops
  an iGPU that merely shares system RAM (ADR-306/ADR-189).

### BUG-2 · Onboarding "Your machine" shows one card — **FIXED (PR #190)**
- **Where:** `turbollm/web/src/screens/onboarding/steps/WelcomeStep.tsx:15`
- **Was:** `const gpu = backends?.gpus?.[0]`
- **Observed live:** `Your machine — Tesla T4 · 15 GB VRAM` on a 2× T4 box, while the Engines
  hero on the *same machine* correctly said `2× Tesla T4 · 30 GB`.
- **Fix:** `primaryVendorSummary()` — the helper that already existed because the Engines hero
  had this exact bug first. Renders `2× Tesla T4` / `30 GB VRAM`.

### BUG-3 · Quant picker falsely warns of spill, steering users to a worse quant — **OPEN**
- **Where:** Models → Discover → quant dropdown (web). Same `gpus[0]` family; call site not
  yet located.
- **Observed live:** selecting `Q3_K_XL · 16.8 GB` on a 30.7 GB box shows
  **"Larger than your VRAM — will spill to system RAM. (16.8 GB file · 15 GB VRAM)"**.
  Also shows *"Tight fit — may slow under desktop load. (10.0 GB file · 15 GB VRAM)"* for a
  10 GB quant that is nowhere near tight.
- **Why this is the worst of the three:** it does not merely mis-report, it **actively pushes
  users onto a smaller, lower-quality quant than their hardware can run**, at the exact moment
  they choose one. A 16.8 GB model on 30.7 GB of VRAM will not spill.
- **Fix:** same as BUG-1/2 — judge against the pooled budget.

### BUG-4 · `estimateVram` cannot express "one card is full" — **PARTIALLY ADDRESSED**
- **Where:** `turbollm/src/models/profile.ts`, `estimateVram()`
- **Problem:** computes one scalar and compares it to `gpuBudgetMb`, the *summed* pool. A
  config pinning GPU1 at its ceiling while GPU0 sits nearly empty reads as comfortably fitting.
- **Measured:** `--n-cpu-moe 24` on Qwen3.6-35B-A3B Q8_0 → **1707 MB / 14693 MB**. That is
  16.4 GB against a 30.7 GB pool — "53%, fits" — with GPU1 one step from OOM.
- **Addressed by:** `estimateVramPerGpu()` (v1.11.4), used by the bench. **But `estimateVram`
  itself is still what the UI shows**, so the GUI's VRAM bar retains the flaw.

---

## Theme 2 — auto-tune

### BUG-5 · Single-GPU gate judged a KV type the run would never use — **FIXED (PR #190, ADR-379)**
- **Where:** `turbollm/src/bench/bench.ts`, `pickSplitStrategies()`
- **Was:** feasibility judged with `bestFitKv` (the *smallest* KV the engine offers), justified
  by "the inner KV sweep can pick it to fit". **ADR-219 removed that sweep** — auto-tune runs on
  whatever KV the user selected, so the gate answered a hypothetical.
- **Measured cost**, dense Qwen3.8-27B Q4_0 at ctx 188416 with the user's `q8_0`:
  ```
  split strategy → single-GPU (GPU 0)     ← never should have been offered
  probe ngl=32 → oom ; 15 → ok ; 23 → ok ; 27 → ok ; 29 → ok ; 28 → ok (14090 MB)
  bench ngl=28 → TIMEOUT                  ← ~13 min burned, no result
  split strategy → layer-split across 2 GPUs   ← correct all along
  ```
  True ceiling `ngl 28/65 = 0.43`, below the 0.5 gate; measured against `turbo4` it cleared it.
- **Fix:** judge on `base.kvTypeK`. Threshold deliberately left at 0.5 — raising it for dense
  was tried and reverted because it also rejected GitHub #62 at ~0.72.

### BUG-6 · Auto-tune never tries row / tensor-parallel split — **OPEN, likely the biggest miss**
- **Where:** `turbollm/src/bench/bench.ts`, `pickSplitStrategies()` — only ever generates
  `{single-GPU, layer-split}`. `row` is never a candidate.
- **Current justification in code:** *"Row-split is a deliberate follow-up: its per-layer
  all-reduce rarely pays off on PCIe-only multi-GPU."*
- **Evidence that this is wrong on modern cards:** a user running Qwen3.8-27B-UD-Q6_K on
  **2× RTX 5060 Ti** with `--split-mode tensor` reports **68.33 t/s** generation (80.04% draft
  acceptance, 2.77 tokens/forward-pass). A layer split makes the two cards a **sequential
  pipeline** — measured here as GPU1 at 98–99% util while GPU0 sat at 74% — so it buys capacity,
  not speed. Row is the only mode where both cards work the same layer at once.
- **Impact:** auto-tune is **structurally incapable** of finding the best configuration on a
  dual-GPU box, on any hardware.
- **Fix:** add a row candidate and let measured t/s decide, as the design already does for
  single-vs-layer. Cheap: the winner is chosen by measurement, so on PCIe-only boxes where row
  loses, it simply loses.

### BUG-7 · `estimateVramPerGpu` ignores `ngl` for MoE — **OPEN (mine, ADR-379 follow-up)**
- **Where:** `turbollm/src/models/profile.ts`, `estimateVramPerGpu()`
- **Problem:** `residentLayers = m.moe ? blocks : Math.max(0, Math.min(p.ngl, blocks))`.
  Deliberate for the `--n-cpu-moe` case (attention stays resident, `ngl` is not the knob) but
  **wrong when the user actually lowers `ngl` on an MoE** — it then reports "fits" at `ngl 0`.
- **Field evidence:** a reporter's panel showed `~10.8 / 24.5 GB · fits comfortably` at
  **GPU layers: 0**. A dense model at `ngl 0` would estimate ~0; 10.8 GB is this MoE branch
  firing.

### BUG-8 · Auto-tune can end with no config at all at deep context — **OPEN**
- **Observed:** dense Qwen3.8-27B Q6_K at ctx 131072 — search correctly walked `ngl` 65 → 57,
  loaded it, prefilled to 100%, then `bench error: No candidate completed successfully`. No
  winner, no fallback. The same model at 65536 was fine (`ngl 65`, 27786 MB).
- **Mechanism (measured):** the bench prompt is capped at 32k tokens
  (`BENCH_MAX_PROMPT_TOKENS`), so any candidate with many dense layers on CPU blows the
  10-minute per-test cap. If every candidate in a strategy times out, the sweep ends empty.
- **Note there are THREE independent paths to this same error string**, and they are not
  alternatives:
  1. **timeouts** (above) — measured here
  2. **unified memory** — ADR-380 Decision 1, measured on a Ryzen APU, fixed
  3. **tolerance-only spill detection when `pooled` is true** (`b9d7066`, live since v1.11.1) —
     **untested, not refuted**. Cannot be exercised on Linux (`isSpilling` returns false on a
     null reading; WDDM demotion is a Windows behaviour). Needs the reporter's OS to settle.

### BUG-9 · The bench log cannot record which split strategy won — **OPEN**
- **Where:** `BenchCandidate.params` (`turbollm/src/bench/bench.ts`) has
  `ctx/ngl/nCpuMoe/parallel/kvTypeK/flashAttn` and **no `gpu` field**.
- **Impact:** `pickSplitStrategies` actively chooses between strategies, and the winner record
  cannot say which one produced the winning tok/s. Makes every "was it the split?" question
  unanswerable after the fact.

---

## Theme 3 — UI correctness

### BUG-10 · A stale "Tuned:" success renders above a fresh failure — **OPEN**
- **Where:** `turbollm/web/src/components/ModelDetailDialog.tsx:1152`
- **Problem:** `Tuned: N tok/s · settings applied below` is drawn from the stored past result
  **regardless of `resultError`**.
- **Field evidence:** the reporter's screenshot shows `Tuned: 15.3 tok/s on your machine ·
  settings applied below` sitting directly above `No candidate completed successfully.`

---

## Observations without a diagnosis — do not "fix" blind

### OBS-1 · Q6_K is ~3× slower than Q4_K_XL on T4 — **UNEXPLAINED**
Same 27B family, both **fully GPU-resident**, only 1.25× more bytes: Q4_K_XL 12.4 t/s vs Q6_K
4.3 t/s. Suspect poor Q6_K dequant kernels on sm_75. If it holds, it is a **quant-selection
guideline that matters more than any tuning knob** on T4-class hardware.

### OBS-2 · Dense loads are work-imbalanced while memory is balanced — **UNEXPLAINED**
GPU1 at 98–99% util, GPU0 at 74%, with 12525 / 13019 MiB. Byte-balancing does not address this,
and `deriveTensorSplit` deliberately declines dense models. Consistent with the sequential
pipeline, but the 74% floor is not explained by it.

---

## Not a bug — recorded so it stops being re-reported

**"Auto-tune made my model slower."** Auto-tune benches at `0.75 × ctx` capped at 32k tokens; a
quick chat test uses a short prompt. The same config measured **7.8 t/s at a 2,521-token prompt
and 6.26 t/s at 32k**. Two points on one curve, not a regression. The auto-tune/chat gap measured
on-design is **70%**, of which ~19 points is methodology (engine-internal `predicted_per_second`
vs wall-clock streaming), ~10 points run-to-run, and only **4%** the daemon's proxy hop.
