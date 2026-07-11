#!/usr/bin/env bash
# Bundle the freshly-built CUDA engine (llama-server + its ggml/llama/mtmd shared libs +
# the copied CUDA runtime libs) into ONE reusable tarball, so the ~40 min compile never
# has to happen again. Host the tarball (GitHub Release / HF / a public Kaggle dataset)
# and point setup.sh at it via TURBOLLM_ENGINE_URL, or attach it as a Kaggle input dataset
# named so it matches /kaggle/input/**/turboquant-cuda-t4*.tar.gz.
#
#   bash deploy/kaggle/publish_engine.sh
set -uo pipefail

WORK="${KAGGLE_WORKING:-/kaggle/working}"
ENGINE_DIR="$WORK/turboquant"
ENGINE_BIN="$ENGINE_DIR/build/bin/llama-server"
OUT="$WORK/turboquant-cuda-t4.tar.gz"

[ -x "$ENGINE_BIN" ] || { echo "No built binary at $ENGINE_BIN — run setup.sh first." >&2; exit 1; }

# The engine loads its sibling .so files from build/bin, so bundle the whole bin/ dir.
# Re-extracting into <engine>/build reproduces build/bin/llama-server exactly.
echo "Bundling $ENGINE_DIR/build/bin -> $OUT …"
tar -czf "$OUT" -C "$ENGINE_DIR/build" bin

SIZE="$(du -h "$OUT" | cut -f1)"
echo
echo "Wrote $OUT ($SIZE)"
echo "SHA256: $(sha256sum "$OUT" | cut -d' ' -f1)"
echo
echo "Next — host it once, then reuse forever:"
echo "  • GitHub Release:  gh release create kaggle-cuda-t4 $OUT -R <owner>/TurboLLM"
echo "                     then run with  TURBOLLM_ENGINE_URL=<asset-url>"
echo "  • Kaggle dataset:  upload $OUT as a dataset, attach it — setup.sh auto-detects"
echo "                     /kaggle/input/**/turboquant-cuda-t4*.tar.gz"
echo "  • Download now:    grab $OUT from the notebook's Output/Data panel."
