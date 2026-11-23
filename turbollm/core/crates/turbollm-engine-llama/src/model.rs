//! One open llama.cpp model: its session, the table it came from, and the abort flag the
//! library's abort callback reads (arch 2.4.2, 2.4.4, T-6).

use std::ffi::{CString, c_void};
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use turbollm_engine::{
    AbortHook, AbortSignal, Backend, EngineError, EventSink, GenerateRequest, LoadControl,
    LoadSpec, ModelInfo, NativeModel,
};

use crate::api::{LoadRequest, ModelInfo as NativeModelInfo, Session};
use crate::{GPU_UNAVAILABLE_NOTE, LlamaLog, SharedCalls, reply};

/// The context a load without a size gets at most (`LlamaCppEngine.kt:32`).
const DEFAULT_CONTEXT_SIZE: u32 = 4096;
const LOAD_FAILED: &str = "llama.cpp could not load the model: ";

/// A session open on its engine thread. The session is freed before the abort flag it reads is
/// dropped (T-6), and only ever on the engine thread (T-1, T-5).
pub struct LlamaModel {
    session: Option<Session>,
    calls: SharedCalls,
    abort_flag: Arc<AtomicBool>,
}

impl LlamaModel {
    /// Opens `spec`'s model at the context `ContextPlan` picks, reopening once at llama.cpp's
    /// trained context when that is smaller and no size was asked for (E-1, PG-9).
    pub(crate) fn open(
        calls: SharedCalls,
        spec: &LoadSpec,
        ctl: &LoadControl,
        log: &LlamaLog,
    ) -> Result<(LlamaModel, ModelInfo), EngineError> {
        let path = native_path(&spec.path)?;
        let plan = ContextPlan::for_spec(spec);
        let opener = SessionOpener {
            calls: &calls,
            path: &path,
            threads: spec.threads,
            ctl,
            abort_flag: Arc::new(AtomicBool::new(false)),
        };
        let (mut session, mut native) = opener.open(plan.requested())?;
        if let Some(trained) = plan.reopen_at(native) {
            plan.log_disagreement(trained, log);
            calls.free(session);
            (session, native) = opener.open(trained)?;
        }
        let info = model_info(native, spec.backend);
        let abort_flag = opener.abort_flag;
        let model = LlamaModel {
            session: Some(session),
            calls,
            abort_flag,
        };
        Ok((model, info))
    }
}

impl NativeModel for LlamaModel {
    fn generate(
        &mut self,
        req: &GenerateRequest,
        sink: &mut EventSink,
        abort: &AbortSignal,
    ) -> Result<(), EngineError> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(EngineError::queued_request_unloaded)?;
        self.abort_flag.store(false, Ordering::SeqCst);
        reply::generate(self.calls.as_ref(), session, req, sink, abort)
    }

    /// Raises the flag llama.cpp polls during a prefill or decode; safe from any thread.
    fn abort_hook(&self) -> AbortHook {
        let flag = Arc::clone(&self.abort_flag);
        Arc::new(move || flag.store(true, Ordering::SeqCst))
    }

    fn close(self) {
        drop(self);
    }
}

impl Drop for LlamaModel {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            self.calls.free(session);
        }
    }
}

/// The context a load asks llama.cpp for (arch 2.4.4).
enum ContextPlan {
    /// The caller's size: never reopened (`LlamaCppEngine.kt:87`).
    Explicit(u32),
    /// The GGUF header's trained context.
    FromHeader(u32),
    /// No usable header: the old rule, open at 4096 then check (`LlamaCppEngine.kt:82-90`).
    Default,
}

impl ContextPlan {
    fn for_spec(spec: &LoadSpec) -> ContextPlan {
        if let Some(size) = spec.context_size {
            return ContextPlan::Explicit(size);
        }
        match header_context(&spec.path) {
            0 => ContextPlan::Default,
            trained => ContextPlan::FromHeader(trained),
        }
    }

    fn requested(&self) -> u32 {
        match self {
            ContextPlan::Explicit(size) => *size,
            ContextPlan::FromHeader(trained) => (*trained).min(DEFAULT_CONTEXT_SIZE),
            ContextPlan::Default => DEFAULT_CONTEXT_SIZE,
        }
    }

    /// llama.cpp's trained context when it is smaller than what was opened.
    fn reopen_at(&self, opened: NativeModelInfo) -> Option<u32> {
        if matches!(self, ContextPlan::Explicit(_)) {
            return None;
        }
        u32::try_from(opened.n_ctx_train)
            .ok()
            .filter(|trained| (1..self.requested()).contains(trained))
    }

    fn log_disagreement(&self, trained: u32, log: &LlamaLog) {
        if let ContextPlan::FromHeader(header) = self {
            log(&format!(
                "context from the GGUF header ({header}) disagreed with llama.cpp ({trained}); \
                 reopened at {trained}"
            ));
        }
    }
}

/// The trained context the GGUF header names, or 0 when it names none or cannot be read.
fn header_context(path: &Path) -> u32 {
    turbollm_gguf::parse_file(path, turbollm_gguf::MAX_HEADER_READ)
        .map_or(0, |meta| meta.native_ctx)
}

/// What one native open needs besides the context size.
struct SessionOpener<'a> {
    calls: &'a SharedCalls,
    path: &'a CString,
    threads: u32,
    ctl: &'a LoadControl,
    abort_flag: Arc<AtomicBool>,
}

impl SessionOpener<'_> {
    fn open(&self, context_size: u32) -> Result<(Session, NativeModelInfo), EngineError> {
        let request = LoadRequest {
            path: self.path,
            n_ctx: to_c_int(context_size),
            n_threads: to_c_int(self.threads),
            progress: Some(report_progress),
            progress_data: std::ptr::from_ref(self.ctl).cast_mut().cast::<c_void>(),
            abort: Some(abort_requested),
            abort_data: Arc::as_ptr(&self.abort_flag).cast_mut().cast::<c_void>(),
        };
        // SAFETY: `ctl` outlives this call, and the abort flag outlives the session, which the
        // model frees before dropping its clone of the flag (T-6); each callback reads its own type.
        let session = unsafe { self.calls.load(&request) }.map_err(load_failed)?;
        let native = self.calls.model_info(&session);
        Ok((session, native))
    }
}

/// `tl_progress_fn`: feeds the stall watch and stops the load once it is aborted (ADR-460).
unsafe extern "C" fn report_progress(progress: f32, data: *mut c_void) -> bool {
    // SAFETY: `data` is the `LoadControl` `SessionOpener::open` passed, alive for the load.
    let ctl = unsafe { &*data.cast::<LoadControl>() };
    panic::catch_unwind(AssertUnwindSafe(|| {
        (ctl.progress)(progress);
        !ctl.abort.is_aborted()
    }))
    .unwrap_or(false)
}

/// `tl_abort_fn`: true once the model's abort hook ran.
unsafe extern "C" fn abort_requested(data: *mut c_void) -> bool {
    // SAFETY: `data` is the model's abort flag, which outlives its session (T-6).
    unsafe { &*data.cast::<AtomicBool>() }.load(Ordering::SeqCst)
}

/// The model's path as the library takes it: absolute, as Kotlin passed `absolutePath`.
fn native_path(path: &Path) -> Result<CString, EngineError> {
    let absolute = std::path::absolute(path).map_err(|error| load_failed(error.to_string()))?;
    let text = absolute
        .to_str()
        .ok_or_else(|| load_failed(format!("{} is not a UTF-8 path", absolute.display())))?;
    CString::new(text).map_err(|error| load_failed(error.to_string()))
}

fn model_info(native: NativeModelInfo, asked: Backend) -> ModelInfo {
    ModelInfo {
        context_size: u32::try_from(native.n_ctx).unwrap_or(0),
        trained_context: u32::try_from(native.n_ctx_train).ok().filter(|&n| n > 0),
        backend: Backend::Cpu,
        notes: notes_for(asked),
    }
}

/// `LlamaCppEngine.kt:148-149`.
fn notes_for(asked: Backend) -> Vec<String> {
    match asked {
        Backend::Gpu => vec![GPU_UNAVAILABLE_NOTE.to_owned()],
        Backend::Auto | Backend::Cpu => Vec::new(),
    }
}

fn load_failed(reason: String) -> EngineError {
    EngineError::ModelLoadFailed(format!("{LOAD_FAILED}{reason}"))
}

fn to_c_int(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}
