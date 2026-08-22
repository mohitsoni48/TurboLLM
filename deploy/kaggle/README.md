# TurboLLM on Kaggle (free 2×T4) — dual-GPU test harness

A free, genuine **dual-GPU** box (Kaggle Notebooks → GPU **T4 x2**, 2×16 GB) for
reproducing and fixing the consumer reports that TurboLLM either doesn't recognize both
GPUs, or that **chat tok/s is far below the tok/s auto-tune reported**.

Everything runs **from this repo's branch**, so the loop is: fix locally → push → `git
pull` on Kaggle → restart. No binary shipping, no tunnels-for-file-transfer, no glibc
juggling — the engine is compiled **on** the T4 box, where sm_75 and glibc are correct by
construction.

## Why a CUDA source build (not the prebuilt)

On Linux+NVIDIA, TurboLLM's auto-recommendation picks **Vulkan** (upstream ships no Linux
CUDA prebuilt). But Kaggle's container has the NVIDIA driver and **no Vulkan ICD**, so the
Vulkan backend silently runs on **CPU** (~0.4 tok/s, 0 MB GPU). CUDA is the only backend
that actually uses the T4s here — so `setup.sh` compiles the **TurboQuant** llama.cpp fork
(the product's hero engine; supports Qwen3.6) with `-DGGML_CUDA=ON` natively on the box.

## One-time notebook setup

1. New Kaggle Notebook → **Settings → Accelerator → GPU T4 x2**, **Internet → On**.
2. Run these cells (each is one line — `!` shell cells, so no CodeMirror wrangling):

```python
# Cell 1 — clone the branch (or fast-forward it if already cloned)
!git clone -b claude/turbollm-runpod-dual-gpu-7aa8c0 https://github.com/mohitsoni48/TurboLLM.git 2>/dev/null; cd /kaggle/working/TurboLLM && git pull
```

```python
# Cell 2 — idempotent heavy setup: Node, npm deps, web build, TurboQuant CUDA build, model DL (~20-40 min the first time)
!bash /kaggle/working/TurboLLM/deploy/kaggle/setup.sh
```

```python
# Cell 3 — start the daemon (from source) + register the CUDA engine + open the public GUI tunnel
!bash /kaggle/working/TurboLLM/deploy/kaggle/serve.sh start
```

Cell 3 prints the public `*.trycloudflare.com` URL and the **Token** required to open it.
Loopback API calls from inside the notebook need no token.

## Headless runs via the Kaggle CLI

The UI flow above needs a human to click through the GUI. For an unattended, reproducible run
(and for CI), push the notebook as a **batch kernel** instead:

```bash
pip install kaggle
kaggle auth login      # OAuth in the browser — no API token file to manage
kaggle kernels push -p deploy/kaggle --accelerator NvidiaTeslaT4
kaggle kernels status  sonijisons/<slug>
kaggle kernels output  sonijisons/<slug> -p out    # the full run log
```

Two things worth knowing:

- **`--accelerator NvidiaTeslaT4` pins the dual-T4 shape.** `kernel-metadata.json`'s
  `enable_gpu` is a bare boolean and cannot request *two* cards, which is why the notebook
  tells you to set the accelerator by hand in the UI. The CLI flag can — a pushed run comes up
  with `Tesla T4 ×2` — so a batch run needs no UI visit at all. (Valid shapes:
  `NvidiaTeslaT4`, `NvidiaTeslaP100`, `Tpu1VmV38`.)
- **The kernel slug comes from the `title`, not the `id`.** A title of `TurboLLM probe (shape
  + disk)` pushes to `…/turbollm-probe-shape-disk`, and `status`/`output` against the `id`
  fail with a confusing *permission denied*. Keep `title` and `id` the same string.

A batch kernel has no interactive GUI, so a headless notebook should end by running
`bench_vs_chat.py` and printing its result rather than opening a tunnel.

## The dev loop

When a fix is pushed to the branch, on Kaggle just:

```python
# daemon-only change (src/**): pull + restart (tsx picks up source directly, no build)
!cd /kaggle/working/TurboLLM && git pull && bash deploy/kaggle/serve.sh restart
```

```python
# web-UI change (web/**): pull + rebuild the UI + restart
!cd /kaggle/working/TurboLLM/turbollm && git pull && npm run build:web && bash ../deploy/kaggle/serve.sh restart
```

## The test procedure (the actual investigation)

One script does the whole comparison end-to-end (auto-tune → save winner → load → measure
real streaming chat tok/s → sample both T4s → diff winner-vs-loaded config):

```python
!cd /kaggle/working/TurboLLM && python3 deploy/kaggle/bench_vs_chat.py --ctx 8192
```

It prints, side by side:
- **auto-tune decode tps** (`winner.tps`) vs **chat decode tps** (measured off the live
  `/v1/chat/completions` stream, exactly what the UI shows) and their ratio — the consumer
  complaint is chat ≪ auto-tune,
- **winner params vs the profile chat actually loaded** — a mismatch here is the usual
  cause (auto-tune's winning offload/ctx not being what chat loads),
- **per-GPU peak mem + util during the chat** — both GPU 0 and GPU 1 must be non-zero on a
  dual-GPU load.

Manual pokes at the same surfaces (all loopback, no token needed):

```python
!curl -s localhost:6996/api/v1/sysinfo | python3 -m json.tool     # expect 2 GPUs
!curl -s localhost:6996/api/v1/engines | python3 -m json.tool     # TurboQuant CUDA active
!nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv   # during a chat
```

In the GUI the hardware line should now read **`2× Tesla T4 · 30 GB · Linux`**.

When a discrepancy is root-caused, fix on the branch, push, `git pull` on Kaggle, restart,
and re-run the script.

## Measured: the 2xT4 layer-split is byte-imbalanced (Qwen3.6-35B-A3B Q8_0)

`--n-cpu-moe N` strips the experts from the FIRST N layers, so those layers are ~10x lighter
than the rest. llama.cpp's default split divides by LAYER COUNT, not by bytes, and TurboLLM
emits no `--tensor-split` by default (profile.ts: 'layer' + empty tensorSplit + mainGpu -1 emit
nothing), so the two cards end up wildly uneven. Measured by driving llama-server directly,
36.9 GB model, ctx 8192, 2x Tesla T4 (30 GB pooled):

| --n-cpu-moe | --tensor-split | decode t/s | GPU0 MiB | GPU1 MiB | resident |
|------------:|:---------------|-----------:|---------:|---------:|---------:|
| 24 | (default even) | 4.96 | 1707 | 14693 | 16400 |
| 24 | 3,1            | 4.57 | 7901 |  8501 | 16402 |
| 24 | 4,1            | 3.82 | 9629 |  6771 | 16400 |
| 16 | 2,1            | **5.82** | 11837 | 11091 | **22928** |
| 12 | 2,1            | OOM (failed to allocate compute buffers) | | | |

Three things worth keeping:

- **The imbalance is real.** The default split puts 1.7 GB on one card and 14.7 GB on the
  other, so only ~16 GB of the 30 GB pool is ever used.
- **Balancing alone makes it SLOWER** — 4.96 -> 4.57 -> 3.82 at an identical 16.4 GB resident.
  The lopsided split was accidentally minimizing cross-device traffic; spreading the same
  layers over both cards just adds a PCIe activation copy per layer boundary. A fix that only
  rebalances `tensorSplit` is a regression.
- **The win is balancing AND spending the freed VRAM**: at `2,1` the offload can drop from 24
  CPU experts to 16, reaching 22.9 GB resident and 5.82 t/s (+17%). Below 16 it OOMs — 36.9 GB
  has a hard floor in 30 GB of VRAM.

Verified fix (2x T4, same model, full daemon auto-tune, `bench_vs_chat.py --ctx 8192`):

| | before | after |
|---|---:|---:|
| nCpuMoe chosen | 24 | **10** |
| tensor-split | (llama.cpp even) | **[25, 15]** derived |
| GPU0 / GPU1 | 1707 / 14693 MiB | **14879 / 12757 MiB** |
| resident | 16.4 GB (53% of pool) | **27.6 GB (90%)** |
| auto-tune | 12.4 t/s | 22.1 t/s |
| chat | 4.3 t/s | **10.0 t/s** |

The search direction is the tell. Before, it probed 20 -> 30 -> 25 -> 22 -> 23 -> 24, walking
RIGHT into ever more CPU offload because every probe near the top of the pool looked like it was
spilling. After, it probes 20 -> 9 -> 14 -> 11 -> 10: nCpuMoe=20 now FITS, because the layers are
placed by bytes and GPU1 no longer saturates while GPU0 idles, so the search descends instead of
retreating. That also beat the best hand-swept config in the table above (5.82 t/s) by 72% — the
tuner reached a config the even split had made unreachable at any setting.

Note the auto-tune vs chat gap (22.1 vs 10.0, 45%) survives the fix — both numbers roughly
doubled but the ratio did not move. That gap reproduces on a SINGLE card too, so it is a separate
bug and not a dual-GPU one.

The tuner cannot currently reach that config: `pickSplitStrategies` offers only {single-GPU,
the profile's existing split} and never a rebalanced `tensorSplit`, so the offload search runs
against the default even split and is structurally capped near 16 GB resident. Unlocking the
+17% means searching `nCpuMoe` and `tensorSplit` JOINTLY, not one with the other pinned.

Cross-check note: this table came from driving llama-server directly (no daemon). The same
model through the full daemon measured 4.3 t/s at the default split, so compare rows within
this table, not against daemon numbers.

## Measured: where the auto-tune vs chat gap actually goes

Run ON DESIGN — ctx 32768, so the bench prompt reaches 24576 tokens (0.75x ctx, capped at 32k),
the band bench.ts records as validated — with every chat leg measured against a prompt built to
that same depth. Qwen3.6-35B-A3B UD-Q4_K_XL, 2x Tesla T4:

| leg | tok/s | vs leg above |
|-----|------:|-------------:|
| A auto-tune reported | 35.7 | — |
| B engine, non-streaming, 128 tok | 32.3 | 90% (run-to-run) |
| C engine, streaming | 26.1 | 81% (streaming cost) |
| D daemon, streaming | 25.1 | 96% (daemon proxy cost) |
| **end to end (D vs A)** | | **70%** |

The earlier "chat is 45% of auto-tune" figure was a harness artifact — it compared a 6k-deep bench
against a near-zero-depth chat on a different endpoint. Measured properly the gap is 70%, and it
decomposes into three ordinary costs rather than one defect:

- **19 points of it is methodology, not speed.** Auto-tune reports llama.cpp's own
  `timings.predicted_per_second`; a streaming client measures wall clock. Same config, same
  engine, same depth — different quantity. If the headline number should match what users see,
  it has to be measured the way users receive it.
- **The daemon proxy costs 4%.** Worth stating plainly because it is the intuitive suspect and it
  is not guilty: the Node SSE hop is nearly free.
- **10% is run-to-run**, which is the noise floor for a single measured bench.

At this depth the winner was `nCpuMoe=0` with both cards loaded (12925 / 12235 MiB, util 44% /
74%) — full residency, no offload, genuinely dual-GPU. Prefill ran at 839 tok/s, i.e. **22.2 s to
first token** at 24.6k depth. That dwarfs the decode delta, which is why ttfMs (not raw generation
t/s) is the objective auto-tune ranks on.

## Notes / knobs

- `TURBOLLM_MODEL_FILE` — override the GGUF (default `Qwen3.6-27B-Q4_K_M.gguf`; `Q5_K_M` also available).
- `TURBOLLM_MODEL_REPO` — override the HF repo the GGUF comes from (default `unsloth/Qwen3.6-27B-MTP-GGUF`).
- `TURBOLLM_EXTRA_MODEL_DIRS` — extra `:`-separated model dirs for `serve.sh` to register. Use
  this to keep a big GGUF off the 19.5 GB `/kaggle/working` quota — `/tmp` has ~1 TB free.
- `TURBOLLM_BUILD_JOBS` — compile parallelism (default `2`; raising it risks OOM on Kaggle's ~29 GB).
- Kaggle GPU sessions are time-limited (and quota'd ~30 h/week); the ~20-40 min first build eats into that. `setup.sh` is idempotent, so re-runs skip the build + model download.
- `/kaggle/working` persists within a session; the TurboQuant binary + model live there so a `serve.sh restart` is instant.
