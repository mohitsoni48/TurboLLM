use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::descriptor::Backend;
use crate::ids::{EngineId, ModelFormat, ModelRef};

/// What an engine needs to open one model file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadSpec {
    pub path: PathBuf,
    pub context_size: Option<u32>,
    pub threads: u32,
    pub backend: Backend,
    pub cache_dir: PathBuf,
}

/// A resolved load request: which model, from which file, on which engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadTarget {
    pub model_ref: ModelRef,
    pub id: String,
    pub format: ModelFormat,
    pub engine: EngineId,
    pub path: PathBuf,
    pub context_size: Option<u32>,
    pub threads: Option<u32>,
    pub backend: Backend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

/// Text parts only: the chat layer refuses every other part before a request reaches an engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: MessageContent,
}

/// Sampling and template settings of one generation (`GenerationParams.kt:8-16`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GenerationParams {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<i32>,
    pub seed: Option<i64>,
    pub enable_thinking: bool,
    pub template_kwargs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenerateRequest {
    pub messages: Vec<ChatMessage>,
    pub params: GenerationParams,
}
