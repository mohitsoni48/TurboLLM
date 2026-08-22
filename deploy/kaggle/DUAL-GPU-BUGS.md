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
- **FIXED in `pickSplitStrategies` (2026-08-22)** — row is now emitted on every multi-GPU box,
  ordered **last** (the strategy loop breaks on the global deadline, so the newcomer is the first
  thing dropped when budget runs short, never the layer-split default) and **skipped when the user
  pinned a single GPU** (that is a choice of hardware, not of geometry).
- **What row actually does on 2× T4 — measured in the GUI, and it settles the "wastes tuning
  time" objection.** Selecting Split mode → Row and loading fails, at **both** ctx 200,192 and
  ctx 8,192 (where the estimate is a roomy 19.1 / 30.7 GB), with the same fault:
  ```
  CUDA error: invalid argument
  current device: 0, in function ggml_backend_cuda_split_buffer_set_tensor
  ```
  That is the row-split tensor-upload path, and it dies **~8 seconds in** — during
  `common_init_result: fitting params to device memory`, long before any bench. So the real cost
  of offering row on hardware that cannot use it is *eight seconds and a recorded `crash`
  candidate*, not a wasted 10-minute bench slot. Meanwhile the reference box (2× RTX 5060 Ti,
  `--split-mode tensor`, 68 tok/s — see `REFERENCE-CONFIGS.md`) is exactly the machine where this
  candidate wins. Measurement decides, cheaply, in both directions.
- **Note this is NOT the expensive branch.** At ctx 200,192 the branch that actually burns the
  budget is **single-GPU** (BUG-5 / ADR-379): `maxGpuFraction` clears the 0.5 gate, the probe then
  finds only `ngl 31/65`, and the sweep benches 34 dense layers on 4 vCPUs — observed crawling at
  `prefill 46%` and consuming the full per-test cap.

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

### BUG-15 · A saved auto-tune result did not match the config the results dialog displayed — **OPEN, UNEXPLAINED**
- **Observed:** the "Auto-tune complete" dialog reported `GPU layers 65 · Context length 200,192 ·
  KV cache type q8_0 · Flash attention on`. After clicking **Save**, the model's profile read
  **ctx 173,568, K `q4_0`, V `q4_0`, speculative `NextN`**.
- **What it is NOT:** an auto-tune KV sweep. `pickKvQuants` is exported but **never called**
  anywhere in the bench flow — ADR-219's removal holds. The `q4_0` mention the user saw came from
  `kvSpeedAdvisory`, which only prints advice ("a different type (e.g. q4_0) may run faster") and
  changes nothing.
- **Deliberately not diagnosed further.** Several plausible stories exist (Save writing a different
  profile than it rendered; the advisory being applied rather than displayed; a stale profile
  read-back) and none is established. Needs a clean repro: run a sweep, screenshot the dialog,
  click Save, and diff the persisted profile. Flagged because "Save writes something other than
  what it showed you" would be serious if confirmed.

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

## Theme 4 — the VRAM estimate does not model what the engine actually allocates

Found 2026-08-22 driving the GUI on the 2× T4 box with **Qwen3.8-27B-UD-Q4_K_XL at ctx 200,192**,
the configuration the dual-GPU work targets. Both defects share one consequence: the panel says
**"fits comfortably"** and the load then dies with `exit 1`.

### BUG-11 · The estimate ignores the fork's own auto-asymmetric KV upgrade — **OPEN**
- **Where:** `turbollm/src/models/profile.ts`, `estimateVram()` / `estimateVramPerGpu()` — they size
  the KV from the *selected* `kvTypeK`, and nothing tells them the engine may override it.
- **Observed live**, straight from the engine log:
  ```
  llama_kv_cache: auto-asymmetric: GQA ratio 6:1 (n_head=24, n_head_kv=4) —
      upgrading K from turbo4 to q8_0 to prevent quality degradation.
      Disable with TURBO_AUTO_ASYMMETRIC=0
  common_fit_params: failed to fit params to free device memory:
      n_gpu_layers already set by user to 99, abort
  ```
- **The gap, measured in the panel itself:** selecting `turbo4` for K and V reports
  **~25.4 / 30.7 GB · fits**. The engine silently runs K at `q8_0`, whose honest cost the panel
  shows only if you *select* `q8_0` by hand: **~28.7 / 30.7 GB**. A 3.3 GB error, in the
  optimistic direction, on a box with ~2 GB of headroom.
- **Why it matters beyond the number:** `turbo4` is exactly what a TurboQuant user is steered
  toward for long context, and the auto-upgrade fires on any GQA-heavy model — which is most
  modern ones. The user is told the config fits, and it cannot.
- **Fix:** mirror the engine's auto-asymmetric rule in the estimator (upgrade K to `q8_0` when the
  GQA ratio crosses the fork's threshold), so the panel and the engine agree on one number.

### BUG-12 · The estimate ignores the NextN/MTP draft context — **OPEN**
- **Observed live:** `srv load_model: creating MTP draft context against the target model` — with
  speculative decoding on (**NextN is the DEFAULT** for any model carrying a NextN head, and this
  model ships one), the engine builds a *second* context. Its weights and KV are real VRAM that
  `estimateVram` does not count.
- **Fix:** add the draft context to the estimate whenever the speculative mode is not `off`, or at
  minimum surface it in the panel so the number is not silently optimistic.

### BUG-13 · The auto-tune progress display goes stale and never recovers — **OPEN**
- **Observed live at ctx 200,192.** The progress line sat at
  `KV q8_0: probing ngl=32 (range 0–65)…` for **~50 minutes**, unchanged, well past auto-tune's own
  45-minute `TOTAL_BUDGET_MS`. Closing and reopening the settings dialog showed the true state:
  `Measuring ngl=65 — measuring t/s…`. The sweep had been advancing the whole time; only the
  displayed step was frozen.
- **Same class as the engine badge sticking on `Stopping`** after an eject, which also only cleared
  on a page reload. In both cases the client stops applying server state and shows one value
  forever.
- **Why it matters more than it sounds.** A frozen step makes a long-but-healthy run
  indistinguishable from a hang. In this session it directly caused a *cancelled* sweep earlier on
  (the run was at `prefill 46%` and progressing), and then a page reload — and a reload is
  dangerous here because auto-tune holds its winner pending a **Save** click, with no GUI anywhere
  to recover it afterwards (Model actions offers only Pin / Find other quants / Delete, and per
  BUG-9 the bench log cannot even record which split strategy won).
- **Not established:** whether a reload actually discards an already-finished winner. The one
  reload in this session happened while the sweep was still running, so that remains untested —
  do not assume it either way.

### Consequence for auto-tune
Auto-tune's `ngl` search is probe-driven, so it *discovers* the real ceiling by loading — it is not
misled the way the panel is. But `pickSplitStrategies` gates the single-GPU branch on
`maxGpuFraction`, which is built on the same `estimateVram`. Both bugs therefore push that gate
optimistic, in the one direction ADR-379 was written to prevent.

---

## Not a bug — recorded so it stops being re-reported

**"Auto-tune should sweep `parallel` — concurrency is free throughput."** It should not.
**Founder call, 2026-08-22: auto-tune honours the user's `Parallel requests` setting and does not
tune it.** Today's code already does exactly that — `parallel: base.parallel` and
`parallel: profile.parallel` in `bench.ts` pass the profile's value straight through — so **no code
change is required, and none should be made.**

The measurement that prompted the question is kept because it is useful, not because it is a defect.
Same config throughout (ctx 200,192 · layer · ngl 65 · K `q8_0` / V `turbo4` · speculative off),
only `Parallel requests` changed, two chat tabs firing the identical prompt at once:

| Parallel requests | Per stream | Aggregate |
|---|---|---|
| 1 | 11.5–12 tok/s | ~12 tok/s |
| 2 | 9.0 tok/s each (stable 4+ min, 589 / 667 tokens) | **18.0 tok/s** |

That +50% aggregate is real — it is the idle 26% of GPU 0 (`GPU1 98–99% / GPU0 74%`) being
harvested, the difference between pipeline *placement*, which a layer split gives you, and pipeline
*execution*, which needs more than one request in flight.

**Why it is still not auto-tune's business.** Auto-tune optimises single-stream tok/s, and by that
objective `parallel=2` is a 25% **regression** — it would be right to reject it. Chasing aggregate
throughput would mean changing what auto-tune optimises for, and silently trading a chatting user's
latency for a throughput number they never asked for. Concurrency is a deployment choice the user
makes; the tuner's job is to make their choice fast, not to overrule it.

**"Auto-tune made my model slower."** Auto-tune benches at `0.75 × ctx` capped at 32k tokens; a
quick chat test uses a short prompt. The same config measured **7.8 t/s at a 2,521-token prompt
and 6.26 t/s at 32k**. Two points on one curve, not a regression. The auto-tune/chat gap measured
on-design is **70%**, of which ~19 points is methodology (engine-internal `predicted_per_second`
vs wall-clock streaming), ~10 points run-to-run, and only **4%** the daemon's proxy hop.
