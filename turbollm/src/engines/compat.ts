// Engine ↔ model compatibility (ADR-044). The single source of truth for which
// model formats an engine kind can load. Used by the load guard (routes), the
// model-list overlay (filter by active engine), and the CLI auto-load.

import type { HardwareProfile } from './hardware'
import type { HardwareReq } from './catalog'
import type { GpuVendor } from '../sysinfo/sysinfo'
import type { ModelEntry } from '../models/scanner'

export type ModelFormat = 'gguf' | 'mlx' | 'litertlm'

export type Incompatibility =
  | { code: 'format'; label: string; message: string }
  | { code: 'audio'; label: string; message: string }
  | { code: 'needs_vllm'; label: 'Needs vLLM (Linux or WSL2)'; message: string }
  | { code: 'needs_laya'; label: 'Needs the Laya engine'; message: string }

/** null = the engine of `engineKind` can load `entry`. Order: needs_laya and needs_vllm (most specific), then
 *  format, then audio. The ONE place this rule lives; engineAcceptsFormat/engineRejectsAudioModel
 *  stay exported as its building blocks. `label` is the short text a model row shows. */
export function modelIncompatibility(
  engineKind: string,
  entry: Pick<ModelEntry, 'format' | 'audio' | 'jev' | 'laya'> & Partial<Pick<ModelEntry, 'arch'>>,
): Incompatibility | null {
  if (entry.format === 'gguf' && entry.arch === GGMLC_ARCH) return GGMLC_GGUF
  if (entry.laya) return engineKind === 'laya' ? null : NEEDS_LAYA
  if (entry.jev && engineKind !== 'vllm') return needsVllm(engineKind)
  if (!engineAcceptsFormat(engineKind, entry.format)) return formatIncompatibility(engineKind, entry.format)
  if (entry.audio && engineRejectsAudioModel(engineKind)) return audioIncompatibility(engineKind)
  return null
}

/** What refuses a load the user asks for by hand (a Models screen Load, the Load dialog, a model picker, an Engines
 *  Start: POST /api/v1/engine/start, which the Turbo Link façade's load mounts too for a model it lists to the peer,
 *  link-routes.ts hiddenFromPeer) before it starts: only a Laya model with no Laya engine installed, since a Laya
 *  model never loads on the selected engine (registry.engineForModel).
 *  Every other model is started on the selected engine whatever modelIncompatibility says of it, and if that engine
 *  cannot load it the load fails with the engine's own error (the load-failure banner): the user chose both the engine
 *  and the model, and nothing may pick or suggest another engine for them. The pre-refusal ("activate the LiteRT-LM
 *  engine to load it" for a .litertlm model under KoboldCpp) did. The automatic loads (the gateway's auto-swap, a
 *  routine's swap and restore, the boot resume, ComfyUI's reload) keep modelIncompatibility's refusal while Settings
 *  lists only the models the selected engine runs: started anyway, each would unload the running model for a load
 *  that cannot succeed, with nobody asking for it. With "Show models for every engine" on (showAllEngineModels) they
 *  take this refusal too: once the user shows such models, one is always started on the selected engine, and if it
 *  fails there it fails (model-router.ts loadRefusal, auto-load.ts). */
export function manualLoadRefusal(
  engineKind: string,
  entry: Parameters<typeof modelIncompatibility>[1],
): Incompatibility | null {
  return entry.laya ? modelIncompatibility(engineKind, entry) : null
}

// The refusal messages state what the selected engine cannot run, and nothing else: no other engine, no "activate",
// "switch to" or "pick" advice. A model loads only on the engine the user selected, and choosing another is the user's
// alone; the load-failure banner dropped the same advice ("fix(engines): a failed load's banner names the engine,
// offers no other"). They reach users through the gateway's 503 (Claude Code and other API clients), a routine run's
// model_unavailable error, the Jev endpoints and the Turbo Link façade's 409, whose peer cannot change the host's engine
// at all. A Laya model is the exception: it never runs on the selected engine, only on the Laya engine, so NEEDS_LAYA
// says to install it (and GGMLC_GGUF names the Laya download that runs).

/** The engine a kind names in a refusal: the selected one, since a refusal is only ever for it. */
const ENGINE_NAMES: Record<string, string> = {
  'llama-server': 'llama.cpp',
  llamafile: 'llamafile',
  koboldcpp: 'KoboldCpp',
  mlx: 'MLX',
  'rapid-mlx': 'Rapid-MLX',
  'mlx-vlm': 'MLX-VLM',
  vllm: 'vLLM',
  sglang: 'SGLang',
  'litert-lm': 'LiteRT-LM',
  laya: 'The Laya engine',
}

function engineName(engineKind: string): string {
  return ENGINE_NAMES[engineKind] ?? 'The selected engine'
}

const FORMAT_NAMES: Record<ModelFormat, string> = { gguf: 'GGUF', mlx: 'safetensors', litertlm: '.litertlm' }

function needsVllm(engineKind: string): Incompatibility {
  return {
    code: 'needs_vllm',
    label: 'Needs vLLM (Linux or WSL2)',
    message: `${engineName(engineKind)} can't run this Jev model.`,
  }
}

const NEEDS_LAYA: Incompatibility = {
  code: 'needs_laya',
  label: 'Needs the Laya engine',
  message: 'This is a Laya model — it runs only on the Laya engine. Install Laya from Engines to load it.',
}

/** The architecture of the Laya GGUF conversions on Hugging Face (mys/laya-GGUF and friends): a separate runtime,
 *  which llama.cpp refuses with "unknown model architecture: 'ggmlc'" — so every engine refuses it up front. */
const GGMLC_ARCH = 'ggmlc'

const GGMLC_GGUF: Incompatibility = {
  code: 'format',
  label: 'ggmlc GGUF — not loadable',
  message:
    "This GGUF uses the ggmlc architecture, which llama.cpp can't load. For Laya, download " +
    'convaiinnovations/laya instead: it runs on the Laya engine.',
}

/** The refusal of a model no engine the user can select runs: a Laya model with no Laya engine (it runs only on the
 *  Laya engine, and is refused whatever Settings shows: manualLoadRefusal), or a ggmlc GGUF (refused up front for every
 *  engine kind; with "Show models for every engine" on, an automatic load starts it on the selected engine, as a
 *  manual load does, and it fails there). An automatic load's refusal of any other model says which setting lets it
 *  start on the selected engine (model-router.ts AUTOMATIC_LOAD_HINT); after these two that sentence would be advice
 *  to turn on a setting that cannot make the model load, and after the ggmlc one's "it runs on the Laya engine" its
 *  "start it there" would name the Laya engine. */
export function refusedOnEveryEngine(inc: Incompatibility): boolean {
  return inc.code === 'needs_laya' || inc === GGMLC_GGUF
}

const NEEDS_PYTHON_ENGINE_LABEL = 'needs MLX or vLLM'

function formatIncompatibility(engineKind: string, format: ModelFormat): Incompatibility {
  const label = format === 'gguf' ? 'needs llama.cpp' : format === 'litertlm' ? 'needs LiteRT-LM' : NEEDS_PYTHON_ENGINE_LABEL
  return { code: 'format', label, message: formatMismatchMessage(engineKind, format) }
}

/** User-facing message when the active engine can't load a model's format (ADR-044): the engine and the format, no
 *  advice (see ENGINE_NAMES). It said which engine to activate or switch to ("activate the LiteRT-LM engine to load
 *  it", "or switch to a llama.cpp engine for GGUF"). */
function formatMismatchMessage(engineKind: string, format: ModelFormat): string {
  if (engineKind === 'laya') return 'The Laya engine runs only Laya models.'
  return `${engineName(engineKind)} can't run this ${FORMAT_NAMES[format]} model.`
}

function audioIncompatibility(engineKind: string): Incompatibility {
  const engineLabel = engineKind === 'mlx-vlm' ? 'MLX-VLM' : 'Rapid-MLX'
  // Rapid-MLX: confirmed live, reproduced end to end (see engineRejectsAudioModel's
  // docblock). MLX-VLM: same underlying mlx_vlm sanitizer bug, but excluded here
  // precautionarily from reading the source, not a fresh live reproduction — say so
  // rather than stating it as flatly settled. It no longer ends with "Switch to the MLX
  // engine instead." (see ENGINE_NAMES).
  const certainty = engineKind === 'mlx-vlm' ? 'is expected to fail' : 'fails'
  return {
    code: 'audio',
    label: NEEDS_PYTHON_ENGINE_LABEL,
    message: `${engineLabel} cannot load models with an audio tower — the audio encoder ${certainty} due to an upstream mlx-vlm bug in the sanitizer for these architectures.`,
  }
}

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
 *   - SGLang (kind 'sglang') → the same HF safetensors directories as vLLM
 *   - LiteRT-LM (kind 'litert-lm') → `.litertlm` bundles, a format no other engine reads
 *   - Laya (kind 'laya') → no plain format: it loads only Laya models, which modelIncompatibility
 *     recognises by `entry.laya` before the format is ever checked
 */
export function engineAcceptsFormat(engineKind: string, format: ModelFormat): boolean {
  if (engineKind === 'mlx') return format === 'mlx'
  if (engineKind === 'rapid-mlx') return format === 'mlx'
  if (engineKind === 'mlx-vlm') return format === 'mlx'
  if (engineKind === 'vllm') return format === 'mlx'
  if (engineKind === 'sglang') return format === 'mlx'
  if (engineKind === 'laya') return false
  // .litertlm is LiteRT-LM's alone, and LiteRT-LM reads nothing else.
  if (engineKind === 'litert-lm') return format === 'litertlm'
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
  // LiteRT-LM is the same shape as MLX-VLM: its `model` field is a real, load-bearing reference (here the .litertlm
  // file path), not a name it ignores and not an alias it was launched under.
  if (engineKind === 'litert-lm') return modelPath ?? null
  return engineKind === 'mlx' || engineKind === 'vllm' || engineKind === 'sglang' ? ENGINE_MODEL_ALIAS : null
}

/**
 * LiteRT-LM's server only honors `max_completion_tokens`; a plain `max_tokens` is silently ignored, so a capped request
 * would run to the context limit. Moves the cap to the key that engine reads. No-op for every other engine.
 *
 * When the request names BOTH keys, the smaller of the two wins. Both name the same cap (OpenAI's deprecated
 * `max_tokens` and its replacement `max_completion_tokens`), and every caller clamps `max_tokens` against the daemon's
 * max-token limit just before this runs — so the smaller value is the only one guaranteed to still respect that limit.
 * The old "explicit `max_completion_tokens` wins" let a client bypass the daemon cap entirely by sending
 * `max_completion_tokens: 1000000` alongside a clamped `max_tokens` (which was then deleted). Mutates and returns `body`.
 *
 * ORDERING CONTRACT (PR #271 re-review): the min() above enforces the daemon cap only because the
 * clamp ran first — with a limit configured, clampMaxTokens ALWAYS leaves a numeric `max_tokens`
 * in the body (the limit itself when the request sent none), so the min() can never pair an
 * uncapped `max_completion_tokens` with a missing `max_tokens`. A body with `max_completion_tokens`
 * but NO `max_tokens` returns untouched at the guard below, which is correct only while no limit
 * is configured. Any new caller MUST run clampMaxTokens immediately before this — the ordering
 * test in compat.litert-lm.test.ts locks the shape every route produces.
 */
export function applyEngineTokenLimit<T extends Record<string, unknown>>(engineKind: string, body: T): T {
  if (engineKind !== 'litert-lm' || !('max_tokens' in body)) return body
  const b = body as Record<string, unknown>
  if (b.max_completion_tokens != null && b.max_tokens != null) {
    const capped = Number(b.max_tokens)
    const explicit = Number(b.max_completion_tokens)
    // Non-numeric values are none of our business: pass them through untouched (the old
    // behavior) rather than fabricate NaN.
    if (Number.isFinite(capped) && Number.isFinite(explicit)) b.max_completion_tokens = Math.min(capped, explicit)
  } else if (b.max_tokens != null) {
    b.max_completion_tokens = b.max_tokens
  }
  delete b.max_tokens
  return body
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
