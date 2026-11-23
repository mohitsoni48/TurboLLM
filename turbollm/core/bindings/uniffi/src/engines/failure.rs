//! One `CoreFailure` per `EngineError` (arch 3.3, 3.6): the code the Kotlin bridge branches on, the text clients
//! read, and the fields some codes carry. Both exceptions hold the record in a field named `failure`, never
//! `message`, which would clash with Kotlin's `Throwable.message` (Phase 1 increments T14).

use turbollm_engine::{EngineError, EngineId, InvalidReason};

use crate::engines::dto::CoreEngineKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreInvalidReason {
    UnknownEngine,
    EngineFormatMismatch,
    InvalidLastMessage,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreFailureCode {
    ModelLoadFailed,
    EngineFailure,
    EngineUnavailable,
    ContextLengthExceeded,
    TemplateUnsupported,
    ModelNotLoaded,
    LoadInProgress,
    ServerBusy,
    InvalidRequest,
    Cancelled,
    Closed,
}

/// `engine_id` and `engine_kind` are set for `EngineUnavailable` only; `param` and `invalid_reason` for
/// `InvalidRequest` only.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreFailure {
    pub code: CoreFailureCode,
    pub detail: String,
    pub engine_id: Option<String>,
    pub engine_kind: Option<CoreEngineKind>,
    pub param: Option<String>,
    pub invalid_reason: Option<CoreInvalidReason>,
}

/// What a core call throws into Kotlin.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum CoreEngineException {
    #[error("{failure:?}")]
    Failed { failure: CoreFailure },
}

/// What a Kotlin-implemented engine throws back into the core.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum CoreForeignException {
    #[error("{failure:?}")]
    Failed { failure: CoreFailure },
}

same_variants!(CoreInvalidReason <=> InvalidReason {
    UnknownEngine,
    EngineFormatMismatch,
    InvalidLastMessage,
    Other,
});

impl From<EngineError> for CoreFailure {
    /// The detail is the error's text, which for the message-less variants is the Kotlin default text.
    fn from(error: EngineError) -> Self {
        let detail = error.to_string();
        match error {
            EngineError::EngineUnavailable { engine, kind, .. } => CoreFailure {
                engine_id: Some(engine.to_string()),
                engine_kind: Some(kind.into()),
                ..CoreFailure::coded(CoreFailureCode::EngineUnavailable, detail)
            },
            EngineError::InvalidRequest { param, reason, .. } => CoreFailure {
                param,
                invalid_reason: Some(reason.into()),
                ..CoreFailure::coded(CoreFailureCode::InvalidRequest, detail)
            },
            other => CoreFailure::coded(code_of(&other), detail),
        }
    }
}

impl CoreFailure {
    fn coded(code: CoreFailureCode, detail: String) -> CoreFailure {
        CoreFailure {
            code,
            detail,
            engine_id: None,
            engine_kind: None,
            param: None,
            invalid_reason: None,
        }
    }
}

/// The code of an error that carries nothing but its text. `EngineError` is non-exhaustive: a variant added
/// later reads as an engine failure until it gets its own code.
fn code_of(error: &EngineError) -> CoreFailureCode {
    match error {
        EngineError::ModelLoadFailed(_) => CoreFailureCode::ModelLoadFailed,
        EngineError::ContextLengthExceeded(_) => CoreFailureCode::ContextLengthExceeded,
        EngineError::TemplateUnsupported(_) => CoreFailureCode::TemplateUnsupported,
        EngineError::ModelNotLoaded(_) => CoreFailureCode::ModelNotLoaded,
        EngineError::LoadInProgress => CoreFailureCode::LoadInProgress,
        EngineError::ServerBusy => CoreFailureCode::ServerBusy,
        EngineError::Cancelled(_) => CoreFailureCode::Cancelled,
        EngineError::Closed => CoreFailureCode::Closed,
        _ => CoreFailureCode::EngineFailure,
    }
}

impl From<CoreFailure> for EngineError {
    fn from(failure: CoreFailure) -> Self {
        let detail = failure.detail;
        match failure.code {
            CoreFailureCode::ModelLoadFailed => EngineError::ModelLoadFailed(detail),
            CoreFailureCode::EngineFailure => EngineError::EngineFailure(detail),
            CoreFailureCode::EngineUnavailable => {
                unavailable(failure.engine_id, failure.engine_kind, detail)
            }
            CoreFailureCode::ContextLengthExceeded => EngineError::ContextLengthExceeded(detail),
            CoreFailureCode::TemplateUnsupported => EngineError::TemplateUnsupported(detail),
            CoreFailureCode::ModelNotLoaded => EngineError::ModelNotLoaded(detail),
            CoreFailureCode::LoadInProgress => EngineError::LoadInProgress,
            CoreFailureCode::ServerBusy => EngineError::ServerBusy,
            CoreFailureCode::InvalidRequest => EngineError::InvalidRequest {
                param: failure.param,
                reason: failure
                    .invalid_reason
                    .map_or(InvalidReason::Other, InvalidReason::from),
                message: detail,
            },
            CoreFailureCode::Cancelled => EngineError::Cancelled(detail),
            CoreFailureCode::Closed => EngineError::Closed,
        }
    }
}

/// An unavailable engine must say which engine it is; a failure that does not cannot be routed around, so it
/// reads as what it is to the caller: the engine failed.
fn unavailable(
    engine_id: Option<String>,
    engine_kind: Option<CoreEngineKind>,
    reason: String,
) -> EngineError {
    match (engine_id, engine_kind) {
        (Some(id), Some(kind)) => EngineError::EngineUnavailable {
            engine: EngineId::new(id),
            kind: kind.into(),
            reason,
        },
        _ => EngineError::EngineFailure(reason),
    }
}

impl From<EngineError> for CoreEngineException {
    fn from(error: EngineError) -> Self {
        CoreEngineException::Failed {
            failure: error.into(),
        }
    }
}

impl From<CoreForeignException> for EngineError {
    fn from(thrown: CoreForeignException) -> Self {
        let CoreForeignException::Failed { failure } = thrown;
        failure.into()
    }
}

#[cfg(test)]
mod tests {
    use turbollm_engine::{EngineKind, MODEL_UNLOADED, REPLY_CANCELLED};

    use super::*;

    fn text(detail: &str) -> String {
        detail.to_owned()
    }

    fn failure(code: CoreFailureCode, detail: &str) -> CoreFailure {
        CoreFailure {
            code,
            detail: text(detail),
            engine_id: None,
            engine_kind: None,
            param: None,
            invalid_reason: None,
        }
    }

    fn assert_maps(error: EngineError, expected: CoreFailure) {
        assert_eq!(CoreFailure::from(error.clone()), expected, "{error:?}");
        assert_eq!(EngineError::from(expected), error);
    }

    #[test]
    fn model_load_failed_carries_its_detail() {
        let detail = "llama.cpp could not load the model: bad magic";
        assert_maps(
            EngineError::ModelLoadFailed(text(detail)),
            failure(CoreFailureCode::ModelLoadFailed, detail),
        );
    }

    #[test]
    fn engine_failure_carries_its_detail() {
        let detail = "llama.cpp failed while generating: decode -1";
        assert_maps(
            EngineError::EngineFailure(text(detail)),
            failure(CoreFailureCode::EngineFailure, detail),
        );
    }

    #[test]
    fn engine_unavailable_names_the_engine_and_its_kind() {
        let detail = "LiteRT-LM cannot run on this device: no GPU";
        let error = EngineError::EngineUnavailable {
            engine: EngineId::new(EngineId::LITERT_LM),
            kind: EngineKind::LitertLm,
            reason: text(detail),
        };
        let expected = CoreFailure {
            engine_id: Some(text("litert-lm")),
            engine_kind: Some(CoreEngineKind::LitertLm),
            ..failure(CoreFailureCode::EngineUnavailable, detail)
        };
        assert_maps(error, expected);
    }

    #[test]
    fn context_length_exceeded_carries_its_detail() {
        let detail = "The prompt is 9000 tokens; the context holds 8192.";
        assert_maps(
            EngineError::ContextLengthExceeded(text(detail)),
            failure(CoreFailureCode::ContextLengthExceeded, detail),
        );
    }

    #[test]
    fn template_unsupported_carries_its_detail_even_when_empty() {
        assert_maps(
            EngineError::TemplateUnsupported(text("")),
            failure(CoreFailureCode::TemplateUnsupported, ""),
        );
    }

    #[test]
    fn model_not_loaded_carries_the_unload_text() {
        assert_maps(
            EngineError::ModelNotLoaded(text(MODEL_UNLOADED)),
            failure(CoreFailureCode::ModelNotLoaded, "The model was unloaded."),
        );
    }

    #[test]
    fn load_in_progress_carries_the_kotlin_default_text() {
        assert_maps(
            EngineError::LoadInProgress,
            failure(
                CoreFailureCode::LoadInProgress,
                "Another model load is in progress.",
            ),
        );
    }

    #[test]
    fn server_busy_carries_the_kotlin_default_text() {
        assert_maps(
            EngineError::ServerBusy,
            failure(
                CoreFailureCode::ServerBusy,
                "Too many requests are queued; retry shortly.",
            ),
        );
    }

    #[test]
    fn invalid_request_names_the_param_and_the_reason() {
        let detail = "This SDK has no engine named vllm.";
        let error = EngineError::InvalidRequest {
            param: Some(text("engine")),
            reason: InvalidReason::UnknownEngine,
            message: text(detail),
        };
        let expected = CoreFailure {
            param: Some(text("engine")),
            invalid_reason: Some(CoreInvalidReason::UnknownEngine),
            ..failure(CoreFailureCode::InvalidRequest, detail)
        };
        assert_maps(error, expected);
    }

    #[test]
    fn cancelled_carries_the_reply_cancelled_text() {
        assert_maps(
            EngineError::Cancelled(text(REPLY_CANCELLED)),
            failure(CoreFailureCode::Cancelled, "The reply was cancelled."),
        );
    }

    #[test]
    fn closed_carries_the_core_closed_text() {
        assert_maps(
            EngineError::Closed,
            failure(CoreFailureCode::Closed, "The TurboLLM core is closed."),
        );
    }

    #[test]
    fn every_invalid_reason_round_trips() {
        let reasons = [
            (
                InvalidReason::UnknownEngine,
                CoreInvalidReason::UnknownEngine,
            ),
            (
                InvalidReason::EngineFormatMismatch,
                CoreInvalidReason::EngineFormatMismatch,
            ),
            (
                InvalidReason::InvalidLastMessage,
                CoreInvalidReason::InvalidLastMessage,
            ),
            (InvalidReason::Other, CoreInvalidReason::Other),
        ];
        for (domain, kotlin) in reasons {
            assert_eq!(CoreInvalidReason::from(domain), kotlin);
            assert_eq!(InvalidReason::from(kotlin), domain);
        }
    }

    #[test]
    fn an_invalid_request_without_a_reason_reads_as_other() {
        let thrown = failure(CoreFailureCode::InvalidRequest, "max_tokens is too large.");
        let expected = EngineError::InvalidRequest {
            param: None,
            reason: InvalidReason::Other,
            message: text("max_tokens is too large."),
        };
        assert_eq!(EngineError::from(thrown), expected);
    }

    #[test]
    fn an_unavailable_failure_that_names_no_engine_reads_as_an_engine_failure() {
        let detail = "the GPU delegate is missing";
        let without_kind = CoreFailure {
            engine_id: Some(text("litert-lm")),
            ..failure(CoreFailureCode::EngineUnavailable, detail)
        };
        let without_id = CoreFailure {
            engine_kind: Some(CoreEngineKind::LitertLm),
            ..failure(CoreFailureCode::EngineUnavailable, detail)
        };
        for thrown in [without_kind, without_id] {
            assert_eq!(
                EngineError::from(thrown),
                EngineError::EngineFailure(text(detail))
            );
        }
    }

    #[test]
    fn a_core_exception_carries_the_failure_of_its_engine_error() {
        let thrown = CoreEngineException::from(EngineError::ServerBusy);
        let expected = CoreEngineException::Failed {
            failure: failure(
                CoreFailureCode::ServerBusy,
                "Too many requests are queued; retry shortly.",
            ),
        };
        assert_eq!(thrown, expected);
    }

    #[test]
    fn a_foreign_exception_becomes_the_engine_error_of_its_failure() {
        let thrown = CoreForeignException::Failed {
            failure: failure(CoreFailureCode::ModelLoadFailed, "no such file"),
        };
        assert_eq!(
            EngineError::from(thrown),
            EngineError::ModelLoadFailed(text("no such file"))
        );
    }
}
