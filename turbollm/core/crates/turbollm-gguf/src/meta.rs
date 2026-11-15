//! What the header parser reports about a GGUF, in the field order of the TypeScript `GgufMeta` literal
//! (`gguf.ts:485-508`), so every serialisation lists the fields as the TypeScript engine did.

/// The model facts read from a GGUF header. Integer fields hold the TypeScript number truncated and saturated
/// into their type (declared divergence D-1); `data_end` is exact (D-2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GgufMeta {
    pub arch: String,
    pub name: String,
    pub quant: String,
    pub size_label: String,
    pub native_ctx: u32,
    pub block_count: u32,
    pub embed_len: u32,
    /// The largest KV-head count over the layers.
    pub head_count_kv: u32,
    pub head_dim: u32,
    pub expert_count: u32,
    pub nextn_layers: u32,
    pub has_chat_template: bool,
    pub reasoning_effort: bool,
    pub sliding_window: u32,
    pub sliding_window_pattern: Vec<bool>,
    pub head_dim_swa: u32,
    /// The per-layer KV-head counts, only when the file declares them as an array.
    pub head_count_kv_per_layer: Vec<u32>,
    pub full_attention_interval: u32,
    pub ssm_inner_size: u32,
    pub ssm_state_size: u32,
    pub ssm_conv_kernel: u32,
    /// The length the file needs to hold every tensor's data; 0 when it cannot be worked out.
    pub data_end: u64,
}
