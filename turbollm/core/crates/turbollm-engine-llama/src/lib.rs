//! llama.cpp as a TurboLLM engine: the session library's C function table, the CPU variant that
//! runs on this device, UTF-8 framing of streamed tokens, the request a reply is prepared from, and
//! the backend the in-process engine kind drives (arch 2.4.2).

pub mod api;
mod model;
mod reply;
pub mod utf8;
pub mod variant;
pub mod wire;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use turbollm_engine::{
    Backend, EngineDescriptor, EngineError, EngineId, EngineKind, LoadControl, LoadSpec,
    ModelFormat, ModelInfo, NativeBackend, StallPolicy,
};
use turbollm_platform::HostFacts;

use crate::api::{LlamaApi, LlamaCalls};

pub use model::LlamaModel;

/// The note a load that asked for the GPU carries (`LlamaCppEngine.kt:29`).
pub const GPU_UNAVAILABLE_NOTE: &str = "GPU is not available for llama.cpp in M1; ran on CPU";

/// The name of every llama.cpp model's engine thread (`LlamaCppEngine.kt:31`).
pub const ENGINE_THREAD_NAME: &str = "turbollm-llama";

/// The function table a backend shares with each model it opens.
pub type SharedCalls = Arc<dyn LlamaCalls + Send + Sync>;

/// Where the backend reports what a host log should keep: the library it loaded, and a GGUF
/// header the library disagreed with. The Android core sends it to logcat; desktop cores write it
/// nowhere (they list no llama row).
pub type LlamaLog = Arc<dyn Fn(&str) + Send + Sync>;

/// A session library that opened, and the file it came from.
pub struct LoadedLibrary {
    pub calls: SharedCalls,
    pub file: PathBuf,
}

type LibraryOpener = Box<dyn Fn() -> Result<LoadedLibrary, EngineError> + Send + Sync>;

/// llama.cpp for `InProcess`: the session library opens on the first load, once per backend
/// instance (T-9), and every model runs on its own `turbollm-llama` thread.
pub struct LlamaBackend {
    descriptor: EngineDescriptor,
    open_library: LibraryOpener,
    library: Mutex<Option<SharedCalls>>,
    log: LlamaLog,
}

impl LlamaBackend {
    /// The best CPU variant of the session library from `library_dir`, or the loader's search path.
    pub fn new(library_dir: Option<PathBuf>) -> LlamaBackend {
        LlamaBackend::over(move || native_library(library_dir.as_deref()))
    }

    /// A backend over the library `open_library` gives, opened on the first load.
    pub fn over(
        open_library: impl Fn() -> Result<LoadedLibrary, EngineError> + Send + Sync + 'static,
    ) -> LlamaBackend {
        LlamaBackend {
            descriptor: llama_descriptor(),
            open_library: Box::new(open_library),
            library: Mutex::new(None),
            log: Arc::new(|_| {}),
        }
    }

    pub fn with_log(self, log: LlamaLog) -> LlamaBackend {
        LlamaBackend { log, ..self }
    }

    /// The table, opened and initialised by the first load that needs it; a failed open is tried
    /// again by the next load (`LlamaBinding.kt:53-60`).
    fn library(&self) -> Result<SharedCalls, EngineError> {
        let mut library = self.library.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(calls) = library.as_ref() {
            return Ok(Arc::clone(calls));
        }
        let loaded = (self.open_library)()?;
        loaded.calls.backend_init();
        (self.log)(&format!("llama.cpp loaded {}", loaded.file.display()));
        Ok(Arc::clone(library.insert(loaded.calls)))
    }
}

impl NativeBackend for LlamaBackend {
    type Model = LlamaModel;

    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    /// Reads cpuinfo only; no native code loads (`TurboLLMDependencies.kt:102-108`).
    fn probe(&self, host: &HostFacts) -> Option<String> {
        variant::candidates(&host.cpu)
            .is_empty()
            .then(|| variant::NO_VARIANT_RUNS_HERE.to_owned())
    }

    fn stall_policy(&self) -> StallPolicy {
        StallPolicy::Watch
    }

    fn thread_name(&self) -> &'static str {
        ENGINE_THREAD_NAME
    }

    fn open(
        &self,
        spec: &LoadSpec,
        ctl: &LoadControl,
    ) -> Result<(LlamaModel, ModelInfo), EngineError> {
        LlamaModel::open(self.library()?, spec, ctl, &self.log)
    }
}

fn native_library(library_dir: Option<&Path>) -> Result<LoadedLibrary, EngineError> {
    let chosen = variant::load_best(library_dir)?;
    let calls: SharedCalls = Arc::new(LlamaApi::resolve(chosen.library)?);
    Ok(LoadedLibrary {
        calls,
        file: chosen.file,
    })
}

fn llama_descriptor() -> EngineDescriptor {
    EngineDescriptor {
        id: EngineId::new(EngineId::LLAMA_CPP_CPU),
        name: "llama.cpp (CPU)".to_owned(),
        kind: EngineKind::LlamaCpp,
        formats: vec![ModelFormat::Gguf],
        backends: vec![Backend::Cpu],
    }
}

/// llama.cpp cannot run in this build or on this device, for `reason`.
fn llama_unavailable(reason: impl Into<String>) -> EngineError {
    EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
        kind: EngineKind::LlamaCpp,
        reason: reason.into(),
    }
}
