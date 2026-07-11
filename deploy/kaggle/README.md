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

All calls are loopback (no token). `B=http://localhost:6996`, `M` = model key (from
`GET $B/api/v1/models` after the model dir is registered — typically the filename).

1. **Engine surface** — confirm CUDA engine is active and dual-GPU is seen:
   ```python
   !curl -s localhost:6996/api/v1/sysinfo | python3 -m json.tool          # expect 2 GPUs
   !curl -s localhost:6996/api/v1/engines | python3 -m json.tool          # TurboQuant CUDA active
   ```
   In the GUI the hardware line should read **`2× Tesla T4 · 30 GB · Linux`**.

2. **Auto-tune** — run the built-in benchmark and capture the winner's tok/s + profile:
   ```python
   !curl -s -X POST localhost:6996/api/v1/bench -H 'content-type: application/json' -d "{\"modelKey\":\"$M\"}"
   # poll GET /api/v1/status → .bench ; then the full result + winner:
   !curl -s localhost:6996/api/v1/bench/log | python3 -m json.tool
   ```
   Note `winner.tps` (decode), `winner.prefillTps`, and `winner.params` (the split/offload
   that won — this is what chat must reuse).

3. **Chat with the winning profile** — apply the winner, load, measure real tok/s:
   ```python
   # apply winner via PUT /api/v1/models/$M/profile, POST /api/v1/engine/start, then a
   # streamed /v1/chat/completions and compute tok/s from usage + wall time.
   ```
   The **core comparison**: chat decode tok/s vs `winner.tps`. Consumer complaint = chat ≪
   auto-tune. Capture both numbers.

4. **Both GPUs actually working** — while a chat is generating:
   ```python
   !nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv
   ```
   Expect non-zero memory + util on **both** GPU 0 and GPU 1.

Record numbers per iteration; when a discrepancy is root-caused, fix on the branch, push,
pull, and re-run steps 2–4.

## Notes / knobs

- `TURBOLLM_MODEL_FILE` — override the GGUF (default `Qwen3.6-27B-Q4_K_M.gguf`; `Q5_K_M` also available).
- `TURBOLLM_BUILD_JOBS` — compile parallelism (default `2`; raising it risks OOM on Kaggle's ~29 GB).
- Kaggle GPU sessions are time-limited (and quota'd ~30 h/week); the ~20-40 min first build eats into that. `setup.sh` is idempotent, so re-runs skip the build + model download.
- `/kaggle/working` persists within a session; the TurboQuant binary + model live there so a `serve.sh restart` is instant.
