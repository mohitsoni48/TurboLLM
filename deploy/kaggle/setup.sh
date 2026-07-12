#!/usr/bin/env bash
# TurboLLM on Kaggle (2×T4) — idempotent setup. Designed so a FRESH session (Kaggle
# resets system packages each start, but /kaggle/working persists) is FAST: the ~40-min
# CUDA build and the 17 GB model download happen exactly once and are then skipped; npm
# install and the web build only re-run when the git commit actually changed.
#
# First run  : Node + toolchain + npm + web + CUDA build + model  (~40 min, one time)
# Later runs : Node (~1 min) + [everything else cached]           (~1-2 min)
#
# Why a native CUDA build of the TurboQuant fork (not the prebuilt): Kaggle ships the
# NVIDIA driver but NO Vulkan ICD, so TurboLLM's default Linux/NVIDIA pick (Vulkan)
# silently runs on CPU. CUDA is the only backend that uses the two T4s here. Building ON
# the T4 auto-detects sm_75 — no cross-arch / glibc juggling.
#
# Usage:  bash deploy/kaggle/setup.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"        # .../TurboLLM
TLLM_DIR="$REPO_DIR/turbollm"
WORK="${KAGGLE_WORKING:-/kaggle/working}"
# Where the engine lives. The one-click notebook sets this to /tmp so the 3.8 GB extracted
# engine doesn't eat the 19.5 GB /kaggle/working OUTPUT quota — leaving that free for models
# the user downloads in the GUI. Default keeps the old in-/kaggle/working location.
ENGINE_DIR="${TURBOLLM_ENGINE_ROOT:-$WORK/turboquant}"
ENGINE_BIN="$ENGINE_DIR/build/bin/llama-server"
MODELS_DIR="$WORK/models"
WEB_STAMP="$WORK/.webdist-commit"
TQ_REPO="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant"  # default branch = feature/turboquant-kv-cache
MODEL_REPO="unsloth/Qwen3.6-27B-MTP-GGUF"
MODEL_FILE="${TURBOLLM_MODEL_FILE:-Qwen3.6-27B-Q4_K_M.gguf}"           # ~17GB, fits across 2×T4 (30GB)
BUILD_JOBS="${TURBOLLM_BUILD_JOBS:-2}"                                 # cap parallelism — unbounded -j OOMs Kaggle's ~29GB

log()  { echo -e "\n\033[1;36m== $* ==\033[0m"; }
skip() { echo -e "   \033[0;32m✓ $*\033[0m"; }
fail() { echo -e "\n\033[1;31mSETUP FAILED: $*\033[0m" >&2; exit 1; }

CUR_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"

# Locate a PREBUILT engine bundle up front — its presence lets us skip BOTH the ~40 min compile
# and the build-toolchain apt install below:
#   a) $TURBOLLM_ENGINE_URL  b) an attached Kaggle dataset (tarball)  c) a local bundle in /kaggle/working.
find_prebuilt() {
  [ -n "${TURBOLLM_ENGINE_URL:-}" ] && { echo "$TURBOLLM_ENGINE_URL"; return; }
  local t
  # Depth of /kaggle/input mounts varies (observed both /kaggle/input/<slug>/… and
  # /kaggle/input/datasets/<owner>/<slug>/… on different Kaggle accounts/notebook types) —
  # `find` searches any depth instead of guessing one.
  t="$(find /kaggle/input -maxdepth 6 -iname 'turboquant-cuda-t4*.tar.gz' 2>/dev/null | head -1)"
  [ -n "$t" ] && { echo "$t"; return; }
  [ -f "$WORK/turboquant-cuda-t4.tar.gz" ] && echo "$WORK/turboquant-cuda-t4.tar.gz"
}
PREBUILT="$(find_prebuilt)"

# ALSO check for a RAW (already-extracted) engine dir on an attached Kaggle dataset — e.g. a
# tarball uploaded via Kaggle's "New Dataset" web UI, which auto-extracts archives on upload, so
# no turboquant-cuda-t4*.tar.gz ever lands on disk even though the exact same files are there
# (verified: the dataset that publish_engine.sh's tarball produces ends up mounted at
# .../bin/llama-server + its sibling .so files, at whatever depth Kaggle chose for this input).
# Cheaper than the tarball path — no download/extract, symlink straight into /kaggle/input
# (read-only, which is fine — we only execute from it).
find_raw_engine_dir() {
  dirname "$(find /kaggle/input -maxdepth 7 -path '*/bin/llama-server' 2>/dev/null | head -1)" 2>/dev/null
}
RAW_ENGINE_DIR="$(find_raw_engine_dir)"
[ "$RAW_ENGINE_DIR" = "." ] && RAW_ENGINE_DIR=""

# ---------------------------------------------------------------------------
# 1) Node >= 22.13 (TurboLLM needs node:sqlite unflagged) — needed EVERY session
# ---------------------------------------------------------------------------
log "Node.js"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".").map(Number)[0]))' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "   installing Node 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || fail "NodeSource setup failed"
  apt-get install -y --no-install-recommends nodejs >/dev/null 2>&1 || fail "node install failed"
fi
echo "   Node $(node -v)"

# ---------------------------------------------------------------------------
# 2) Runtime shared libs the CUDA binary loads (libgomp / libcurl) — usually already
#    present on Kaggle, so this is a fast check that skips apt entirely in that case.
# ---------------------------------------------------------------------------
log "Engine runtime libs"
need_rt=""
ldconfig -p 2>/dev/null | grep -q 'libgomp\.so\.1'  || need_rt="$need_rt libgomp1"
ldconfig -p 2>/dev/null | grep -q 'libcurl\.so\.4'  || need_rt="$need_rt libcurl4"
if [ -n "$need_rt" ]; then
  echo "   installing:$need_rt"
  apt-get update -qq && apt-get install -y --no-install-recommends $need_rt >/dev/null 2>&1 || fail "runtime libs install failed"
else
  skip "libgomp/libcurl already present"
fi

# ---------------------------------------------------------------------------
# 3) Build toolchain — ONLY needed to compile the engine. Skipped once the binary exists.
# ---------------------------------------------------------------------------
if [ ! -x "$ENGINE_BIN" ] && [ -z "$PREBUILT" ] && [ -z "$RAW_ENGINE_DIR" ]; then
  log "Build toolchain (cmake / gcc)"
  command -v cmake >/dev/null || { apt-get update -qq && apt-get install -y --no-install-recommends cmake build-essential libcurl4-openssl-dev git >/dev/null 2>&1; } || fail "toolchain install failed"
  command -v nvcc  >/dev/null || fail "nvcc not found — enable the GPU accelerator (Settings → Accelerator → GPU T4 x2)"
  echo "   cmake $(cmake --version | head -1 | awk '{print $3}') · nvcc $(nvcc --version | grep -oiE 'release [0-9.]+' | head -1)"
fi

# ---------------------------------------------------------------------------
# 4) TurboLLM npm deps (cached across sessions) + web UI (rebuilt only when the commit
#    changed, so a `git pull` that touches the UI is reflected but re-runs are instant).
# ---------------------------------------------------------------------------
log "TurboLLM deps + web UI"
cd "$TLLM_DIR"
if [ -x node_modules/.bin/tsx ]; then
  skip "npm deps present"
else
  echo "   npm ci…"; npm ci >/dev/null 2>&1 || fail "npm ci failed"
fi
if [ -f src/webdist/index.html ] && [ "$(cat "$WEB_STAMP" 2>/dev/null)" = "$CUR_COMMIT" ]; then
  skip "web UI up to date (commit ${CUR_COMMIT:0:8})"
else
  echo "   building web UI…"; npm run build:web >/dev/null 2>&1 || fail "web build failed"
  echo "$CUR_COMMIT" > "$WEB_STAMP"
fi

# ---------------------------------------------------------------------------
# 5) CUDA engine. Prefer a PREBUILT bundle (so nobody re-runs the ~40 min compile):
#    a) a RAW engine dir on an attached Kaggle dataset — /kaggle/input/**/bin/llama-server
#       (symlinked in place, no download/extract — see find_raw_engine_dir above)
#    b) $TURBOLLM_ENGINE_URL — a http(s) URL to turboquant-cuda-t4.tar.gz
#    c) an attached Kaggle dataset (tarball) — /kaggle/input/**/turboquant-cuda-t4*.tar.gz
#    d) a local bundle left in /kaggle/working by publish_engine.sh
#    Only when none is found do we build from source. Kaggle wipes /kaggle/working on
#    session stop, so hosting the bundle (a/b/c) is what makes this a one-time cost.
# ---------------------------------------------------------------------------
if [ -x "$ENGINE_BIN" ]; then
  log "CUDA engine"; skip "already built: $ENGINE_BIN  (rm -rf $ENGINE_DIR to force rebuild)"
elif [ -n "$RAW_ENGINE_DIR" ]; then
  log "CUDA engine — copying a raw engine dir attached as a Kaggle dataset (no build needed)"
  # Kaggle's dataset upload strips the executable bit (verified: llama-server lands 644 on
  # /kaggle/input), and that mount is read-only anyway — so a SYMLINK straight into it fails
  # `-x` and can't be chmod'd in place. Copy the ~2.7 GB bin/ dir to /tmp instead (off the
  # /kaggle/working quota, same as the tarball path) and fix the permissions on the copy.
  mkdir -p "$ENGINE_DIR/build"
  rm -rf "$ENGINE_DIR/build/bin"
  cp -r "$RAW_ENGINE_DIR" "$ENGINE_DIR/build/bin" || fail "copying $RAW_ENGINE_DIR failed"
  # `chmod +x` (not `u+X`, which only propagates an EXISTING exec bit and does nothing for a
  # plain 644 file like the uploaded llama-server) — unconditionally executable, matching what
  # a normal build produces for everything under bin/.
  chmod -R +rx "$ENGINE_DIR/build/bin"
  [ -x "$ENGINE_BIN" ] || fail "copied $RAW_ENGINE_DIR but $ENGINE_BIN is still missing/not executable"
  skip "copied: $ENGINE_BIN  (from $RAW_ENGINE_DIR)"
elif [ -n "$PREBUILT" ]; then
  log "CUDA engine — reusing prebuilt bundle (skips the ~40 min build)"
  mkdir -p "$ENGINE_DIR/build"
  if [[ "$PREBUILT" == http* ]]; then
    echo "   downloading $PREBUILT"
    curl -fSL "$PREBUILT" -o /tmp/tq-cuda-t4.tar.gz || fail "prebuilt download failed"
    tar -xzf /tmp/tq-cuda-t4.tar.gz -C "$ENGINE_DIR/build" || fail "prebuilt extract failed"
  else
    echo "   extracting $PREBUILT"
    tar -xzf "$PREBUILT" -C "$ENGINE_DIR/build" || fail "prebuilt extract failed"
  fi
  [ -x "$ENGINE_BIN" ] || fail "prebuilt extracted but $ENGINE_BIN is missing"
  skip "prebuilt ready: $ENGINE_BIN"
else
  log "Building TurboQuant CUDA engine, -j$BUILD_JOBS — ONE TIME, expect ~30-40 min"
  rm -rf "$ENGINE_DIR"
  git clone --depth 1 "$TQ_REPO" "$ENGINE_DIR" || fail "clone failed"
  cd "$ENGINE_DIR"
  # Kaggle mounts the CUDA driver stub (libcuda.so) OUTSIDE the toolkit's default search
  # path, so FindCUDAToolkit can't resolve the CUDA::cuda_driver target ("target not found"
  # at configure time). Point CMAKE_LIBRARY_PATH at wherever libcuda.so actually lives.
  LIBCUDA_DIR="$(dirname "$(find / -name 'libcuda.so*' 2>/dev/null | head -1)")"
  echo "   libcuda.so dir: ${LIBCUDA_DIR:-<not found>}"
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
  [ -x "$ENGINE_BIN" ] || fail "compile finished but $ENGINE_BIN is missing"
  echo "   Built $ENGINE_BIN"
fi

# ---------------------------------------------------------------------------
# 6) Model (Q4_K_M ~17GB) — big + dense enough that a 2×T4 tensor-split matters.
#    hf_hub_download resumes a partial file, so an interrupted download self-heals.
# ---------------------------------------------------------------------------
log "Model"
mkdir -p "$MODELS_DIR"
# One-click flow ships WITHOUT a baked-in model: the user picks one in the GUI's model
# downloader (lands in $MODELS_DIR) or attaches a Kaggle model (served from /kaggle/input,
# which serve.sh also registers). Set TURBOLLM_SKIP_MODEL=1 to skip the download entirely.
if [ -n "${TURBOLLM_SKIP_MODEL:-}" ]; then
  skip "model download skipped (TURBOLLM_SKIP_MODEL) — choose one in the GUI or attach a Kaggle model"
elif [ -f "$MODELS_DIR/$MODEL_FILE" ]; then
  skip "already present ($(du -h "$MODELS_DIR/$MODEL_FILE" | cut -f1))"
else
  echo "   downloading…"
  pip install -q huggingface_hub >/dev/null 2>&1 || fail "huggingface_hub install failed"
  python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download('$MODEL_REPO','$MODEL_FILE',local_dir='$MODELS_DIR')" \
    || fail "model download failed"
fi

echo -e "\n\033[1;32m== Setup complete — next: bash deploy/kaggle/serve.sh start ==\033[0m"
