//! Shared by the integration tests: fixture paths, generated fixtures and the TypeScript-shaped JSON text.

#![allow(
    dead_code,
    reason = "each test binary uses a different part of the support module"
)]

pub mod builders;

use std::path::PathBuf;

use serde_json::{Map, Value, json};
use turbollm_gguf::{GgufError, GgufMeta};

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("fixtures")
        .join("gguf")
}

pub fn crafted_path(id: &str) -> PathBuf {
    fixtures_dir().join("crafted").join(format!("{id}.gguf"))
}

/// The golden `parse` text: `JSON.stringify(result)`, or `JSON.stringify({ error: { code, message } })`.
pub fn parse_text(outcome: &Result<GgufMeta, GgufError>) -> String {
    let value = match outcome {
        Ok(meta) => Value::Object(meta_fields(meta)),
        Err(error) => json!({ "error": { "code": error.code(), "message": error.to_string() } }),
    };
    value.to_string()
}

fn meta_fields(meta: &GgufMeta) -> Map<String, Value> {
    let fields = [
        ("arch", json!(meta.arch)),
        ("name", json!(meta.name)),
        ("quant", json!(meta.quant)),
        ("sizeLabel", json!(meta.size_label)),
        ("nativeCtx", json!(meta.native_ctx)),
        ("blockCount", json!(meta.block_count)),
        ("embedLen", json!(meta.embed_len)),
        ("headCountKv", json!(meta.head_count_kv)),
        ("headDim", json!(meta.head_dim)),
        ("expertCount", json!(meta.expert_count)),
        ("nextnLayers", json!(meta.nextn_layers)),
        ("hasChatTemplate", json!(meta.has_chat_template)),
        ("reasoningEffort", json!(meta.reasoning_effort)),
        ("slidingWindow", json!(meta.sliding_window)),
        ("slidingWindowPattern", json!(meta.sliding_window_pattern)),
        ("headDimSwa", json!(meta.head_dim_swa)),
        ("headCountKvPerLayer", json!(meta.head_count_kv_per_layer)),
        ("fullAttentionInterval", json!(meta.full_attention_interval)),
        ("ssmInnerSize", json!(meta.ssm_inner_size)),
        ("ssmStateSize", json!(meta.ssm_state_size)),
        ("ssmConvKernel", json!(meta.ssm_conv_kernel)),
        ("dataEnd", json!(meta.data_end)),
    ];
    fields
        .into_iter()
        .map(|(name, value)| (name.to_string(), value))
        .collect()
}
