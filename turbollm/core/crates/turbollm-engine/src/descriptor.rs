use std::path::PathBuf;

use crate::ids::{EngineId, EngineKind, ModelFormat};

/// What an engine runs a model on. `Auto` is a request only; a descriptor never lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Backend {
    Auto,
    Cpu,
    Gpu,
}

/// One engine as a client sees it (`TurboLLMTypes.kt:61-71`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDescriptor {
    pub id: EngineId,
    pub name: String,
    pub kind: EngineKind,
    pub formats: Vec<ModelFormat>,
    pub backends: Vec<Backend>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    Available,
    Unavailable { reason: String },
}

/// What a load settled on (`EngineModelInfo.kt`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub context_size: u32,
    pub trained_context: Option<u32>,
    pub backend: Backend,
    pub notes: Vec<String>,
}

/// The resident model, as the snapshot reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedModelInfo {
    pub id: String,
    pub path: PathBuf,
    pub format: ModelFormat,
    pub engine: EngineId,
    pub kind: EngineKind,
    pub info: ModelInfo,
}

/// The HTTP upstream of a supervised engine. Empty until 2b adds the supervised kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpUpstream {}
