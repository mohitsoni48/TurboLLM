//! The fake session library, GGUF headers, and the ways a test drives the llama backend: its own
//! `open`, the in-process engine, or the manager that owns it.

pub mod fake_llama;
pub mod gguf;
pub mod llama_manager;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use turbollm_engine::{
    AbortSignal, Backend, ChatMessage, EngineError, EngineEvent, EngineId, EngineManager,
    GenerateRequest, Generation, GenerationParams, LoadControl, LoadSpec, LoadTarget,
    MessageContent, ModelFormat, ModelRef, Role,
};
use turbollm_engine_llama::LlamaBackend;

use fake_llama::FakeLlama;

pub const MODEL: &str = "models/tiny.gguf";
pub const PROMPT_LIMIT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(2);

pub fn backend(fake: &Arc<FakeLlama>) -> LlamaBackend {
    let fake = Arc::clone(fake);
    LlamaBackend::over(move || fake.library())
}

/// A backend whose log lines the test reads back.
pub fn logged_backend(fake: &Arc<FakeLlama>) -> (LlamaBackend, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&lines);
    let log = Arc::new(move |line: &str| {
        sink.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(line.to_owned());
    });
    (backend(fake).with_log(log), lines)
}

pub fn spec(path: &Path, context_size: Option<u32>, threads: u32, backend: Backend) -> LoadSpec {
    LoadSpec {
        path: path.to_path_buf(),
        context_size,
        threads,
        backend,
        cache_dir: PathBuf::from("cache"),
    }
}

pub fn default_spec(path: &Path) -> LoadSpec {
    spec(path, None, 4, Backend::Auto)
}

pub fn control() -> LoadControl {
    LoadControl {
        progress: Arc::new(|_| {}),
        abort: AbortSignal::new(),
    }
}

/// The path the library is handed for `path` (`LlamaCppEngine.kt:93` passes `absolutePath`).
pub fn absolute(path: &str) -> String {
    std::path::absolute(path)
        .expect("a relative path has an absolute form")
        .to_string_lossy()
        .into_owned()
}

pub fn question() -> GenerateRequest {
    GenerateRequest {
        messages: vec![ChatMessage {
            role: Role::User,
            content: MessageContent::Text("Hello?".to_owned()),
        }],
        params: GenerationParams::default(),
    }
}

pub fn asking(params: GenerationParams) -> GenerateRequest {
    GenerateRequest {
        params,
        ..question()
    }
}

/// A manager whose only engine is llama.cpp over `fake`, in-process on every host.
pub fn manager_over(fake: &Arc<FakeLlama>) -> EngineManager {
    llama_manager::manager_over(backend(fake), Duration::ZERO, PathBuf::from("cache"))
}

pub fn target(threads: Option<u32>) -> LoadTarget {
    LoadTarget {
        model_ref: ModelRef::File(MODEL.to_owned()),
        id: "tiny".to_owned(),
        format: ModelFormat::Gguf,
        engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
        path: PathBuf::from(MODEL),
        context_size: None,
        threads,
        backend: Backend::Auto,
    }
}

pub async fn load(manager: &EngineManager) {
    let claim = manager
        .claim_load(target(None))
        .expect("nothing else is loading");
    claim.run().await.expect("the fake opens the model");
}

/// A manager with the model loaded over `fake`.
pub async fn loaded(fake: &Arc<FakeLlama>) -> EngineManager {
    let manager = manager_over(fake);
    load(&manager).await;
    manager
}

pub async fn reply(
    manager: &EngineManager,
    request: GenerateRequest,
) -> Result<Vec<EngineEvent>, EngineError> {
    let mut generation = manager.generate(request).await?;
    every_event(&mut generation).await
}

pub async fn every_event(generation: &mut Generation) -> Result<Vec<EngineEvent>, EngineError> {
    let mut events = Vec::new();
    while let Some(event) = generation.next().await? {
        events.push(event);
    }
    Ok(events)
}

/// Text and reasoning only (`testing/EngineEvents.kt` `pieces`).
pub fn pieces(events: &[EngineEvent]) -> Vec<EngineEvent> {
    events
        .iter()
        .filter(|event| matches!(event, EngineEvent::Text(_) | EngineEvent::Reasoning(_)))
        .cloned()
        .collect()
}

pub async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + PROMPT_LIMIT;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(POLL).await;
    }
}
