//! The fake LiteRT-LM, and the ways a test drives the LiteRT backend: its own `open`, or the
//! manager that owns it.

pub mod fake_litert;
mod litert_manager;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use turbollm_engine::{
    AbortSignal, Backend, ChatMessage, EngineError, EngineEvent, EngineId, EngineManager,
    GenerateRequest, Generation, GenerationParams, LoadControl, LoadSpec, LoadTarget,
    MessageContent, ModelFormat, ModelRef, Role,
};
use turbollm_engine_litert::{LiteRtBackend, LoadedLibrary};

use fake_litert::FakeLiteRt;

pub const MODEL: &str = "models/gemma.litertlm";
pub const CACHE: &str = "cache/turbollm";
pub const PROMPT_LIMIT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(2);

pub const FAKE_LIBRARY_FILE: &str = "fake-litert-lm.so";

pub fn backend(fake: &Arc<FakeLiteRt>) -> LiteRtBackend {
    let calls = fake.calls();
    LiteRtBackend::over(move || {
        Ok(LoadedLibrary {
            calls: Arc::clone(&calls),
            file: PathBuf::from(FAKE_LIBRARY_FILE),
        })
    })
    .with_clock(fake.clock())
}

pub fn spec(context_size: Option<u32>, threads: u32, backend: Backend) -> LoadSpec {
    LoadSpec {
        path: PathBuf::from(MODEL),
        context_size,
        threads,
        backend,
        cache_dir: PathBuf::from(CACHE),
    }
}

pub fn control() -> LoadControl {
    LoadControl {
        progress: Arc::new(|_| {}),
        abort: AbortSignal::new(),
    }
}

/// The path the library is handed for `path` (`LiteRtLmEngine.kt:97-99` passes `absolutePath`).
pub fn absolute(path: &str) -> String {
    std::path::absolute(path)
        .expect("a relative path has an absolute form")
        .to_string_lossy()
        .into_owned()
}

pub fn question() -> GenerateRequest {
    asking(GenerationParams::default())
}

pub fn asking(params: GenerationParams) -> GenerateRequest {
    GenerateRequest {
        messages: vec![message(Role::User, "Say hi.")],
        params,
    }
}

pub fn message(role: Role, text: &str) -> ChatMessage {
    ChatMessage {
        role,
        content: MessageContent::Text(text.to_owned()),
    }
}

/// A manager whose only engine is LiteRT-LM over `fake`, in-process on every host.
pub fn manager_over(fake: &Arc<FakeLiteRt>) -> EngineManager {
    litert_manager::manager_over(backend(fake), Duration::ZERO, PathBuf::from(CACHE))
}

pub fn target(backend: Backend) -> LoadTarget {
    LoadTarget {
        model_ref: ModelRef::File(MODEL.to_owned()),
        id: "gemma".to_owned(),
        format: ModelFormat::Litertlm,
        engine: EngineId::new(EngineId::LITERT_LM),
        path: PathBuf::from(MODEL),
        context_size: Some(1024),
        threads: Some(4),
        backend,
    }
}

pub async fn load(manager: &EngineManager) {
    let claim = manager
        .claim_load(target(Backend::Cpu))
        .expect("nothing else is loading");
    claim.run().await.expect("the fake opens the model");
}

/// A manager with the model loaded over `fake`.
pub async fn loaded(fake: &Arc<FakeLiteRt>) -> EngineManager {
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

/// Text and reasoning only.
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

/// Reads until the first text arrives; a reply that ends or fails first, or takes longer than
/// `PROMPT_LIMIT`, fails the test saying what it saw instead of spinning.
pub async fn until_first_text(generation: &mut Generation) {
    let reading = async {
        loop {
            match generation.next().await {
                Ok(Some(EngineEvent::Text(_))) => return,
                Ok(Some(_)) => {}
                Ok(None) => panic!("the reply ended before any text"),
                Err(error) => panic!("the reply failed before any text: {error:?}"),
            }
        }
    };
    tokio::time::timeout(PROMPT_LIMIT, reading)
        .await
        .unwrap_or_else(|_| panic!("no text arrived within {PROMPT_LIMIT:?}"));
}
