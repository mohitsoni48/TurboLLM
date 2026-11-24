use std::fmt;

use serde::{Deserialize, Serialize};

/// A stable id for one engine a build hosts (ADR-462). Open: a new engine is one more value.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EngineId(String);

impl EngineId {
    pub const LLAMA_CPP_CPU: &str = "llama.cpp-cpu";
    pub const LITERT_LM: &str = "litert-lm";

    pub fn new(id: impl Into<String>) -> EngineId {
        EngineId(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for EngineId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The runtime family. Two engine ids can share a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EngineKind {
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    #[serde(rename = "litert-lm")]
    LitertLm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFormat {
    Gguf,
    Litertlm,
}

/// How the caller named the model, echoed back while it loads or after it failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelRef {
    Installed(String),
    File(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    fn from_wire<T: for<'de> Deserialize<'de>>(json: &str) -> T {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn engine_kinds_use_the_daemon_wire_names() {
        assert_eq!(wire(&EngineKind::LlamaCpp), r#""llama.cpp""#);
        assert_eq!(wire(&EngineKind::LitertLm), r#""litert-lm""#);
    }

    #[test]
    fn engine_kinds_are_read_back_from_their_wire_names() {
        assert_eq!(
            from_wire::<EngineKind>(r#""llama.cpp""#),
            EngineKind::LlamaCpp
        );
        assert_eq!(
            from_wire::<EngineKind>(r#""litert-lm""#),
            EngineKind::LitertLm
        );
    }

    #[test]
    fn model_formats_use_the_daemon_wire_names() {
        assert_eq!(wire(&ModelFormat::Gguf), r#""gguf""#);
        assert_eq!(wire(&ModelFormat::Litertlm), r#""litertlm""#);
    }

    #[test]
    fn model_formats_are_read_back_from_their_wire_names() {
        assert_eq!(from_wire::<ModelFormat>(r#""gguf""#), ModelFormat::Gguf);
        assert_eq!(
            from_wire::<ModelFormat>(r#""litertlm""#),
            ModelFormat::Litertlm
        );
    }

    #[test]
    fn the_sdk_engine_ids_are_pinned() {
        assert_eq!(EngineId::LLAMA_CPP_CPU, "llama.cpp-cpu");
        assert_eq!(EngineId::LITERT_LM, "litert-lm");
    }

    #[test]
    fn an_engine_id_travels_as_its_plain_string() {
        let id = EngineId::new(EngineId::LLAMA_CPP_CPU);
        assert_eq!(wire(&id), r#""llama.cpp-cpu""#);
        assert_eq!(
            from_wire::<EngineId>(r#""litert-lm""#),
            EngineId::new("litert-lm")
        );
        assert_eq!(id.to_string(), "llama.cpp-cpu");
        assert_eq!(id.as_str(), "llama.cpp-cpu");
    }
}
