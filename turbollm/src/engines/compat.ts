// Engine ↔ model compatibility (ADR-044). The single source of truth for which
// model formats an engine kind can load. Used by the load guard (routes), the
// model-list overlay (filter by active engine), and the CLI auto-load. The web UI
// mirrors this rule in web/src/lib/engineCompat.ts — keep the two in sync.

import type { HardwareProfile } from './hardware'
import type { HardwareReq } from './catalog'
import type { GpuVendor } from '../sysinfo/sysinfo'

export type ModelFormat = 'gguf' | 'mlx'

/**
 * True when an engine of `engineKind` can load a model of `format`:
 *   - llama.cpp and its forks (e.g. TurboQuant + ik_llama.cpp, kind 'llama-server') → GGUF
 *   - llamafile (kind 'llamafile') → GGUF (it bundles llama.cpp's server)
 *   - KoboldCpp (kind 'koboldcpp') → GGUF (it wraps llama.cpp)
 *   - MLX (kind 'mlx') → MLX-format safetensors directories
 *   - Rapid-MLX (kind 'rapid-mlx') → the same MLX-format directories as the MLX engine
 *   - MLX-VLM (kind 'mlx-vlm') → the same MLX-format directories, for vision-language models
 *   - vLLM (kind 'vllm') → HF safetensors directories — the same on-disk shape the
 *     scanner tags 'mlx' (config.json + *.safetensors + tokenizer)
 */
export function engineAcceptsFormat(engineKind: string, format: ModelFormat): boolean {
  if (engineKind === 'mlx') return format === 'mlx'
  if (engineKind === 'rapid-mlx') return format === 'mlx'
  if (engineKind === 'mlx-vlm') return format === 'mlx'
  if (engineKind === 'vllm') return format === 'mlx'
  // llama-server / forks, llamafile, koboldcpp — all GGUF.
  return format === 'gguf'
}

/**
 * True when `engineKind` is known to fail loading a model with an audio tower/encoder
 * (`ModelEntry.audio`). Rapid-MLX bundles `mlx_vlm` for VLM support; its gemma4
 * `sanitize()` unconditionally transposes `subsample_conv_projection.conv.weight`
 * assuming a raw PyTorch-layout checkpoint, but MLX-native checkpoints already store
 * it in MLX layout — the load double-transposes and crashes with a shape-mismatch
 * `ValueError`. Confirmed live, reproduced even after upgrading to the latest
 * available `mlx-vlm` (0.6.4) — not a missing file, not fixable by re-downloading.
 * The plain MLX engine (`mlx-lm`) never attempts VLM/audio loading at all, so it's
 * unaffected — only Rapid-MLX is excluded here. Vision-only models (no audio_config)
 * are NOT excluded; only the confirmed-broken audio path is.
 *
 * MLX-VLM (kind 'mlx-vlm') is excluded here PRECAUTIONARILY, not on a fresh live
 * reproduction: it's the very same `mlx_vlm` package Rapid-MLX vendors, and the
 * gemma3n/gemma4 audio-tower source (including the same `sanitize()` transpose) is
 * still present at the currently-pinned version — but this was verified by reading
 * the installed package's source, not by loading a live audio-tower model end to end.
 * Treat this exclusion as untested-but-likely-still-broken; remove it if a future
 * mlx-vlm release fixes the underlying bug and someone reverifies live.
 */
export function engineRejectsAudioModel(engineKind: string): boolean {
  return engineKind === 'rapid-mlx' || engineKind === 'mlx-vlm'
}

/**
 * The value an OpenAI-compatible request must put in its `model` field for this engine.
 *
 * llama.cpp ignores the field (it serves the single loaded model), so we leave the
 * caller's value alone. llamafile (llama.cpp's server) and KoboldCpp likewise ignore it
 * and serve the single loaded model, so they too keep the caller's value (null).
 * mlx-lm and vLLM, however, treat `model` as the model to serve
 * and 404 (vLLM) or fail to load (mlx-lm) if it doesn't match a known name — they would
 * never match TurboLLM's internal model key (a display name with spaces). We launch both
 * under the fixed alias `default_model` (mlx-lm's built-in alias for its `--model`; vLLM
 * via `--served-model-name`), so requests must send exactly that. Rapid-MLX has no
 * `--served-model-name`-style launch flag — its own convention is the fixed literal
 * "default", always accepted for whatever model is currently serving regardless of what
 * was passed on the command line. Returns null when the engine ignores the field and the
 * original value should be kept.
 *
 * MLX-VLM is a THIRD shape, distinct from both of the above: it neither ignores the
 * field nor accepts a fixed alias — it resolves `model` as a real, load-bearing model
 * path/repo id on every request (verified live: passed straight to
 * `get_cached_model(model_path, ...)`, cached by `(model_path, adapter_path, kind)`,
 * loaded on demand if not already cached). There is no fixed literal that works
 * regardless of which model is loaded, so callers must pass the actual local model
 * directory path — the same value used to launch the engine (`StartOpts.modelPath` /
 * `Manager.currentOpts()?.modelPath`), NOT TurboLLM's internal display-name `model.key`.
 * That's why this function takes an optional `modelPath` — every call site must thread
 * it through for the 'mlx-vlm' case (falls back to null, same as an unrecognized/ignoring
 * engine, if the caller has none available).
 */
export const ENGINE_MODEL_ALIAS = 'default_model'
export const RAPID_MLX_MODEL_ALIAS = 'default'
export function engineModelAlias(engineKind: string, modelPath?: string | null): string | null {
  if (engineKind === 'rapid-mlx') return RAPID_MLX_MODEL_ALIAS
  if (engineKind === 'mlx-vlm') return modelPath ?? null
  return engineKind === 'mlx' || engineKind === 'vllm' || engineKind === 'sglang' ? ENGINE_MODEL_ALIAS : null
}

// ─── Hardware ↔ variant matching (engine overhaul, Phase 1) ──────────────────
// PURE matcher: given a HardwareProfile and a variant's HardwareReq, decide
// whether this box can run the variant, with a human-readable reason when not.
// No I/O, no detection (detection lives in hardware.ts) — so it's trivially
// testable and the same code drives both the recommender and the UI.

const VENDOR_DISPLAY: Record<GpuVendor, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  apple: 'Apple Silicon',
  arm: 'ARM Mali',
  qualcomm: 'Qualcomm Adreno',
  unknown: 'no detected GPU',
}

const PLATFORM_DISPLAY: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  android: 'Android',
}

function platformName(p: NodeJS.Platform): string {
  return PLATFORM_DISPLAY[p] ?? p
}

/** Humanize an allowed-platform set, e.g. ['darwin'] → 'macOS only',
 *  ['win32','linux'] → 'Windows & Linux only'. */
function platformReason(allowed: NodeJS.Platform[]): string {
  const names = allowed.map(platformName)
  const joined = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
  return `${joined} only`
}

/**
 * True when `p` satisfies every present constraint in `r`. A *missing* signal
 * never causes a false exclusion: if we couldn't detect VRAM (p.vramMb === 0)
 * we skip the VRAM gate rather than reject. `minCudaCC` is accepted but NOT
 * enforced in v1 (we can't reliably detect compute capability yet).
 */
export function evaluateVariant(p: HardwareProfile, r: HardwareReq): { ok: boolean; reason?: string } {
  if (r.platform && !r.platform.includes(p.platform)) {
    return { ok: false, reason: platformReason(r.platform) }
  }
  if (r.arch && !r.arch.includes(p.arch)) {
    return { ok: false, reason: `Needs ${r.arch.join(' / ')}` }
  }
  if (r.gpuVendor && !r.gpuVendor.includes(p.gpuVendor)) {
    const needs = r.gpuVendor.map((v) => VENDOR_DISPLAY[v]).join(' / ')
    const article = /^[NAEIO]/.test(needs) ? 'an' : 'a'
    return { ok: false, reason: `Needs ${article} ${needs} GPU — you have ${VENDOR_DISPLAY[p.gpuVendor]}` }
  }
  // Only gate on VRAM when we actually have a reading (p.vramMb > 0).
  if (r.minVramMb !== undefined && p.vramMb > 0 && p.vramMb < r.minVramMb) {
    const gb = Math.round(r.minVramMb / 1024)
    return { ok: false, reason: `Needs ~${gb} GB VRAM` }
  }
  // minCudaCC: intentionally ignored in v1 (tiered gating, see HardwareReq).
  return { ok: true }
}
