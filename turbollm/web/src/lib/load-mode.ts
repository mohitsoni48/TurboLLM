// Which load-config UI a model gets is decided by the engine that will load it — NOT by the model format
// (safetensors dirs report format 'mlx' under any engine, so format can't tell MLX from vLLM). `'none'` covers an
// absent/unrecognised engine, and a Laya model, which always loads on the Laya engine (no launch flags) whatever
// engine is active (ADR-443): show sampling only, assume nothing.
import { readsOnlyLitert } from './engine-groups'
import type { Engine, ModelEntry } from './types'

export type LoadMode = 'llamacpp' | 'mlx' | 'rapid-mlx' | 'mlx-vlm' | 'vllm' | 'litert-lm' | 'none'

export function loadModeFor(model: Pick<ModelEntry, 'laya'>, activeEngine?: Pick<Engine, 'kind' | 'formats'>): LoadMode {
  if (model.laya) return 'none'
  if (activeEngine?.kind === 'turbollm-sdk') return sdkRowLoadMode(activeEngine.formats)
  switch (activeEngine?.kind) {
    case 'llama-server':
      return 'llamacpp'
    case 'mlx':
      return 'mlx'
    case 'rapid-mlx':
      return 'rapid-mlx'
    case 'mlx-vlm':
      return 'mlx-vlm'
    case 'vllm':
      return 'vllm'
    case 'litert-lm':
      return 'litert-lm'
    default:
      return 'none'
  }
}

/** The in-app SDK's LiteRT-LM row (it reads only .litertlm) takes LiteRT-LM's options (ADR-462): its backend reaches
 *  the SDK through litertLmConfig, its ctx and threads through the load request. Any other SDK row has no knobs. */
function sdkRowLoadMode(formats: Engine['formats']): LoadMode {
  return readsOnlyLitert(formats ?? []) ? 'litert-lm' : 'none'
}
