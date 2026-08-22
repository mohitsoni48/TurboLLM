# Dual-GPU auto-tune — THE REQUIREMENT

> Written 2026-08-22 after the founder got angry at how this was being handled.
> Read this **first** in any session touching dual-GPU. It exists so the deviation
> described below does not happen again.

---

## THE ASK — one sentence

**Find the best auto-tune setup for a dual-GPU machine, and prove it through the GUI.**

That is the whole requirement. Not an investigation, not a root-cause writeup, not a set of
PRs. A configuration that is demonstrably the best available on two GPUs.

## HARD RULES

1. **GUI ONLY. No scripts.** Do not drive the daemon with `bench_vs_chat.py`, curl,
   in-page `fetch`, or notebook cells to produce the answer. The founder must be able to see
   and reproduce every step in the interface a real user has. Scripts were the wrong
   instrument and produced numbers no user could ever get to.
2. **Deliver the setting, not the theory.** The output is "use these values, here is the
   tok/s". Mechanism is a footnote, not the deliverable.
3. **Finish one thing before starting another.**

## WHY THE FOUNDER IS FRUSTRATED — do not repeat this

Direct quote: *"you are making me angry now. I am pissed how you are acting with this dual
gpu setup. Why is this so difficult and why you keep deviating."*

The pattern that caused it, honestly stated:

- **Chased mechanism instead of the deliverable.** Three ADRs, four PRs, a docs refresh and
  long cross-session messages. Not one of them answered "what settings should I use on two
  GPUs?"
- **Repeatedly asserted, then retracted.** Claimed the slowdown was a PCIe activation copy
  (arithmetically impossible), that dual was slower than single (measured *faster*), that the
  daemon proxy was halving throughput (it costs 4%), that clean probes refuted the spill
  hypothesis (that path is inert on Linux — untestable either way). Each retraction cost the
  founder's time.
- **Shipped a "fix" that would have made things 8% worse** (`deriveDefault` → single-GPU),
  caught only because it was measured afterwards.
- **Left the thing actually asked for undone.** A Layer-vs-Row comparison was explicitly
  requested and never ran — twice — because the Kaggle session died and attention went
  elsewhere instead of restarting it.
- **Used scripts for everything**, so the numbers never corresponded to what a GUI user sees.

The founder's own diagnosis was sharper than several of mine, twice:
- *"it uses VRAM usage to auto tune"* — correct; the `ngl` search is probe-driven, so the
  VRAM **estimate** was never the cause of the search's behaviour.
- *"when model + KV cache calc exceeds single gpu then why to try that"* — correct, and
  exactly the ADR-379 bug.

## WHAT IS ALREADY MEASURED — do not re-derive any of this

Hardware: Kaggle 2× Tesla T4, 15360 MB each, **30720 MB pooled**, 4 vCPU, 31 GB RAM.

- **A layer split is a sequential pipeline.** The cards do not work on one token at the same
  time. Dual GPU buys **capacity, not speed** for single-stream decode. Measured: GPU1 at
  98–99% util while GPU0 sat at 74%.
- **CPU offload is the only thing that really costs throughput.** MoE 22.9 GB: 0 experts on
  CPU = 57.5 t/s; 8 experts on CPU = 24.8 t/s. No split geometry comes close to that effect.
- **Context is nearly free.** 8k → 128k costs about 1% of decode. KV measured at
  ~0.069 MB/token, roughly 4× less than the declared geometry implies.
- **A single T4 OOMs** on both 27B models tested. Dual is the only way to run them at all.
- **Q6_K is ~3× slower than Q4_K_XL** on T4 (4.3 vs 12.4 t/s), both fully GPU-resident.
  Unexplained — but it means **quant choice matters more here than any tuning knob**.
- **Auto-tune's number is not comparable to a quick chat test.** It benches at 0.75 × ctx
  capped at 32k. The same config measured 7.8 t/s at a 2,521-token prompt and 6.26 t/s at
  32k. Not a regression — two points on one curve.
- **Best MoE result so far:** Qwen3.6-35B-A3B Q4_K_XL (22.9 GB), `nCpuMoe 0`, both cards
  loaded, ctx 32k → **~56 t/s**.
- **Best dense result so far:** Qwen3.8-27B Q4_0 (16.1 GB), `ngl all`, ctx 188k → ~7.8 t/s.

## THE PLAN — what "done" looks like

Through the GUI, on a live dual-T4 session:

1. Load a model that actually suits two T4s. **Q4_K_XL-class — not Q8, not Q6_K.**
2. Run Auto-tune from the GUI. Record what it picks and the tok/s it reports.
3. Try the alternatives by hand in the GUI panel — at minimum **Split mode: Layer vs Row**,
   which was requested and never tested — and record tok/s for each.
4. Deliver: **"these are the settings, this is the tok/s, this is why it beats the others."**

Anything else — ADRs, PRs, mechanism — is out of scope until that exists.

## STATE AS OF WRITING

- Kaggle notebook: `sonijisons/turbollm-one-click-dual-t4`, tracks `main`, GPU T4 ×2,
  internet on, `turboquant-cuda-t4` attached. The session dies when idle, and
  `/kaggle/working` does **not** survive it, so the model must be re-downloaded each time.
- Fastest model route with no download: attach dataset
  `tahsinekajolasalami/qwen36-35b-a3b-gguf` (Qwen3.6-35B-A3B UD-Q4_K_XL, 22.9 GB) as an
  Input — it mounts at `/kaggle/input`, which `serve.sh` already registers.
- Open PR #190 (ADR-379 KV gate + onboarding pooling) — unit-tested, **not verified on the
  box**. Does not block this requirement.
