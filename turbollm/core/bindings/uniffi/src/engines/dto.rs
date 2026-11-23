//! The engine records and enums Kotlin sees (arch 3.3), and their conversions to and from the domain types
//! (B-4: the domain crates carry no UniFFI dependency). Kotlin's `Int` and `Long` are signed: counts the domain
//! keeps unsigned saturate on the way out, and a negative count on the way in is an invalid request naming its
//! field. Paths travel as strings.

use std::collections::HashMap;
use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::time::Duration;

use turbollm_core::engines::EnginesConfig;
use turbollm_engine::{
    Availability, Backend, ChatMessage, EngineDescriptor, EngineError, EngineEvent, EngineId,
    EngineKind, EngineState, FinishReason, GenerateRequest, GenerationParams, InvalidReason,
    LoadSpec, LoadTarget, LoadedModelInfo, MessageContent, ModelFormat, ModelInfo, ModelRef, Role,
    Snapshot,
};

use crate::engines::failure::CoreFailure;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreModelFormat {
    Gguf,
    Litertlm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreEngineKind {
    LlamaCpp,
    LitertLm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreBackend {
    Auto,
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreFinishReason {
    Stop,
    Length,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreModelRefKind {
    Installed,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreChatRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum CoreMessageContent {
    Text { text: String },
    Parts { texts: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum CoreEngineEvent {
    Prefilled {
        prompt_tokens: i32,
        prompt_ms: f64,
    },
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Done {
        reason: CoreFinishReason,
        prompt_tokens: i32,
        completion_tokens: i32,
        prompt_ms: f64,
        gen_ms: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum CoreEngineState {
    Idle,
    Loading {
        ref_kind: CoreModelRefKind,
        ref_value: String,
    },
    Ready {
        model: CoreLoadedModel,
        busy: bool,
        queued: i32,
    },
    Failed {
        ref_kind: CoreModelRefKind,
        ref_value: String,
        failure: CoreFailure,
    },
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreEngineDescriptor {
    pub id: String,
    pub name: String,
    pub kind: CoreEngineKind,
    pub formats: Vec<CoreModelFormat>,
    pub backends: Vec<CoreBackend>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreEngineInfo {
    pub descriptor: CoreEngineDescriptor,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreEngineConfig {
    pub cache_dir: String,
    pub native_library_dir: Option<String>,
    pub load_journal_path: Option<String>,
    pub max_queued_requests: i32,
    pub load_stall_seconds: i32,
    pub forced_unavailable: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreLoadTarget {
    pub ref_kind: CoreModelRefKind,
    pub ref_value: String,
    pub id: String,
    pub path: String,
    pub format: CoreModelFormat,
    pub engine_id: String,
    pub context_size: Option<i32>,
    pub threads: Option<i32>,
    pub backend: CoreBackend,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreLoadedModel {
    pub id: String,
    pub path: String,
    pub format: CoreModelFormat,
    pub engine_kind: CoreEngineKind,
    pub engine_id: String,
    pub context_size: i32,
    pub trained_context: Option<i32>,
    pub backend: CoreBackend,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreEngineSnapshot {
    pub revision: i64,
    pub state: CoreEngineState,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreChatMessage {
    pub role: CoreChatRole,
    pub content: CoreMessageContent,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CoreGenerationParams {
    pub max_tokens: Option<i32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<i32>,
    pub seed: Option<i64>,
    pub enable_thinking: bool,
    pub template_kwargs: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CoreGenerateRequest {
    pub messages: Vec<CoreChatMessage>,
    pub params: CoreGenerationParams,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreLoadSpec {
    pub path: String,
    pub context_size: Option<i32>,
    pub threads: i32,
    pub backend: CoreBackend,
    pub cache_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CoreModelInfo {
    pub context_size: i32,
    pub trained_context: Option<i32>,
    pub backend: CoreBackend,
    pub notes: Vec<String>,
}

same_variants!(CoreModelFormat <=> ModelFormat { Gguf, Litertlm });
same_variants!(CoreEngineKind <=> EngineKind { LlamaCpp, LitertLm });
same_variants!(CoreBackend <=> Backend { Auto, Cpu, Gpu });
same_variants!(CoreFinishReason <=> FinishReason { Stop, Length });
same_variants!(CoreChatRole <=> Role {
    System,
    User,
    Assistant
});

impl From<MessageContent> for CoreMessageContent {
    fn from(content: MessageContent) -> Self {
        match content {
            MessageContent::Text(text) => CoreMessageContent::Text { text },
            MessageContent::Parts(texts) => CoreMessageContent::Parts { texts },
        }
    }
}

impl From<CoreMessageContent> for MessageContent {
    fn from(content: CoreMessageContent) -> Self {
        match content {
            CoreMessageContent::Text { text } => MessageContent::Text(text),
            CoreMessageContent::Parts { texts } => MessageContent::Parts(texts),
        }
    }
}

impl From<ChatMessage> for CoreChatMessage {
    fn from(message: ChatMessage) -> Self {
        CoreChatMessage {
            role: message.role.into(),
            content: message.content.into(),
        }
    }
}

impl From<CoreChatMessage> for ChatMessage {
    fn from(message: CoreChatMessage) -> Self {
        ChatMessage {
            role: message.role.into(),
            content: message.content.into(),
        }
    }
}

impl From<GenerationParams> for CoreGenerationParams {
    fn from(params: GenerationParams) -> Self {
        CoreGenerationParams {
            max_tokens: params.max_tokens.map(saturated),
            temperature: params.temperature,
            top_p: params.top_p,
            top_k: params.top_k,
            seed: params.seed,
            enable_thinking: params.enable_thinking,
            template_kwargs: params.template_kwargs.into_iter().collect(),
        }
    }
}

impl TryFrom<CoreGenerationParams> for GenerationParams {
    type Error = EngineError;

    fn try_from(params: CoreGenerationParams) -> Result<Self, EngineError> {
        Ok(GenerationParams {
            max_tokens: optional_count(params.max_tokens, "max_tokens")?,
            temperature: params.temperature,
            top_p: params.top_p,
            top_k: params.top_k,
            seed: params.seed,
            enable_thinking: params.enable_thinking,
            template_kwargs: params.template_kwargs.into_iter().collect(),
        })
    }
}

impl From<GenerateRequest> for CoreGenerateRequest {
    fn from(request: GenerateRequest) -> Self {
        CoreGenerateRequest {
            messages: request.messages.into_iter().map(Into::into).collect(),
            params: request.params.into(),
        }
    }
}

impl TryFrom<CoreGenerateRequest> for GenerateRequest {
    type Error = EngineError;

    fn try_from(request: CoreGenerateRequest) -> Result<Self, EngineError> {
        Ok(GenerateRequest {
            messages: request.messages.into_iter().map(Into::into).collect(),
            params: request.params.try_into()?,
        })
    }
}

impl From<EngineEvent> for CoreEngineEvent {
    fn from(event: EngineEvent) -> Self {
        match event {
            EngineEvent::Prefilled {
                prompt_tokens,
                prompt_ms,
            } => CoreEngineEvent::Prefilled {
                prompt_tokens: saturated(prompt_tokens),
                prompt_ms,
            },
            EngineEvent::Text(text) => CoreEngineEvent::Text { text },
            EngineEvent::Reasoning(text) => CoreEngineEvent::Reasoning { text },
            EngineEvent::Done {
                reason,
                prompt_tokens,
                completion_tokens,
                prompt_ms,
                gen_ms,
            } => CoreEngineEvent::Done {
                reason: reason.into(),
                prompt_tokens: saturated(prompt_tokens),
                completion_tokens: saturated(completion_tokens),
                prompt_ms,
                gen_ms,
            },
        }
    }
}

impl TryFrom<CoreEngineEvent> for EngineEvent {
    type Error = EngineError;

    fn try_from(event: CoreEngineEvent) -> Result<Self, EngineError> {
        Ok(match event {
            CoreEngineEvent::Prefilled {
                prompt_tokens,
                prompt_ms,
            } => EngineEvent::Prefilled {
                prompt_tokens: count(prompt_tokens, "prompt_tokens")?,
                prompt_ms,
            },
            CoreEngineEvent::Text { text } => EngineEvent::Text(text),
            CoreEngineEvent::Reasoning { text } => EngineEvent::Reasoning(text),
            CoreEngineEvent::Done {
                reason,
                prompt_tokens,
                completion_tokens,
                prompt_ms,
                gen_ms,
            } => EngineEvent::Done {
                reason: reason.into(),
                prompt_tokens: count(prompt_tokens, "prompt_tokens")?,
                completion_tokens: count(completion_tokens, "completion_tokens")?,
                prompt_ms,
                gen_ms,
            },
        })
    }
}

impl From<EngineDescriptor> for CoreEngineDescriptor {
    fn from(descriptor: EngineDescriptor) -> Self {
        CoreEngineDescriptor {
            id: descriptor.id.to_string(),
            name: descriptor.name,
            kind: descriptor.kind.into(),
            formats: descriptor.formats.into_iter().map(Into::into).collect(),
            backends: descriptor.backends.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<CoreEngineDescriptor> for EngineDescriptor {
    fn from(descriptor: CoreEngineDescriptor) -> Self {
        EngineDescriptor {
            id: EngineId::new(descriptor.id),
            name: descriptor.name,
            kind: descriptor.kind.into(),
            formats: descriptor.formats.into_iter().map(Into::into).collect(),
            backends: descriptor.backends.into_iter().map(Into::into).collect(),
        }
    }
}

/// One row of the catalogue's listing; Kotlin never sends a listing back.
impl From<(EngineDescriptor, Availability)> for CoreEngineInfo {
    fn from((descriptor, availability): (EngineDescriptor, Availability)) -> Self {
        let unavailable_reason = match availability {
            Availability::Available => None,
            Availability::Unavailable { reason } => Some(reason),
        };
        CoreEngineInfo {
            descriptor: descriptor.into(),
            unavailable_reason,
        }
    }
}

/// Kotlin configures a core; it never reads a configuration back.
impl TryFrom<CoreEngineConfig> for EnginesConfig {
    type Error = EngineError;

    fn try_from(config: CoreEngineConfig) -> Result<Self, EngineError> {
        let stall_seconds = count(config.load_stall_seconds, "load_stall_seconds")?;
        Ok(EnginesConfig {
            cache_dir: PathBuf::from(config.cache_dir),
            library_dir: config.native_library_dir.map(PathBuf::from),
            journal_path: config.load_journal_path.map(PathBuf::from),
            max_queued: count(config.max_queued_requests, "max_queued_requests")?,
            stall: Duration::from_secs(stall_seconds),
            forced_unavailable: config
                .forced_unavailable
                .into_iter()
                .map(|(id, reason)| (EngineId::new(id), reason))
                .collect(),
        })
    }
}

impl From<LoadTarget> for CoreLoadTarget {
    fn from(target: LoadTarget) -> Self {
        let (ref_kind, ref_value) = ref_parts(target.model_ref);
        CoreLoadTarget {
            ref_kind,
            ref_value,
            id: target.id,
            path: path_text(&target.path),
            format: target.format.into(),
            engine_id: target.engine.to_string(),
            context_size: target.context_size.map(saturated),
            threads: target.threads.map(saturated),
            backend: target.backend.into(),
        }
    }
}

impl TryFrom<CoreLoadTarget> for LoadTarget {
    type Error = EngineError;

    fn try_from(target: CoreLoadTarget) -> Result<Self, EngineError> {
        Ok(LoadTarget {
            model_ref: model_ref(target.ref_kind, target.ref_value),
            id: target.id,
            format: target.format.into(),
            engine: EngineId::new(target.engine_id),
            path: PathBuf::from(target.path),
            context_size: optional_count(target.context_size, "context_size")?,
            threads: optional_count(target.threads, "threads")?,
            backend: target.backend.into(),
        })
    }
}

impl From<LoadSpec> for CoreLoadSpec {
    fn from(spec: LoadSpec) -> Self {
        CoreLoadSpec {
            path: path_text(&spec.path),
            context_size: spec.context_size.map(saturated),
            threads: saturated(spec.threads),
            backend: spec.backend.into(),
            cache_dir: path_text(&spec.cache_dir),
        }
    }
}

impl TryFrom<CoreLoadSpec> for LoadSpec {
    type Error = EngineError;

    fn try_from(spec: CoreLoadSpec) -> Result<Self, EngineError> {
        Ok(LoadSpec {
            path: PathBuf::from(spec.path),
            context_size: optional_count(spec.context_size, "context_size")?,
            threads: count(spec.threads, "threads")?,
            backend: spec.backend.into(),
            cache_dir: PathBuf::from(spec.cache_dir),
        })
    }
}

impl From<ModelInfo> for CoreModelInfo {
    fn from(info: ModelInfo) -> Self {
        CoreModelInfo {
            context_size: saturated(info.context_size),
            trained_context: info.trained_context.map(saturated),
            backend: info.backend.into(),
            notes: info.notes,
        }
    }
}

impl TryFrom<CoreModelInfo> for ModelInfo {
    type Error = EngineError;

    fn try_from(info: CoreModelInfo) -> Result<Self, EngineError> {
        Ok(ModelInfo {
            context_size: count(info.context_size, "context_size")?,
            trained_context: optional_count(info.trained_context, "trained_context")?,
            backend: info.backend.into(),
            notes: info.notes,
        })
    }
}

impl From<LoadedModelInfo> for CoreLoadedModel {
    fn from(model: LoadedModelInfo) -> Self {
        let info = CoreModelInfo::from(model.info);
        CoreLoadedModel {
            id: model.id,
            path: path_text(&model.path),
            format: model.format.into(),
            engine_kind: model.kind.into(),
            engine_id: model.engine.to_string(),
            context_size: info.context_size,
            trained_context: info.trained_context,
            backend: info.backend,
            notes: info.notes,
        }
    }
}

impl TryFrom<CoreLoadedModel> for LoadedModelInfo {
    type Error = EngineError;

    fn try_from(model: CoreLoadedModel) -> Result<Self, EngineError> {
        let info = CoreModelInfo {
            context_size: model.context_size,
            trained_context: model.trained_context,
            backend: model.backend,
            notes: model.notes,
        };
        Ok(LoadedModelInfo {
            id: model.id,
            path: PathBuf::from(model.path),
            format: model.format.into(),
            engine: EngineId::new(model.engine_id),
            kind: model.engine_kind.into(),
            info: info.try_into()?,
        })
    }
}

impl From<EngineState> for CoreEngineState {
    fn from(state: EngineState) -> Self {
        match state {
            EngineState::Idle => CoreEngineState::Idle,
            EngineState::Loading(model_ref) => {
                let (ref_kind, ref_value) = ref_parts(model_ref);
                CoreEngineState::Loading {
                    ref_kind,
                    ref_value,
                }
            }
            EngineState::Ready {
                model,
                busy,
                queued,
            } => CoreEngineState::Ready {
                model: model.into(),
                busy,
                queued: saturated(queued),
            },
            EngineState::Failed(model_ref, error) => {
                let (ref_kind, ref_value) = ref_parts(model_ref);
                CoreEngineState::Failed {
                    ref_kind,
                    ref_value,
                    failure: error.into(),
                }
            }
            EngineState::Closed => CoreEngineState::Closed,
        }
    }
}

impl TryFrom<CoreEngineState> for EngineState {
    type Error = EngineError;

    fn try_from(state: CoreEngineState) -> Result<Self, EngineError> {
        Ok(match state {
            CoreEngineState::Idle => EngineState::Idle,
            CoreEngineState::Loading {
                ref_kind,
                ref_value,
            } => EngineState::Loading(model_ref(ref_kind, ref_value)),
            CoreEngineState::Ready {
                model,
                busy,
                queued,
            } => EngineState::Ready {
                model: model.try_into()?,
                busy,
                queued: count(queued, "queued")?,
            },
            CoreEngineState::Failed {
                ref_kind,
                ref_value,
                failure,
            } => EngineState::Failed(model_ref(ref_kind, ref_value), failure.into()),
            CoreEngineState::Closed => EngineState::Closed,
        })
    }
}

impl From<Snapshot> for CoreEngineSnapshot {
    fn from(snapshot: Snapshot) -> Self {
        CoreEngineSnapshot {
            revision: saturated(snapshot.revision),
            state: snapshot.state.into(),
        }
    }
}

impl TryFrom<CoreEngineSnapshot> for Snapshot {
    type Error = EngineError;

    fn try_from(snapshot: CoreEngineSnapshot) -> Result<Self, EngineError> {
        Ok(Snapshot {
            revision: count(snapshot.revision, "revision")?,
            state: snapshot.state.try_into()?,
        })
    }
}

fn model_ref(kind: CoreModelRefKind, value: String) -> ModelRef {
    match kind {
        CoreModelRefKind::Installed => ModelRef::Installed(value),
        CoreModelRefKind::File => ModelRef::File(value),
    }
}

fn ref_parts(model_ref: ModelRef) -> (CoreModelRefKind, String) {
    match model_ref {
        ModelRef::Installed(id) => (CoreModelRefKind::Installed, id),
        ModelRef::File(path) => (CoreModelRefKind::File, path),
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// An unsigned domain count as Kotlin's signed `Int`/`Long`, capped at its largest value.
fn saturated<Unsigned, Signed>(value: Unsigned) -> Signed
where
    Signed: TryFrom<Unsigned> + Bounded,
{
    Signed::try_from(value).unwrap_or(Signed::LARGEST)
}

/// A signed Kotlin count as the domain's unsigned one; a negative value is the caller's mistake.
fn count<Signed, Unsigned>(value: Signed, field: &str) -> Result<Unsigned, EngineError>
where
    Signed: Copy + Display,
    Unsigned: TryFrom<Signed>,
{
    Unsigned::try_from(value).map_err(|_| negative_count(field, value))
}

fn optional_count<Unsigned>(
    value: Option<i32>,
    field: &str,
) -> Result<Option<Unsigned>, EngineError>
where
    Unsigned: TryFrom<i32>,
{
    value.map(|present| count(present, field)).transpose()
}

fn negative_count(field: &str, value: impl Display) -> EngineError {
    EngineError::InvalidRequest {
        param: Some(field.to_owned()),
        reason: InvalidReason::Other,
        message: format!("{field} must not be negative, but was {value}."),
    }
}

/// The largest value of a Kotlin integer type, where a saturated count stops.
trait Bounded {
    const LARGEST: Self;
}

impl Bounded for i32 {
    const LARGEST: i32 = i32::MAX;
}

impl Bounded for i64 {
    const LARGEST: i64 = i64::MAX;
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fmt::Debug;

    use crate::engines::failure::CoreFailureCode;

    use super::*;

    fn text(value: &str) -> String {
        value.to_owned()
    }

    /// Both directions at once: the domain value becomes exactly `kotlin`, and `kotlin` becomes the domain value.
    fn assert_mirrors<D, K>(domain: D, kotlin: K)
    where
        D: Clone + PartialEq + Debug + TryFrom<K>,
        K: Clone + PartialEq + Debug + From<D>,
        <D as TryFrom<K>>::Error: Debug,
    {
        assert_eq!(K::from(domain.clone()), kotlin);
        assert_eq!(D::try_from(kotlin).unwrap(), domain);
    }

    fn refused_field<D, K>(kotlin: K) -> Option<String>
    where
        D: TryFrom<K, Error = EngineError>,
    {
        match D::try_from(kotlin) {
            Err(EngineError::InvalidRequest { param, reason, .. }) => {
                assert_eq!(reason, InvalidReason::Other);
                param
            }
            Err(other) => panic!("expected an invalid request, got {other:?}"),
            Ok(_) => panic!("expected a refusal, the value was accepted"),
        }
    }

    fn model_info() -> ModelInfo {
        ModelInfo {
            context_size: 8192,
            trained_context: Some(40_960),
            backend: Backend::Cpu,
            notes: vec![text("GPU is not available for llama.cpp in M1; ran on CPU")],
        }
    }

    fn core_model_info() -> CoreModelInfo {
        CoreModelInfo {
            context_size: 8192,
            trained_context: Some(40_960),
            backend: CoreBackend::Cpu,
            notes: vec![text("GPU is not available for llama.cpp in M1; ran on CPU")],
        }
    }

    fn loaded_model() -> LoadedModelInfo {
        LoadedModelInfo {
            id: text("qwen3-0.6b"),
            path: PathBuf::from("/models/qwen3.gguf"),
            format: ModelFormat::Gguf,
            engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
            kind: EngineKind::LlamaCpp,
            info: model_info(),
        }
    }

    fn core_loaded_model() -> CoreLoadedModel {
        CoreLoadedModel {
            id: text("qwen3-0.6b"),
            path: text("/models/qwen3.gguf"),
            format: CoreModelFormat::Gguf,
            engine_kind: CoreEngineKind::LlamaCpp,
            engine_id: text("llama.cpp-cpu"),
            context_size: 8192,
            trained_context: Some(40_960),
            backend: CoreBackend::Cpu,
            notes: vec![text("GPU is not available for llama.cpp in M1; ran on CPU")],
        }
    }

    fn descriptor() -> EngineDescriptor {
        EngineDescriptor {
            id: EngineId::new(EngineId::LITERT_LM),
            name: text("LiteRT-LM"),
            kind: EngineKind::LitertLm,
            formats: vec![ModelFormat::Litertlm],
            backends: vec![Backend::Cpu, Backend::Gpu],
        }
    }

    fn core_descriptor() -> CoreEngineDescriptor {
        CoreEngineDescriptor {
            id: text("litert-lm"),
            name: text("LiteRT-LM"),
            kind: CoreEngineKind::LitertLm,
            formats: vec![CoreModelFormat::Litertlm],
            backends: vec![CoreBackend::Cpu, CoreBackend::Gpu],
        }
    }

    fn core_params() -> CoreGenerationParams {
        CoreGenerationParams {
            max_tokens: Some(48),
            temperature: Some(0.5),
            top_p: Some(0.75),
            top_k: Some(40),
            seed: Some(-7),
            enable_thinking: true,
            template_kwargs: HashMap::from([(text("reasoning_effort"), text("low"))]),
        }
    }

    fn params() -> GenerationParams {
        GenerationParams {
            max_tokens: Some(48),
            temperature: Some(0.5),
            top_p: Some(0.75),
            top_k: Some(40),
            seed: Some(-7),
            enable_thinking: true,
            template_kwargs: BTreeMap::from([(text("reasoning_effort"), text("low"))]),
        }
    }

    fn core_target() -> CoreLoadTarget {
        CoreLoadTarget {
            ref_kind: CoreModelRefKind::File,
            ref_value: text("/sdcard/qwen3.gguf"),
            id: text("qwen3"),
            path: text("/sdcard/qwen3.gguf"),
            format: CoreModelFormat::Gguf,
            engine_id: text("llama.cpp-cpu"),
            context_size: Some(4096),
            threads: Some(4),
            backend: CoreBackend::Auto,
        }
    }

    fn core_config() -> CoreEngineConfig {
        CoreEngineConfig {
            cache_dir: text("/data/cache"),
            native_library_dir: Some(text("/data/app/lib/arm64")),
            load_journal_path: Some(text("/models/.turbollm-sdk/loading.json")),
            max_queued_requests: 8,
            load_stall_seconds: 120,
            forced_unavailable: HashMap::from([(text("litert-lm"), text("forced by a test"))]),
        }
    }

    #[test]
    fn model_formats_mirror_the_domain() {
        assert_mirrors(ModelFormat::Gguf, CoreModelFormat::Gguf);
        assert_mirrors(ModelFormat::Litertlm, CoreModelFormat::Litertlm);
    }

    #[test]
    fn engine_kinds_mirror_the_domain() {
        assert_mirrors(EngineKind::LlamaCpp, CoreEngineKind::LlamaCpp);
        assert_mirrors(EngineKind::LitertLm, CoreEngineKind::LitertLm);
    }

    #[test]
    fn backends_mirror_the_domain() {
        assert_mirrors(Backend::Auto, CoreBackend::Auto);
        assert_mirrors(Backend::Cpu, CoreBackend::Cpu);
        assert_mirrors(Backend::Gpu, CoreBackend::Gpu);
    }

    #[test]
    fn finish_reasons_mirror_the_domain() {
        assert_mirrors(FinishReason::Stop, CoreFinishReason::Stop);
        assert_mirrors(FinishReason::Length, CoreFinishReason::Length);
    }

    #[test]
    fn chat_roles_mirror_the_domain() {
        assert_mirrors(Role::System, CoreChatRole::System);
        assert_mirrors(Role::User, CoreChatRole::User);
        assert_mirrors(Role::Assistant, CoreChatRole::Assistant);
    }

    #[test]
    fn message_contents_mirror_the_domain() {
        assert_mirrors(
            MessageContent::Text(text("hi")),
            CoreMessageContent::Text { text: text("hi") },
        );
        assert_mirrors(
            MessageContent::Parts(vec![text("a"), text("b")]),
            CoreMessageContent::Parts {
                texts: vec![text("a"), text("b")],
            },
        );
    }

    #[test]
    fn chat_messages_mirror_the_domain() {
        let message = ChatMessage {
            role: Role::Assistant,
            content: MessageContent::Text(text("hello")),
        };
        let kotlin = CoreChatMessage {
            role: CoreChatRole::Assistant,
            content: CoreMessageContent::Text {
                text: text("hello"),
            },
        };
        assert_mirrors(message, kotlin);
    }

    #[test]
    fn generation_params_mirror_the_domain() {
        assert_mirrors(params(), core_params());
        assert_mirrors(
            GenerationParams::default(),
            CoreGenerationParams {
                max_tokens: None,
                temperature: None,
                top_p: None,
                top_k: None,
                seed: None,
                enable_thinking: false,
                template_kwargs: HashMap::new(),
            },
        );
    }

    #[test]
    fn generate_requests_mirror_the_domain() {
        let request = GenerateRequest {
            messages: vec![ChatMessage {
                role: Role::User,
                content: MessageContent::Parts(vec![text("one"), text("two")]),
            }],
            params: params(),
        };
        let kotlin = CoreGenerateRequest {
            messages: vec![CoreChatMessage {
                role: CoreChatRole::User,
                content: CoreMessageContent::Parts {
                    texts: vec![text("one"), text("two")],
                },
            }],
            params: core_params(),
        };
        assert_mirrors(request, kotlin);
    }

    #[test]
    fn engine_events_mirror_the_domain() {
        assert_mirrors(
            EngineEvent::Prefilled {
                prompt_tokens: 12,
                prompt_ms: 3.5,
            },
            CoreEngineEvent::Prefilled {
                prompt_tokens: 12,
                prompt_ms: 3.5,
            },
        );
        assert_mirrors(
            EngineEvent::Text(text("Hel")),
            CoreEngineEvent::Text { text: text("Hel") },
        );
        assert_mirrors(
            EngineEvent::Reasoning(text("hmm")),
            CoreEngineEvent::Reasoning { text: text("hmm") },
        );
        assert_mirrors(
            EngineEvent::Done {
                reason: FinishReason::Length,
                prompt_tokens: 12,
                completion_tokens: 48,
                prompt_ms: 3.5,
                gen_ms: 250.25,
            },
            CoreEngineEvent::Done {
                reason: CoreFinishReason::Length,
                prompt_tokens: 12,
                completion_tokens: 48,
                prompt_ms: 3.5,
                gen_ms: 250.25,
            },
        );
    }

    #[test]
    fn engine_descriptors_mirror_the_domain() {
        assert_mirrors(descriptor(), core_descriptor());
    }

    #[test]
    fn an_available_engine_is_listed_without_a_reason() {
        let listed = CoreEngineInfo::from((descriptor(), Availability::Available));
        let expected = CoreEngineInfo {
            descriptor: core_descriptor(),
            unavailable_reason: None,
        };
        assert_eq!(listed, expected);
    }

    #[test]
    fn an_unavailable_engine_is_listed_with_its_reason() {
        let unavailable = Availability::Unavailable {
            reason: text("LiteRT-LM cannot run on this device: no GPU"),
        };
        let listed = CoreEngineInfo::from((descriptor(), unavailable));
        assert_eq!(
            listed.unavailable_reason.as_deref(),
            Some("LiteRT-LM cannot run on this device: no GPU")
        );
    }

    #[test]
    fn the_engine_config_becomes_the_cores_config() {
        let config = EnginesConfig::try_from(core_config()).unwrap();
        assert_eq!(config.cache_dir, PathBuf::from("/data/cache"));
        assert_eq!(
            config.library_dir,
            Some(PathBuf::from("/data/app/lib/arm64"))
        );
        assert_eq!(
            config.journal_path,
            Some(PathBuf::from("/models/.turbollm-sdk/loading.json"))
        );
        assert_eq!(config.max_queued, 8);
        assert_eq!(config.stall, Duration::from_secs(120));
        let forced = BTreeMap::from([(EngineId::new("litert-lm"), text("forced by a test"))]);
        assert_eq!(config.forced_unavailable, forced);
    }

    #[test]
    fn an_engine_config_without_optional_paths_keeps_none() {
        let kotlin = CoreEngineConfig {
            native_library_dir: None,
            load_journal_path: None,
            ..core_config()
        };
        let config = EnginesConfig::try_from(kotlin).unwrap();
        assert_eq!((config.library_dir, config.journal_path), (None, None));
    }

    #[test]
    fn load_targets_mirror_the_domain() {
        let target = LoadTarget {
            model_ref: ModelRef::File(text("/sdcard/qwen3.gguf")),
            id: text("qwen3"),
            format: ModelFormat::Gguf,
            engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
            path: PathBuf::from("/sdcard/qwen3.gguf"),
            context_size: Some(4096),
            threads: Some(4),
            backend: Backend::Auto,
        };
        assert_mirrors(target, core_target());
    }

    #[test]
    fn an_installed_model_ref_mirrors_the_domain() {
        let target = LoadTarget {
            model_ref: ModelRef::Installed(text("qwen3")),
            id: text("qwen3"),
            format: ModelFormat::Litertlm,
            engine: EngineId::new(EngineId::LITERT_LM),
            path: PathBuf::from("/models/qwen3.litertlm"),
            context_size: None,
            threads: None,
            backend: Backend::Gpu,
        };
        let kotlin = CoreLoadTarget {
            ref_kind: CoreModelRefKind::Installed,
            ref_value: text("qwen3"),
            path: text("/models/qwen3.litertlm"),
            format: CoreModelFormat::Litertlm,
            engine_id: text("litert-lm"),
            context_size: None,
            threads: None,
            backend: CoreBackend::Gpu,
            ..core_target()
        };
        assert_mirrors(target, kotlin);
    }

    #[test]
    fn load_specs_mirror_the_domain() {
        let spec = LoadSpec {
            path: PathBuf::from("/models/qwen3.litertlm"),
            context_size: Some(2048),
            threads: 6,
            backend: Backend::Gpu,
            cache_dir: PathBuf::from("/data/cache"),
        };
        let kotlin = CoreLoadSpec {
            path: text("/models/qwen3.litertlm"),
            context_size: Some(2048),
            threads: 6,
            backend: CoreBackend::Gpu,
            cache_dir: text("/data/cache"),
        };
        assert_mirrors(spec, kotlin);
    }

    #[test]
    fn model_infos_mirror_the_domain() {
        assert_mirrors(model_info(), core_model_info());
    }

    #[test]
    fn loaded_models_mirror_the_domain() {
        assert_mirrors(loaded_model(), core_loaded_model());
    }

    #[test]
    fn idle_and_closed_states_mirror_the_domain() {
        assert_mirrors(EngineState::Idle, CoreEngineState::Idle);
        assert_mirrors(EngineState::Closed, CoreEngineState::Closed);
    }

    #[test]
    fn a_loading_state_mirrors_the_domain() {
        assert_mirrors(
            EngineState::Loading(ModelRef::Installed(text("qwen3"))),
            CoreEngineState::Loading {
                ref_kind: CoreModelRefKind::Installed,
                ref_value: text("qwen3"),
            },
        );
    }

    #[test]
    fn a_ready_state_mirrors_the_domain() {
        let ready = EngineState::Ready {
            model: loaded_model(),
            busy: true,
            queued: 3,
        };
        let kotlin = CoreEngineState::Ready {
            model: core_loaded_model(),
            busy: true,
            queued: 3,
        };
        assert_mirrors(ready, kotlin);
    }

    #[test]
    fn a_failed_state_mirrors_the_domain_with_its_failure() {
        let failed = EngineState::Failed(
            ModelRef::File(text("/sdcard/x.gguf")),
            EngineError::ModelLoadFailed(text("llama.cpp could not load the model: bad magic")),
        );
        let kotlin = CoreEngineState::Failed {
            ref_kind: CoreModelRefKind::File,
            ref_value: text("/sdcard/x.gguf"),
            failure: CoreFailure {
                code: CoreFailureCode::ModelLoadFailed,
                detail: text("llama.cpp could not load the model: bad magic"),
                engine_id: None,
                engine_kind: None,
                param: None,
                invalid_reason: None,
            },
        };
        assert_mirrors(failed, kotlin);
    }

    #[test]
    fn snapshots_mirror_the_domain() {
        let snapshot = Snapshot {
            revision: 42,
            state: EngineState::Idle,
        };
        let kotlin = CoreEngineSnapshot {
            revision: 42,
            state: CoreEngineState::Idle,
        };
        assert_mirrors(snapshot, kotlin);
    }

    #[test]
    fn counts_beyond_kotlins_int_saturate_instead_of_turning_negative() {
        let huge = LoadedModelInfo {
            info: ModelInfo {
                context_size: u32::MAX,
                trained_context: Some(u32::MAX),
                ..model_info()
            },
            ..loaded_model()
        };
        let kotlin = CoreLoadedModel::from(huge);
        assert_eq!(kotlin.context_size, i32::MAX);
        assert_eq!(kotlin.trained_context, Some(i32::MAX));
        let ready = EngineState::Ready {
            model: loaded_model(),
            busy: false,
            queued: usize::MAX,
        };
        let CoreEngineState::Ready { queued, .. } = CoreEngineState::from(ready) else {
            panic!("expected Ready");
        };
        assert_eq!(queued, i32::MAX);
    }

    #[test]
    fn a_revision_beyond_kotlins_long_saturates() {
        let snapshot = Snapshot {
            revision: u64::MAX,
            state: EngineState::Closed,
        };
        assert_eq!(CoreEngineSnapshot::from(snapshot).revision, i64::MAX);
    }

    #[test]
    fn a_negative_load_target_count_is_refused_naming_its_field() {
        let negative_context = CoreLoadTarget {
            context_size: Some(-1),
            ..core_target()
        };
        let negative_threads = CoreLoadTarget {
            threads: Some(-4),
            ..core_target()
        };
        assert_eq!(
            refused_field::<LoadTarget, _>(negative_context).as_deref(),
            Some("context_size")
        );
        assert_eq!(
            refused_field::<LoadTarget, _>(negative_threads).as_deref(),
            Some("threads")
        );
    }

    #[test]
    fn a_negative_max_tokens_is_refused_naming_its_field() {
        let kotlin = CoreGenerationParams {
            max_tokens: Some(-1),
            ..core_params()
        };
        assert_eq!(
            refused_field::<GenerationParams, _>(kotlin).as_deref(),
            Some("max_tokens")
        );
    }

    #[test]
    fn a_negative_config_value_is_refused_naming_its_field() {
        let negative_queue = CoreEngineConfig {
            max_queued_requests: -1,
            ..core_config()
        };
        let negative_stall = CoreEngineConfig {
            load_stall_seconds: -120,
            ..core_config()
        };
        assert_eq!(
            refused_field::<EnginesConfig, _>(negative_queue).as_deref(),
            Some("max_queued_requests")
        );
        assert_eq!(
            refused_field::<EnginesConfig, _>(negative_stall).as_deref(),
            Some("load_stall_seconds")
        );
    }

    #[test]
    fn a_negative_token_count_from_a_foreign_engine_is_refused_naming_its_field() {
        let event = CoreEngineEvent::Prefilled {
            prompt_tokens: -3,
            prompt_ms: 1.0,
        };
        assert_eq!(
            refused_field::<EngineEvent, _>(event).as_deref(),
            Some("prompt_tokens")
        );
    }

    #[test]
    fn a_refused_count_says_which_value_was_negative() {
        let kotlin = CoreModelInfo {
            context_size: -5,
            ..core_model_info()
        };
        let refusal = ModelInfo::try_from(kotlin).unwrap_err();
        assert_eq!(
            refusal.to_string(),
            "context_size must not be negative, but was -5."
        );
    }
}
