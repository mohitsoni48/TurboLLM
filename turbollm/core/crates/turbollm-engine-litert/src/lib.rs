//! LiteRT-LM as a TurboLLM engine, driven through Google's LiteRT-LM C library (ADR-482).
//!
//! The runtime this crate dlopens is pinned in `litert-runtime.json` and staged by `cargo xtask fetch-litert`.

pub mod api;
pub mod chunk;
mod model;
pub mod prompt;
mod reply;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use turbollm_engine::{
    Backend, EngineDescriptor, EngineError, EngineId, EngineKind, LoadControl, LoadSpec,
    ModelFormat, ModelInfo, NativeBackend, StallPolicy,
};
use turbollm_platform::{HostFacts, library_candidates};

use crate::api::{LiteRtApi, LiteRtCalls};

pub use model::LiteRtModel;

/// The name of every LiteRT-LM model's engine thread (`LiteRtLmEngine.kt:13`).
pub const ENGINE_THREAD_NAME: &str = "turbollm-litert";

/// What a load that fell back from the GPU to the CPU says, before the GPU's own reason.
pub const GPU_UNAVAILABLE_PREFIX: &str = "GPU unavailable: ";

/// The runtime's library name without its OS prefix and suffix: `libturbollm_core_litertlm.so` on
/// Android (never Google's own `liblitert-lm.so`, which the app's opt-in server ships, ADR-432).
pub const LIBRARY_STEM: &str = "turbollm_core_litertlm";

/// The function table a backend shares with each model it opens.
pub type SharedCalls = Arc<dyn LiteRtCalls + Send + Sync>;

/// Monotonic time since some fixed start, read on the thread LiteRT streams a reply from; tests
/// stand in a scripted one.
pub type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;

type LibraryOpener = Box<dyn Fn() -> Result<SharedCalls, EngineError> + Send + Sync>;

/// LiteRT-LM for `InProcess`: the runtime library opens on the first load, once per backend
/// instance (T-9), and every model runs on its own `turbollm-litert` thread.
pub struct LiteRtBackend {
    descriptor: EngineDescriptor,
    open_library: LibraryOpener,
    library: Mutex<Option<SharedCalls>>,
    clock: Clock,
}

impl LiteRtBackend {
    /// The runtime library from `library_dir` when it is there, else from the loader's search
    /// path; opened by the first load.
    pub fn new(library_dir: Option<PathBuf>) -> LiteRtBackend {
        LiteRtBackend::over(move || open_native(library_dir.as_deref()))
    }

    /// A backend over the calls `open_library` gives, opened on the first load; a failed open is
    /// tried again by the next load.
    pub fn over(
        open_library: impl Fn() -> Result<SharedCalls, EngineError> + Send + Sync + 'static,
    ) -> LiteRtBackend {
        let start = Instant::now();
        LiteRtBackend {
            descriptor: litert_descriptor(),
            open_library: Box::new(open_library),
            library: Mutex::new(None),
            clock: Arc::new(move || start.elapsed()),
        }
    }

    pub fn with_clock(self, clock: Clock) -> LiteRtBackend {
        LiteRtBackend { clock, ..self }
    }

    fn library(&self) -> Result<SharedCalls, EngineError> {
        let mut library = self.library.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(calls) = library.as_ref() {
            return Ok(Arc::clone(calls));
        }
        let calls = (self.open_library)()?;
        Ok(Arc::clone(library.insert(calls)))
    }
}

impl NativeBackend for LiteRtBackend {
    type Model = LiteRtModel;

    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    /// Loads no native code: whether the library is there is learnt by opening it.
    fn probe(&self, _host: &HostFacts) -> Option<String> {
        None
    }

    /// LiteRT-LM reports no load progress, so a long load is not a stalled one (ADR-460).
    fn stall_policy(&self) -> StallPolicy {
        StallPolicy::Exempt
    }

    fn thread_name(&self) -> &'static str {
        ENGINE_THREAD_NAME
    }

    fn open(
        &self,
        spec: &LoadSpec,
        _ctl: &LoadControl,
    ) -> Result<(LiteRtModel, ModelInfo), EngineError> {
        LiteRtModel::open(self.library()?, spec, Arc::clone(&self.clock))
    }
}

/// The first candidate that opens; when none does, the last one's reason.
fn open_native(library_dir: Option<&Path>) -> Result<SharedCalls, EngineError> {
    let mut failure = None;
    for file in library_candidates(LIBRARY_STEM, library_dir) {
        match LiteRtApi::open(&file) {
            Ok(api) => return Ok(Arc::new(api)),
            Err(error) => failure = Some(error),
        }
    }
    Err(failure.unwrap_or_else(|| api::unavailable(&"no library to open")))
}

fn litert_descriptor() -> EngineDescriptor {
    EngineDescriptor {
        id: EngineId::new(EngineId::LITERT_LM),
        name: "LiteRT-LM".to_owned(),
        kind: EngineKind::LitertLm,
        formats: vec![ModelFormat::Litertlm],
        backends: vec![Backend::Gpu, Backend::Cpu],
    }
}
