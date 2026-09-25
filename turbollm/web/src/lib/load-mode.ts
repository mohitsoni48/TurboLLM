// Which load-config UI a model gets is decided by the engine that will load it — NOT by the model format
// (safetensors dirs report format 'mlx' under any engine, so format can't tell MLX from vLLM). `'none'` covers an
// absent/unrecognised engine, and a Laya model, which always loads on the Laya engine (no launch flags) whatever
// engine is active (ADR-443): show sampling only, assume nothing.
import type { ModelEntry } from './types'

export type LoadMode = 'llamacpp' | 'mlx' | 'rapid-mlx' | 'mlx-vlm' | 'vllm' | 'none'

export function loadModeFor(model: Pick<ModelEntry, 'laya'>, activeEngineKind: string | undefined): LoadMode {
  if (model.laya) return 'none'
  switch (activeEngineKind) {
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
    default:
      return 'none'
  }
}
