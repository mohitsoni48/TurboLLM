use crate::ids::{EngineId, EngineKind};

/// `EngineHost.kt:165` and `SseWriter.kt:147`: an unload ends running and queued replies with this.
pub const MODEL_UNLOADED: &str = "The model was unloaded.";

/// `LlamaReply.kt:98` and `LiteRtReply.kt:77`: a reply stopped because its caller went away.
pub const REPLY_CANCELLED: &str = "The reply was cancelled.";

/// One variant per `TurboLLMException` the engine layer throws (`api/TurboLLMException.kt:28-83`), so the
/// bridge maps them one to one. The texts are contracts: clients and the daemon read them.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    #[error("{0}")]
    ModelLoadFailed(String),
    #[error("{0}")]
    EngineFailure(String),
    #[error("{reason}")]
    EngineUnavailable {
        engine: EngineId,
        kind: EngineKind,
        reason: String,
    },
    #[error("{0}")]
    ContextLengthExceeded(String),
    #[error("{0}")]
    TemplateUnsupported(String),
    #[error("{0}")]
    ModelNotLoaded(String),
    #[error("Another model load is in progress.")]
    LoadInProgress,
    #[error("Too many requests are queued; retry shortly.")]
    ServerBusy,
    #[error("{message}")]
    InvalidRequest {
        param: Option<String>,
        reason: InvalidReason,
        message: String,
    },
    #[error("{0}")]
    Cancelled(String),
    #[error("The TurboLLM core is closed.")]
    Closed,
}

/// Why a request is invalid, where a client branches on it (ADR-462).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidReason {
    UnknownEngine,
    EngineFormatMismatch,
    InvalidLastMessage,
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_reply_reads_as_the_kotlin_text() {
        let error = EngineError::Cancelled(REPLY_CANCELLED.to_owned());
        assert_eq!(error.to_string(), "The reply was cancelled.");
    }

    #[test]
    fn a_waiter_on_an_unloaded_model_reads_as_the_kotlin_text() {
        let error = EngineError::ModelNotLoaded(MODEL_UNLOADED.to_owned());
        assert_eq!(error.to_string(), "The model was unloaded.");
    }

    #[test]
    fn a_generation_cancelled_by_an_unload_reads_as_the_kotlin_text() {
        let error = EngineError::Cancelled(MODEL_UNLOADED.to_owned());
        assert_eq!(error.to_string(), "The model was unloaded.");
    }

    #[test]
    fn message_carrying_errors_read_as_their_message() {
        let detail = || "what the engine said".to_owned();
        let errors = [
            EngineError::ModelLoadFailed(detail()),
            EngineError::EngineFailure(detail()),
            EngineError::ContextLengthExceeded(detail()),
            EngineError::TemplateUnsupported(detail()),
        ];
        for error in errors {
            assert_eq!(error.to_string(), detail(), "{error:?}");
        }
    }

    #[test]
    fn an_unavailable_engine_reads_as_its_reason() {
        let error = EngineError::EngineUnavailable {
            engine: EngineId::new(EngineId::LITERT_LM),
            kind: EngineKind::LitertLm,
            reason: "LiteRT-LM cannot run on this device: no GPU".to_owned(),
        };
        assert_eq!(
            error.to_string(),
            "LiteRT-LM cannot run on this device: no GPU"
        );
    }

    #[test]
    fn an_invalid_request_reads_as_its_message() {
        let error = EngineError::InvalidRequest {
            param: Some("engine".to_owned()),
            reason: InvalidReason::UnknownEngine,
            message: "This SDK has no engine named vllm.".to_owned(),
        };
        assert_eq!(error.to_string(), "This SDK has no engine named vllm.");
    }

    #[test]
    fn errors_without_a_message_read_as_the_kotlin_default_texts() {
        assert_eq!(
            EngineError::LoadInProgress.to_string(),
            "Another model load is in progress."
        );
        assert_eq!(
            EngineError::ServerBusy.to_string(),
            "Too many requests are queued; retry shortly."
        );
        assert_eq!(
            EngineError::Closed.to_string(),
            "The TurboLLM core is closed."
        );
    }
}
