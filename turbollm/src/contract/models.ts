import type { JevLabel } from './status'

/** Present only for a Laya model; `checkpoints` names the folders it ships (english, multilingual, typed-decisions). */
export type LayaInfo = {
  checkpoints: string[]
}

/** A LiteRT-LM bundle's own sampler (LlmMetadata.sampler_params); a field the bundle leaves 0 is absent. */
export type LitertlmSampler = {
  topK?: number
  topP?: number
  temp?: number
}

/** What makes a scanned model a Jev model (ADR-434 (g)). */
export type JevInfo = {
  /** Canonical label per class id, in `id2label` index order. */
  labels: JevLabel[]
  /** The model's own premise/hypothesis template, or null when it has none usable. */
  nliTemplate: string | null
  /** `architectures[0]` as declared, e.g. 'Qwen3_5ForSequenceClassification'. */
  architecture: string
  /** True when the architecture has a verified launch row; false → "Not verified". */
  verified: boolean
}

// ── Models (discovery, spec 04) ──────────────────────────────────────────────
export type ModelEntry = {
  key: string
  name: string
  path: string
  dir: string
  format: 'gguf' | 'mlx' | 'litertlm'
  sizeBytes: number
  sizeLabel: string
  arch: string
  quant: string
  nativeCtx: number
  /** LiteRT-LM only: nativeCtx is a dynamic export's maximum, not a size its caches hold (daemon models/litertlm.ts). */
  ctxDynamic?: boolean
  /** LiteRT-LM only: the bundle's own default context (LlmMetadata.max_num_tokens); absent when it declares none. */
  defaultCtx?: number
  blockCount: number
  headCountKv: number
  /** Attention/KV layout the daemon's scanner reads from the GGUF (twins of src/models/scanner.ts's
   *  ModelEntry fields — see there for each one). The daemon always sends `headDim`; the rest only
   *  when the GGUF declares them. Used only by vram.ts's live estimate, which mirrors the daemon's. */
  headDim?: number
  slidingWindow?: number
  slidingWindowPattern?: boolean[]
  headDimSwa?: number
  headCountKvPerLayer?: number[]
  fullAttentionInterval?: number
  ssmInnerSize?: number
  ssmStateSize?: number
  ssmConvKernel?: number
  moe: boolean
  expertCount: number
  /** >0 when the GGUF carries a built-in NextN multi-token-prediction head. */
  nextnLayers: number
  vision: boolean
  /** True for MLX-format models whose config.json declares an audio_config (an audio
   *  tower/encoder, e.g. gemma4's Conformer audio module). Always false for GGUF. */
  audio: boolean
  mmprojPath: string | null
  /** On-disk size of the mmproj file, bytes (0 when `mmprojPath` is null) — sizes the projector's VRAM. */
  mmprojSizeBytes?: number
  hasChatTemplate: boolean
  /** True when the model's chat template supports a `reasoning_effort` control
   *  (low/medium/xhigh) — Qwen3.8's reasoning-depth control. Composers gate the
   *  ReasoningEffortSelect vs ThinkingBudgetSlider choice on this flag. */
  reasoningEffort: boolean
  /** LiteRT-LM only: whether the bundle's chat template reads the model's past reasoning. false: the model sees none of
   *  it, so a thread's "Preserve thinking" cannot apply (the thread settings say so). Absent when the bundle does not
   *  say. */
  reasoningHistory?: boolean
  /** True when the model is an embedding model (BERT-family or embed filename pattern).
   *  Activates --embeddings at startup so /v1/embeddings is available. */
  embedding: boolean
  incomplete: boolean
  parseError: string | null
  loaded: boolean
  hasProfile: boolean
  benchTps: number | null
  /** Most-recent gen t/s recorded for this model in chat (spec 04 §5); null if
   *  never chatted with. */
  lastTps: number | null
  /** Live gen t/s for the currently-loaded model; null unless this model is loaded
   *  and a recent figure exists (best-effort until a full session accumulator lands). */
  liveTps: number | null
  /** Whether the currently-active engine can load this model's format (ADR-044).
   *  Drives the model-list filter (GGUF under llama.cpp; safetensors under MLX/vLLM).
   *  True when no engine is active. */
  compatibleWithActiveEngine: boolean
  /** Source HF repo — confirmed from download provenance, or inferred from the
   *  on-disk layout (<root>/<owner>/<repo>/<file>) for imported files. Null when it
   *  can't be determined. Lets the library open the model's HF page (card + quants). */
  sourceRepo?: string | null
  /** Set only for a Jev model — an NLI cross-encoder served through vLLM (ADR-434 (g)).
   *  Absent means "not a Jev model"; the twin is `JevInfo` in src/models/jev.ts. */
  jev?: JevInfo
  /** Set only for a Laya model — a System One decision model served by its own 'laya' engine
   *  (huggingface.co/convaiinnovations/laya). `checkpoints` names the folders it ships,
   *  e.g. `['english', 'multilingual']`. Absent means "not a Laya model". */
  laya?: LayaInfo
  /** Why the active engine cannot load this model, in the user's words ('Needs vLLM
   *  (Linux or WSL2)'), or null when it can. The daemon owns the wording so every
   *  surface says the same thing. */
  incompatibleReason?: string | null
  /** Hidden by the user (Models → Library, the model's "Hide"; the daemon keeps it per model key). The web UI leaves
   *  it out of the Library list until "Show hidden models" is on, and out of every model picker but the draft-model
   *  select in Load settings (a small draft is what one hides from the chat pickers), unless it is loaded
   *  (lib/model-kind.ts hiddenByUser). Absent from an older daemon (read as shown). */
  hidden?: boolean
  /** The context window this model loads with from its saved profile for the active engine; absent when it has none
   *  (the caller then falls back to `nativeCtx`). Exposed for the config-file coding harnesses. */
  configuredCtx?: number
  /** LiteRT-LM only: whether the bundle's model calls tools; false means TurboLLM sends it none. Absent elsewhere. */
  toolCalls?: boolean
  /** LiteRT-LM only: the bundle's own sampler, what its runtime samples with while a request sets none. */
  sampler?: LitertlmSampler
  mtime: string
}

export type ModelsList = {
  models: ModelEntry[]
  scanning: boolean
  lastScanAt: string
}
