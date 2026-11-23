//! llama.cpp as a TurboLLM engine: the session library's C function table, the CPU variant that
//! runs on this device, UTF-8 framing of streamed tokens and the request a reply is prepared from.

pub mod api;
pub mod utf8;
pub mod variant;
pub mod wire;

use turbollm_engine::{EngineError, EngineId, EngineKind};

/// llama.cpp cannot run in this build or on this device, for `reason`.
fn llama_unavailable(reason: impl Into<String>) -> EngineError {
    EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
        kind: EngineKind::LlamaCpp,
        reason: reason.into(),
    }
}
