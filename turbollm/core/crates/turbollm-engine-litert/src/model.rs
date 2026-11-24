//! One open LiteRT-LM engine and the conversation that is streaming on it, if any (arch 2.5, T-7).
//! The engine opens on the GPU first, then the CPU with a note (`LiteRtLmEngine.kt:82-108`).

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use turbollm_engine::{
    AbortHook, AbortSignal, Backend, EngineError, EventSink, GenerateRequest, LoadSpec, ModelInfo,
    NativeModel,
};

use crate::api::{ConversationHandle, EngineHandle, EngineSettings};
use crate::{Clock, GPU_UNAVAILABLE_PREFIX, SharedCalls, reply};

/// The context a load without a size gets (`LiteRtLmEngine.kt:14`).
const DEFAULT_CONTEXT_SIZE: u32 = 4096;
const LOAD_FAILED: &str = "LiteRT-LM could not load the model: ";

/// The conversation a reply is streaming on, which the abort hook may cancel from any thread. The
/// engine thread puts it here once started and takes it back, under the lock, once the final chunk
/// was seen and before the conversation is deleted.
pub(crate) type CurrentConversation = Mutex<Option<ConversationHandle>>;

/// An engine open on its engine thread: deleted only there (T-1, T-5), after any conversation.
pub struct LiteRtModel {
    calls: SharedCalls,
    engine: Option<EngineHandle>,
    current: Arc<CurrentConversation>,
    clock: Clock,
}

impl LiteRtModel {
    pub(crate) fn open(
        calls: SharedCalls,
        spec: &LoadSpec,
        clock: Clock,
    ) -> Result<(LiteRtModel, ModelInfo), EngineError> {
        let OpenedEngine {
            engine,
            backend,
            notes,
        } = open_engine(&calls, spec)?;
        let model = LiteRtModel {
            calls,
            engine: Some(engine),
            current: Arc::default(),
            clock,
        };
        let info = ModelInfo {
            context_size: context_size_of(spec),
            trained_context: None,
            backend,
            notes,
        };
        Ok((model, info))
    }
}

impl NativeModel for LiteRtModel {
    fn generate(
        &mut self,
        req: &GenerateRequest,
        sink: &mut EventSink,
        abort: &AbortSignal,
    ) -> Result<(), EngineError> {
        let engine = self
            .engine
            .as_ref()
            .ok_or_else(EngineError::queued_request_unloaded)?;
        let conversation = reply::ReplyContext {
            calls: self.calls.as_ref(),
            engine,
            current: &self.current,
            clock: &self.clock,
        };
        reply::generate(&conversation, req, sink, abort)
    }

    /// Cancels the streaming conversation, if there is one, under the lock the engine thread
    /// takes it back under, so a cancel never reaches a conversation being deleted.
    fn abort_hook(&self) -> AbortHook {
        let calls = Arc::clone(&self.calls);
        let current = Arc::clone(&self.current);
        Arc::new(move || cancel_current(calls.as_ref(), &current))
    }

    fn close(self) {
        drop(self);
    }
}

impl Drop for LiteRtModel {
    fn drop(&mut self) {
        if let Some(conversation) = lock(&self.current).take() {
            self.calls.delete_conversation(conversation);
        }
        if let Some(engine) = self.engine.take() {
            self.calls.delete_engine(engine);
        }
    }
}

/// A failed cancel changes nothing: the reply ends through its final chunk either way.
pub(crate) fn cancel_current(
    calls: &(dyn crate::api::LiteRtCalls + Send + Sync),
    current: &CurrentConversation,
) {
    if let Some(conversation) = lock(current).as_ref() {
        let _ = calls.cancel_reply(conversation);
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// An engine a load settled on, with what it fell back from.
struct OpenedEngine {
    engine: EngineHandle,
    backend: Backend,
    notes: Vec<String>,
}

fn open_engine(calls: &SharedCalls, spec: &LoadSpec) -> Result<OpenedEngine, EngineError> {
    match spec.backend {
        Backend::Cpu => open_on_cpu(calls, spec, Vec::new()),
        Backend::Gpu | Backend::Auto => open_on_gpu_else_cpu(calls, spec),
    }
}

/// A GPU that fails to initialise is a slower load, not a failed one; a device that cannot run
/// LiteRT-LM at all fails either way.
fn open_on_gpu_else_cpu(calls: &SharedCalls, spec: &LoadSpec) -> Result<OpenedEngine, EngineError> {
    match open_on(calls, spec, Backend::Gpu) {
        Ok(engine) => Ok(OpenedEngine {
            engine,
            backend: Backend::Gpu,
            notes: Vec::new(),
        }),
        Err(unavailable @ EngineError::EngineUnavailable { .. }) => Err(unavailable),
        Err(gpu_failure) => {
            let note = format!("{GPU_UNAVAILABLE_PREFIX}{gpu_failure}");
            open_on_cpu(calls, spec, vec![note])
        }
    }
}

fn open_on_cpu(
    calls: &SharedCalls,
    spec: &LoadSpec,
    notes: Vec<String>,
) -> Result<OpenedEngine, EngineError> {
    match open_on(calls, spec, Backend::Cpu) {
        Ok(engine) => Ok(OpenedEngine {
            engine,
            backend: Backend::Cpu,
            notes,
        }),
        Err(failure) => Err(as_load_failure(failure)),
    }
}

fn open_on(
    calls: &SharedCalls,
    spec: &LoadSpec,
    backend: Backend,
) -> Result<EngineHandle, EngineError> {
    let settings = settings_of(spec, backend)?;
    calls.create_engine(&settings)
}

/// The engine port promises `ModelLoadFailed` for a load that fails for any reason but the device.
fn as_load_failure(failure: EngineError) -> EngineError {
    match failure {
        unavailable @ EngineError::EngineUnavailable { .. } => unavailable,
        other => EngineError::ModelLoadFailed(format!("{LOAD_FAILED}{other}")),
    }
}

fn settings_of(spec: &LoadSpec, backend: Backend) -> Result<EngineSettings, EngineError> {
    let on_cpu = backend == Backend::Cpu;
    Ok(EngineSettings {
        model_path: absolute_text(&spec.path)?,
        backend: if on_cpu { "cpu" } else { "gpu" }.to_owned(),
        max_num_tokens: to_c_int(context_size_of(spec)),
        num_threads: on_cpu.then(|| to_c_int(spec.threads)),
        cache_dir: Some(absolute_text(&spec.cache_dir)?),
        enable_benchmark: true,
    })
}

fn context_size_of(spec: &LoadSpec) -> u32 {
    spec.context_size.unwrap_or(DEFAULT_CONTEXT_SIZE)
}

/// The path as the library takes it: absolute, as Kotlin passed `absolutePath`.
fn absolute_text(path: &Path) -> Result<String, EngineError> {
    let absolute =
        std::path::absolute(path).map_err(|error| EngineError::EngineFailure(error.to_string()))?;
    absolute.to_str().map(str::to_owned).ok_or_else(|| {
        EngineError::EngineFailure(format!("{} is not a UTF-8 path", absolute.display()))
    })
}

fn to_c_int(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}
