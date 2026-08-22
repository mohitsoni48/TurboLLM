# TurboLLM on Kaggle (free 2×T4) — dual-GPU test harness

Kaggle Notebooks hand out **two Tesla T4s** (2×16 GB) for free, which makes them a genuine
dual-GPU box for anyone who doesn't own one. This directory brings TurboLLM up there and
measures it.

It exists because of two consumer reports: that TurboLLM doesn't use both GPUs, and that
**chat tok/s is far below what auto-tune reported**. Both were investigated here, and the
answers were different from what they looked like:

- **Both GPUs / stranded VRAM — real, and fixed.** On a multi-GPU box an MoE model with CPU
  expert offload piled nearly all its weight onto one card, so auto-tune tuned against a pool
  it could not actually use. Fixed by per-GPU VRAM projection and byte-balanced layer
  placement (`estimateVramPerGpu` / `deriveTensorSplit` / `withBalancedSplit`), shipped in
  **v1.11.4**. Numbers below.
- **"Chat is far below auto-tune" — mostly a measurement artifact.** Measured on design the
  gap is 70%, not the 45% this harness used to report, and most of it is that auto-tune reports
  the engine's internal decode rate while a chat client measures wall clock. Details below.

## Setup

1. New Kaggle Notebook → **Settings → Accelerator → GPU T4 x2**, **Internet → On**.
2. **Add Input → Datasets → `turboquant-cuda-t4`** (the prebuilt CUDA engine).
3. Run these cells:

```python
# Cell 1 — clone (or fast-forward)
!git clone https://github.com/mohitsoni48/TurboLLM.git /kaggle/working/TurboLLM 2>/dev/null; cd /kaggle/working/TurboLLM && git pull
```

```python
# Cell 2 — idempotent setup: Node, npm deps, web build, engine unpack. ~5 min with the
# prebuilt engine attached; ~40 min if it has to compile the fork instead.
!bash /kaggle/working/TurboLLM/deploy/kaggle/setup.sh
```

```python
# Cell 3 — start the daemon, activate the CUDA engine, open the public GUI tunnel
!bash /kaggle/working/TurboLLM/deploy/kaggle/serve.sh start
```

Cell 3 prints the public `*.trycloudflare.com` URL and the **Token** to open it. Loopback API
calls from inside the notebook need no token.

## Why CUDA, and why a prebuilt bundle

On Linux+NVIDIA, TurboLLM's auto-recommendation picks **Vulkan** (upstream ships no Linux CUDA
prebuilt). Kaggle's container has the NVIDIA driver and **no Vulkan ICD**, so the Vulkan backend
silently runs on **CPU** (~0.4 tok/s, 0 MB GPU). CUDA is the only backend that actually uses the
T4s here.

`setup.sh` therefore wants the **TurboQuant** llama.cpp fork built with `-DGGML_CUDA=ON`. It
looks for a prebuilt bundle first (the `turboquant-cuda-t4` dataset) and only falls back to
compiling from source — ~40 minutes — if it can't find one. Attach the dataset.

Kaggle mangles two things about that dataset, and `setup.sh` repairs both: it strips the
executable bit, and it stores symlinks as **0-byte files**, so `libllama.so` and friends arrive
empty and the loader fails with `libllama-server-impl.so: cannot open shared object file`. If you
drive `llama-server` yourself rather than through `setup.sh`, you must replay that repair and set
`LD_LIBRARY_PATH` to the binary's directory.

## Models without downloading them

Public Kaggle datasets mount instantly at `/kaggle/input`, which beats re-downloading tens of GB
on every cold container:

| dataset | file | size |
|---|---|---|
| `tahsinekajolasalami/qwen36-35b-a3b-gguf` | `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | 22.9 GB |
| `selahattinkabasakal/qwen3-8-gguf` | `Qwen3.8-27B-UD-Q4_K_XL.gguf` | 17.9 GB |
| `rohithmanepalli/qwen3-8-27b-orcarouter-gguf` | `Qwen3.8-27B-…-Q6_K.gguf` | 22.4 GB |

Point the daemon at one with `TURBOLLM_EXTRA_MODEL_DIRS=$(dirname <path>)`. If you do need
Hugging Face, `pip install hf_transfer` + `HF_HUB_ENABLE_HF_TRANSFER=1` pulls ~37 GB in about
2.6 minutes; `/tmp` has ~1 TB free while `/kaggle/working` is capped at 19.5 GB.

## Headless runs via the Kaggle CLI

The UI flow needs a human clicking through the GUI. For an unattended, reproducible run, push
the notebook as a **batch kernel** instead:

```bash
pip install kaggle
kaggle auth login      # OAuth in the browser — no API token file to manage
kaggle kernels push   -p deploy/kaggle --accelerator NvidiaTeslaT4
kaggle kernels status sonijisons/<slug>
kaggle kernels logs   sonijisons/<slug>          # just the run log
```

Things that cost time to learn:

- **`--accelerator NvidiaTeslaT4` pins the dual-T4 shape.** `kernel-metadata.json`'s `enable_gpu`
  is a bare boolean and cannot request *two* cards. The CLI flag can — a pushed run comes up with
  `Tesla T4 ×2`, so a batch run needs no UI visit. (Valid shapes: `NvidiaTeslaT4`,
  `NvidiaTeslaP100`, `Tpu1VmV38`.)
- **The kernel slug comes from `title`, not `id`.** A title of `TurboLLM probe (shape + disk)`
  pushes to `…/turbollm-probe-shape-disk`, and `status`/`logs` against the `id` fail with a
  confusing *permission denied*. Keep `title` and `id` identical.
- **Use `kernels logs`, not `kernels output`.** `output` downloads everything in
  `/kaggle/working`, which includes the whole repo clone and its `node_modules`.
- **A batch kernel shows no partial output.** It is complete-or-nothing, so a run that throws at
  the last step discards everything before it. Fail fast at the top.
- **The OAuth token expires mid-session.** `kernels status` starts returning
  `Permission 'kernels.get' was denied` while `auth login` still claims you are logged in;
  `auth login --force` fixes it. The kernel keeps running regardless.

## The dev loop

```python
# daemon-only change (src/**): pull + restart (tsx reads source directly, no build)
!cd /kaggle/working/TurboLLM && git pull && bash deploy/kaggle/serve.sh restart
```

```python
# web-UI change (web/**): pull + rebuild the UI + restart
!cd /kaggle/working/TurboLLM/turbollm && git pull && npm run build:web && bash ../deploy/kaggle/serve.sh restart
```

## The test procedure

`bench_vs_chat.py` runs auto-tune, saves the winner, loads it, and then measures real decode
throughput **at the same context depth the tuner used**, on both the engine and the daemon:

```python
!cd /kaggle/working/TurboLLM && python3 deploy/kaggle/bench_vs_chat.py --ctx 32768
```

It prints four legs, so a difference is *attributable* rather than merely observed:

```
A auto-tune reported          what the tuner recorded (timings.predicted_per_second)
B engine, non-streaming, 128  reproduces A on demand      → gap here is run-to-run noise
C engine, streaming           adds streaming + wall clock → gap here is methodology
D daemon, streaming           adds the daemon proxy hop   → gap here is a product cost
```

**Depth is the thing to get right.** `bench.ts` builds the real Default-agent prompt out to
`0.75 × ctx`, capped at `BENCH_MAX_PROMPT_TOKENS = 32000`, and generates from *that* depth —
a design validated to track real chat within ~5% at 22k. `--ctx` defaults to the model's own
context for that reason. Forcing a small one (this README used to recommend `--ctx 8192`) benches
at ~6k of depth, reports an optimistic number real chat won't reproduce, and the script now warns
when you ask for it. Note `deriveDefault` caps a fresh profile at 8192, so the 32k design point
only engages once ctx is raised.

Manual pokes at the same surfaces (all loopback, no token needed):

```python
!curl -s localhost:6996/api/v1/sysinfo | python3 -m json.tool     # expect 2 GPUs
!curl -s localhost:6996/api/v1/engines | python3 -m json.tool     # TurboQuant CUDA active
!nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv   # during a chat
```

In the GUI the hardware line should read **`2× Tesla T4 · 30 GB · Linux`**.

## Measured: the dual-GPU placement bug (fixed in v1.11.4)

`--n-cpu-moe N` strips the experts out of the FIRST N layers, leaving them ~10× lighter than the
rest, while llama.cpp's default split divides by LAYER COUNT. The two cards therefore end up
wildly uneven — and `estimateVram` compared one scalar against the SUMMED pool, so it could not
express *"GPU1 is full, GPU0 is empty."*

Driving `llama-server` directly, 36.9 GB Qwen3.6-35B-A3B Q8_0, ctx 8192, 2× T4 (30.7 GB pooled):

| --n-cpu-moe | --tensor-split | decode t/s | GPU0 MiB | GPU1 MiB | resident |
|------------:|:---------------|-----------:|---------:|---------:|---------:|
| 24 | (default even) | 4.96 | 1707 | 14693 | 16400 |
| 24 | 3,1 | 4.57 | 7901 | 8501 | 16402 |
| 24 | 4,1 | 3.82 | 9629 | 6771 | 16400 |
| 16 | 2,1 | **5.82** | 11837 | 11091 | **22928** |
| 12 | 2,1 | OOM | | | |

Two conclusions, and the second is the one that shaped the fix:

- **The imbalance is real** — 1.7 GB on one card against 14.7 GB on the other, so only ~16 GB of
  the 30 GB pool was ever used.
- **Balancing on its own is a REGRESSION** — 4.96 → 4.57 → 3.82 at an identical 16.4 GB resident.
  The mechanism was never established (an earlier draft blamed a PCIe activation copy per layer
  boundary; that does not survive arithmetic, since the activation crosses once per token and is
  a few KB, and a later dual-vs-single test failed to reproduce the sequential-pipeline theory
  either). What the data does support is narrower and sufficient: **`tensorSplit` is a capacity
  knob, not a speed knob.** It only pays when the freed VRAM buys a lower offload — at `2,1` the
  offload drops 24 → 16, reaching 22.9 GB and 5.82 t/s. So the shipped fix applies a derived split
  *only* when the even split overflows a card AND balancing resolves it.

**The fix, through the full daemon** (`bench_vs_chat.py`, same model and hardware):

| | before | after |
|---|---:|---:|
| nCpuMoe chosen | 24 | **10** |
| tensor-split | (llama.cpp even) | **[25, 15]** derived |
| GPU0 / GPU1 | 1707 / 14693 MiB | **14879 / 12757 MiB** |
| resident | 16.4 GB (53% of pool) | **27.6 GB (90%)** |
| chat | 4.3 t/s | **10.0 t/s** |

The search direction is the real tell. Before, it probed 20 → 30 → 25 → 22 → 23 → 24, walking
RIGHT into ever more CPU offload because every probe near the top of the pool read as spilling.
After: 20 → 9 → 14 → 11 → 10 — `nCpuMoe=20` now fits, so the search **descends** instead of
retreating. It also beat the best hand-swept config in the table above (5.82 t/s) by 72%, reaching
a setting the even split made unreachable at any `nCpuMoe`.

**Scope:** MoE only. `deriveTensorSplit` returns `[]` for dense models — uniform layers cannot be
byte-imbalanced — and for zero offload. Single-GPU boxes are untouched.

A `tensorSplit` you pinned yourself is **discarded** by the sweep (founder call, 2026-08-22).
Auto-tune owns the split, because a pinned one structurally caps the search: the offload probe can
then only move `nCpuMoe` against a placement that may be the very thing stranding the VRAM.

The projection's constants are calibrated against T4 measurements of one model; worth re-checking
on other dual-GPU hardware.

## Measured: where the auto-tune vs chat gap actually goes

Run ON DESIGN — ctx 32768 → 24576 tokens of depth, with every chat leg built to that same depth.
Qwen3.6-35B-A3B UD-Q4_K_XL, 2× T4:

| leg | tok/s | vs leg above |
|-----|------:|-------------:|
| A auto-tune reported | 35.7 | — |
| B engine, non-streaming, 128 tok | 32.3 | 90% (run-to-run) |
| C engine, streaming | 26.1 | 81% (streaming cost) |
| D daemon, streaming | 25.1 | 96% (daemon proxy cost) |
| **end to end** | | **70%** |

The old "chat is 45% of auto-tune" figure was a harness artifact: it compared a 6k-deep bench
against a near-zero-depth chat on a different endpoint. Measured properly it is 70%, and it
decomposes into three ordinary costs rather than one defect:

- **19 points is methodology, not speed.** Auto-tune reports `timings.predicted_per_second`; a
  streaming client measures wall clock. Same config, same engine, same depth, different quantity.
- **The daemon proxy costs 4%** — worth stating plainly, because it is the intuitive suspect and
  it is not guilty.
- **10% is run-to-run** noise on a single measured bench.

At that depth the winner was `nCpuMoe=0`, both cards loaded (12925 / 12235 MiB), no offload.
Prefill ran at 839 tok/s → **22.2 s to first token**, which dwarfs the decode delta and is why
`ttfMs` rather than raw generation t/s is the objective auto-tune ranks on.

## Open questions

Found here, not yet addressed:

- **Auto-tune produces NO config at deep context on a dense model.** Qwen3.8-27B Q6_K (22.4 GB,
  65 blocks) at ctx 131072: the search correctly walked `ngl` down 65 → 57, loaded it, prefilled
  to 100%, then `bench error: No candidate completed successfully` — no winner, no fallback. The
  same model at 65536 was fine (`ngl=65`, no offload, 27786 MiB).
- **Q6_K is ~3× slower than Q4_K_XL on T4** — 4.3 vs 12.4 t/s for the same 27B family, both fully
  GPU-resident, only 1.25× more bytes. Looks like poor Q6_K dequant kernels on sm_75; if it holds
  it is a quant-selection guideline for T4-class hardware.
- **Dense loads are work-imbalanced even when memory is balanced** — GPU1 at 98–99% util while
  GPU0 sits at 74%, with 12525 / 13019 MiB. Byte-balancing does not address this, and
  `deriveTensorSplit` deliberately declines dense models.
- **`BenchCandidate.params` carries no `gpu` field**, so the bench log cannot record which split
  strategy won, even though `pickSplitStrategies` chooses between them.

## Notes / knobs

- `TURBOLLM_MODEL_FILE` — override the GGUF (default `Qwen3.6-27B-Q4_K_M.gguf`).
- `TURBOLLM_MODEL_REPO` — override the HF repo (default `unsloth/Qwen3.6-27B-MTP-GGUF`).
- `TURBOLLM_SKIP_MODEL=1` — skip the baked-in model download entirely.
- `TURBOLLM_ENGINE_ROOT` — where the engine unpacks (the notebook uses `/tmp` to keep 3.8 GB off
  the 19.5 GB `/kaggle/working` quota).
- `TURBOLLM_EXTRA_MODEL_DIRS` — extra `:`-separated model dirs for `serve.sh` to register.
- `TURBOLLM_BUILD_JOBS` — compile parallelism (default `2`; raising it risks OOM on Kaggle's ~29 GB).
- `/kaggle/working` persists within a session but is capped at 19.5 GB; `/tmp` has ~1 TB and does
  not persist. Kaggle GPU is quota'd (~30 h/week).
