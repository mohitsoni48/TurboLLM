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

## Notes / knobs

- `TURBOLLM_MODEL_FILE` — override the GGUF (default `Qwen3.6-27B-Q4_K_M.gguf`; `Q5_K_M` also available).
- `TURBOLLM_MODEL_REPO` — override the HF repo the GGUF comes from (default `unsloth/Qwen3.6-27B-MTP-GGUF`).
- `TURBOLLM_EXTRA_MODEL_DIRS` — extra `:`-separated model dirs for `serve.sh` to register. Use
  this to keep a big GGUF off the 19.5 GB `/kaggle/working` quota — `/tmp` has ~1 TB free.
- `TURBOLLM_BUILD_JOBS` — compile parallelism (default `2`; raising it risks OOM on Kaggle's ~29 GB).
- Kaggle GPU sessions are time-limited (and quota'd ~30 h/week); the ~20-40 min first build eats into that. `setup.sh` is idempotent, so re-runs skip the build + model download.
- `/kaggle/working` persists within a session; the TurboQuant binary + model live there so a `serve.sh restart` is instant.
