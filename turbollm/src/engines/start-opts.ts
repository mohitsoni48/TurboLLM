// The one StartOpts builder (D10, run 2026-09-13-autoload-last-model), shared by the manual Load path
// (`startEngine`, api/engine-lifecycle.ts) and the boot resume. The resume path used to keep its own
// copy, and it drifted from the Load button's: KoboldCpp got llama-server flags, vLLM lost
// --max-model-len and tensor-parallel, MLX lost its sampling args, and a pinned port was ignored.
//
// The bodies are startEngine's options-building moved as-is (engine-lifecycle.ts:107-153 at 4fa0f7b);
// only `trigger` became a parameter. Pure: it never reads the store or calls getSysInfo(), so a caller
// gets StartOpts for exactly the config snapshot and hardware it made its decision with.
import { type Config, type Engine, getModelProfile } from '../config/config'
import { koboldcppProfileToArgs } from './koboldcpp'
import type { StartOpts } from './manager'
import { mlxSamplingArgs } from './mlx'
import { type LoadProfile, profileToArgs, resolveProfile, vllmProfileToArgs } from '../models/profile'
import type { ModelEntry } from '../models/scanner'
import { type SysInfo, primaryVendor } from '../sysinfo/sysinfo'

export interface BuildStartOptsInput {
  /** Precondition: loadable (not incomplete, no parseError), a format the engine accepts, and not
   *  audio-rejected. Callers check; this function does not re-check. */
  entry: ModelEntry
  engine: Engine
  /** The snapshot the caller decided with; never re-read here. */
  cfg: Config
  sys: SysInfo
  overrides?: Partial<LoadProfile>
  trigger: NonNullable<StartOpts['trigger']>
}

export function buildStartOpts(input: BuildStartOptsInput): StartOpts {
  if (input.entry.format !== 'gguf') return buildModelDirectoryStartOpts(input)
  return buildGgufStartOpts(input)
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
  const extraArgs =
    engine.kind === 'mlx'
      ? mlxSamplingArgs(savedProfile?.sampling)
      : engine.kind === 'vllm'
        ? vllmProfileToArgs(profile, entry.nativeCtx)
        : []
  return {
    engine,
    model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: entry.vision },
    modelPath: entry.path,
    extraArgs,
    tensorParallelSize: savedProfile?.gpu?.tensorParallelSize,
    preferredPort: savedProfile?.port,
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
