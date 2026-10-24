// The one StartOpts builder (D10, run 2026-09-13-autoload-last-model), shared by the manual Load path
// (`startEngine`, api/engine-lifecycle.ts) and the boot resume. The resume path used to keep its own
// copy, and it drifted from the Load button's: KoboldCpp got llama-server flags, vLLM lost
// --max-model-len and tensor-parallel, MLX lost its sampling args, and a pinned port was ignored.
//
// The bodies are startEngine's options-building moved as-is (engine-lifecycle.ts:107-153 at 4fa0f7b);
// only `trigger` became a parameter. Pure: it never reads the store or calls getSysInfo(), so a caller
// gets StartOpts for exactly the config snapshot and hardware it made its decision with.
import { BUILTIN_MODEL_DEFAULT_CTX, type Config, type Engine, getModelProfile } from '../config/config'
import { engineAcceptsFormat, type ModelFormat } from './compat'
import { koboldcppProfileToArgs } from './koboldcpp'
import { litertLmProfileToConfig } from './litert-lm'
import type { StartOpts } from './manager'
import { mlxSamplingArgs } from './mlx'
import { type LoadProfile, legacySeedProfile, LITERT_RUNTIME_DEFAULT_CTX, profileToArgs, resolveProfile, userSetProfile, vllmProfileToArgs } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import { autoThreadCount, type SysInfo, primaryVendor } from '../sysinfo/sysinfo'

export interface BuildStartOptsInput {
  /** Precondition: loadable (not incomplete, no parseError). The automatic loads also check that the engine can run
   *  it (modelIncompatibility); a load the user asks for by hand starts it on the selected engine either way
   *  (compat.ts manualLoadRefusal). Callers check; this function does not re-check. */
  entry: ModelEntry
  engine: Engine
  /** The snapshot the caller decided with; never re-read here. */
  cfg: Config
  sys: SysInfo
  overrides?: Partial<LoadProfile>
  trigger: NonNullable<StartOpts['trigger']>
}

export function buildStartOpts(input: BuildStartOptsInput): StartOpts {
  const format = launchFormat(input.engine.kind, input.entry.format)
  if (format === 'litertlm') return buildLitertLmStartOpts(input)
  if (format !== 'gguf') return buildModelDirectoryStartOpts(input)
  return buildGgufStartOpts(input)
}

/** The format whose options the launch is built for: the model's own when the engine reads it, else the one the engine
 *  reads. A manual Load starts a model on the selected engine whatever its format (compat.ts manualLoadRefusal): built
 *  for the model's format, a GGUF on vLLM got llama.cpp's flags and a .litertlm under KoboldCpp the LiteRT-LM options,
 *  so the engine failed on arguments it does not take instead of on the file. Never differs for a model the engine
 *  runs, the only kind an automatic load starts. */
function launchFormat(engineKind: string, format: ModelFormat): ModelFormat {
  if (engineAcceptsFormat(engineKind, format)) return format
  if (engineKind === 'litert-lm') return 'litertlm'
  return engineAcceptsFormat(engineKind, 'gguf') ? 'gguf' : 'mlx'
}

function buildModelDirectoryStartOpts({ entry, engine, cfg, sys, overrides, trigger }: BuildStartOptsInput): StartOpts {
  // MLX / vLLM: the model dir is the launch target (no llama.cpp -ngl/ctx knobs).
  // MLX honors sampling defaults; vLLM honors its own load controls (F-027,
  // --max-model-len/--gpu-memory-utilization/--dtype/…) built via vllmProfileToArgs,
  // plus the multi-GPU shard count (ADR-054) mapped to --tensor-parallel-size below.
  const savedProfile = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
  // Resolved once regardless of engine kind (mlx's own arg-building doesn't need
  // it, but `model_load` telemetry — spec 23 §3.3 — wants the same full-config
  // shape for every engine, not just vLLM).
  const profile = resolveProfile(entry, sys, savedProfile, overrides, cfg.modelDefaults)
  // A "this load only" override (the load dialog with "Remember" unchecked) wins over the saved profile, as
  // in `profile`. MLX sampling and the shard count still read only what the user set, not `profile`'s
  // defaults: no args / undefined when nothing is set, as before.
  const extraArgs =
    engine.kind === 'mlx'
      ? mlxSamplingArgs({ ...savedProfile?.sampling, ...overrides?.sampling })
      : engine.kind === 'vllm'
        ? vllmProfileToArgs(profile, entry.nativeCtx, entry.jev)
        : []
  return {
    engine,
    model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: entry.vision },
    modelPath: entry.path,
    extraArgs,
    tensorParallelSize: overrides?.gpu?.tensorParallelSize ?? savedProfile?.gpu?.tensorParallelSize,
    preferredPort: profile.port,
    profile,
    trigger,
  }
}

function buildGgufStartOpts({ entry, engine, cfg, sys, overrides, trigger }: BuildStartOptsInput): StartOpts {
  const saved = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
  const profile = resolveProfile(entry, sys, saved, overrides, cfg.modelDefaults)
  // KoboldCpp is a GGUF engine with its OWN flag names — build its arg-map instead of
  // the llama-server profileToArgs. llamafile IS llama.cpp's server, so it keeps the
  // full profileToArgs flags (the manager only prepends --server --no-webui for it).
  const extraArgs =
    engine.kind === 'koboldcpp'
      ? koboldcppProfileToArgs(profile, primaryVendor(sys), sys.gpus.length > 0)
      : profileToArgs(profile, entry, engine.capabilities, sys.cores, sys, engine.binPath)
  return {
    engine,
    model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
    modelPath: entry.path,
    extraArgs,
    preferredPort: profile.port,
    profile,
    trigger,
  }
}

function buildLitertLmStartOpts({ entry, engine, cfg, sys, overrides, trigger }: BuildStartOptsInput): StartOpts {
  // LiteRT-LM: a single-file .litertlm bundle. Backend (cpu/gpu), context and threads reach the server through its
  // --config file (litertLmProfileToConfig); the model path itself travels in each request, not on the command line.
  const saved = getModelProfile(cfg, entry.key, engine.id) as Partial<LoadProfile> | undefined
  const resolved = resolveProfile(entry, sys, saved, overrides, cfg.modelDefaults)
  // The runtime clamps max_num_tokens to the bundle's KV-cache size anyway. Clamping here as well keeps the context
  // TurboLLM reports and compacts against the real one, not a slider value the bundle never had (a saved 128k on a
  // 4096-token export).
  const profile = entry.nativeCtx > 0 && resolved.ctx > entry.nativeCtx ? { ...resolved, ctx: entry.nativeCtx } : resolved
  // max_num_tokens only for a context the user set: a request's, the saved profile's own (userSetProfile), or Settings
  // > Model Defaults' when the user changed it. Without it the runtime applies the bundle's own default, with its own
  // rules (on a non-Apple GPU a default above 4096 is cut to 4096): it was always written, 8192 or the KV length.
  const userCtx = overrides?.ctx
    ?? userSetProfile(saved, legacySeedProfile(entry, sys, cfg.modelDefaults))?.ctx
    ?? (cfg.modelDefaults.ctx > 0 && cfg.modelDefaults.ctx !== BUILTIN_MODEL_DEFAULT_CTX ? cfg.modelDefaults.ctx : undefined)
  // The window the runtime opens when it chooses (engine_settings.cc), for what TurboLLM reports and compacts against.
  const gpuCut = userCtx === undefined && profile.litertLm.backend === 'gpu' && !sys.os.startsWith('darwin') && profile.ctx > LITERT_RUNTIME_DEFAULT_CTX
  const ctx = gpuCut ? LITERT_RUNTIME_DEFAULT_CTX : profile.ctx
  return {
    engine,
    // The bundle's own modalities (its header): a vision bundle is a vision model, which it was not before.
    model: { key: entry.key, name: entry.name, quant: entry.quant, ctx, vision: entry.vision },
    modelPath: entry.path,
    extraArgs: profile.extraArgs,
    // Auto threads are pinned only where the CPU is big.LITTLE (perfCores); elsewhere the runtime keeps choosing.
    litertLmConfig: litertLmProfileToConfig({ ...profile, ctx: userCtx === undefined ? 0 : profile.ctx }, sys.perfCores ? autoThreadCount(sys) : 0),
    preferredPort: profile.port,
    profile,
    trigger,
  }
}
