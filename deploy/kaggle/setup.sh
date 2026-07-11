#!/usr/bin/env bash
# TurboLLM on Kaggle (2×T4) — idempotent one-time setup. Safe to re-run; each step
# skips itself if already done, so the only thing a re-run really does after the first
# is `git pull` + rebuild the web UI (the fast half of the dev loop).
#
# Why build from source (this repo) instead of `npm i -g turbollm`: so fixes on the
# branch take effect. Why a native CUDA build of the TurboQuant fork instead of the
# prebuilt: Kaggle's container ships the NVIDIA driver but NO Vulkan ICD, so TurboLLM's
# default Linux/NVIDIA pick (Vulkan) silently runs on CPU. CUDA is the only backend that
# actually uses the two T4s here. Building ON the T4 box auto-detects sm_75 — no
# cross-arch / glibc juggling.
#
# Usage:  bash deploy/kaggle/setup.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"        # .../TurboLLM
WORK="${KAGGLE_WORKING:-/kaggle/working}"
ENGINE_DIR="$WORK/turboquant"
MODELS_DIR="$WORK/models"
TQ_REPO="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant"  # default branch = feature/turboquant-kv-cache
MODEL_REPO="unsloth/Qwen3.6-27B-MTP-GGUF"
MODEL_FILE="${TURBOLLM_MODEL_FILE:-Qwen3.6-27B-Q4_K_M.gguf}"           # ~17GB, fits across 2×T4 (30GB)
BUILD_JOBS="${TURBOLLM_BUILD_JOBS:-2}"                                 # cap parallelism — unbounded -j OOMs Kaggle's ~29GB

log()  { echo -e "\n\033[1;36m== $* ==\033[0m"; }
fail() { echo -e "\n\033[1;31mSETUP FAILED: $*\033[0m" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1) Node >= 22.13 (TurboLLM needs node:sqlite unflagged)
# ---------------------------------------------------------------------------
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".").map(Number)[0]))' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "Installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || fail "NodeSource setup failed"
  apt-get install -y --no-install-recommends nodejs || fail "node install failed"
fi
log "Node $(node -v)"

# ---------------------------------------------------------------------------
# 2) Build toolchain (cmake / gcc / curl+gomp runtime deps)
# ---------------------------------------------------------------------------
if ! command -v cmake >/dev/null; then
  log "Installing build toolchain"
  apt-get update -qq
  apt-get install -y --no-install-recommends cmake build-essential libcurl4-openssl-dev libgomp1 git \
    || fail "toolchain install failed"
fi
command -v nvcc >/dev/null || fail "nvcc not found — this notebook needs a GPU accelerator (Settings → Accelerator → GPU T4 x2)"
log "cmake $(cmake --version | head -1 | awk '{print $3}') · nvcc $(nvcc --version | grep -oiE 'release [0-9.]+' | head -1)"

# ---------------------------------------------------------------------------
# 3) TurboLLM deps + web UI (run-from-source serves web from turbollm/src/webdist)
# ---------------------------------------------------------------------------
log "TurboLLM npm deps + web build"
cd "$REPO_DIR/turbollm"
npm ci               || fail "npm ci (root) failed"
npm run build:web    || fail "web build failed"

# ---------------------------------------------------------------------------
# 4) Native CUDA build of the TurboQuant fork (auto-detects sm_75 on the T4)
# ---------------------------------------------------------------------------
if [ ! -x "$ENGINE_DIR/build/bin/llama-server" ]; then
  log "Cloning + building TurboQuant (CUDA), -j$BUILD_JOBS — expect ~20-30 min"
  rm -rf "$ENGINE_DIR"
  git clone --depth 1 "$TQ_REPO" "$ENGINE_DIR" || fail "clone failed"
  cd "$ENGINE_DIR"
  # Kaggle mounts the CUDA driver stub (libcuda.so) OUTSIDE the toolkit's default search
  # path, so FindCUDAToolkit can't resolve the CUDA::cuda_driver target ("target not found"
  # at configure time). Point CMAKE_LIBRARY_PATH at wherever libcuda.so actually lives.
  LIBCUDA_DIR="$(dirname "$(find / -name 'libcuda.so*' 2>/dev/null | head -1)")"
  log "libcuda.so dir: ${LIBCUDA_DIR:-<not found>}"
  cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
    ${LIBCUDA_DIR:+-DCMAKE_LIBRARY_PATH="$LIBCUDA_DIR"} || fail "cmake configure failed"
  cmake --build build -j"$BUILD_JOBS" --target llama-server || fail "compile failed"
  # A CUDA source build doesn't bundle the CUDA runtime libs; copy them next to the binary
  # or the engine silently falls back to CPU at load time.
  CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"
  for d in lib64 lib targets/x86_64-linux/lib; do
    cp "$CUDA_ROOT/$d/"libcudart.so* "$CUDA_ROOT/$d/"libcublas.so* "$CUDA_ROOT/$d/"libcublasLt.so* build/bin/ 2>/dev/null || true
  done
  log "Built $ENGINE_DIR/build/bin/llama-server"
else
  log "TurboQuant binary already built — skipping (rm -rf $ENGINE_DIR to force rebuild)"
fi

# ---------------------------------------------------------------------------
# 5) Model (Q4_K_M ~17GB) — big + dense enough that a 2×T4 tensor-split matters
# ---------------------------------------------------------------------------
mkdir -p "$MODELS_DIR"
if [ ! -f "$MODELS_DIR/$MODEL_FILE" ]; then
  log "Downloading $MODEL_FILE"
  pip install -q huggingface_hub || fail "huggingface_hub install failed"
  python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download('$MODEL_REPO','$MODEL_FILE',local_dir='$MODELS_DIR')" \
    || fail "model download failed"
else
  log "Model $MODEL_FILE already present — skipping"
fi

log "Setup complete — now run:  bash deploy/kaggle/serve.sh start"
