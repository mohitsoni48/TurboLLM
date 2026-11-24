//! llama.cpp and LiteRT-LM in one process (plan P-5, arch R2a-7): one `Engines` loads the GGUF,
//! generates, unloads, then loads the `.litertlm`, generates, unloads, then the GGUF again. A test
//! binary cannot load an ASan-built library, so the two C++ runtimes meeting in one address space
//! is what is checked instead. Needs the four variables of the llama and LiteRT real-native tests
//! (`TURBOLLM_LLAMA_LIB_DIR`, `TURBOLLM_TEST_GGUF`, `TURBOLLM_LITERT_LIB`, `TURBOLLM_TEST_LITERTLM`);
//! without them the test skips, except on CI, where it fails.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use turbollm_core::engines::{Engines, EnginesConfig};
use turbollm_engine::{
    Backend, ChatMessage, Engine, EngineError, EngineEvent, EngineId, EngineManager, FinishReason,
    GenerateRequest, GenerationParams, InProcess, LoadTarget, MessageContent, ModelFormat,
    ModelRef, Role,
};
use turbollm_engine_litert::api::LiteRtApi;
use turbollm_engine_litert::{LiteRtBackend, SharedCalls};
use turbollm_engine_llama::LlamaBackend;

const MISSING_ENV: &str = "TURBOLLM_LLAMA_LIB_DIR, TURBOLLM_TEST_GGUF, TURBOLLM_LITERT_LIB and \
                           TURBOLLM_TEST_LITERTLM must all be set";
const MAX_QUEUED: u32 = 8;
const CONTEXT_SIZE: u32 = 2048;
const REPLY_TOKENS: u32 = 16;
const LIMIT: Duration = Duration::from_secs(120);

#[test]
fn one_engines_runs_a_gguf_then_a_litertlm_then_the_gguf_again() {
    let Some(natives) = Natives::from_env() else {
        return;
    };
    let cache = TempDir::new().expect("a cache folder");
    let engines = natives.engines(cache.path());

    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("a test runtime")
        .block_on(async {
            let manager = engines.manager();
            for (name, target) in [
                ("llama.cpp", natives.gguf_target()),
                ("LiteRT-LM", natives.litertlm_target()),
                ("llama.cpp again", natives.gguf_target()),
            ] {
                let text = load_answer_unload(manager, target).await;
                println!("{name}: {text:?}");
            }
        });
}

/// One turn of the lifecycle: load, a streamed reply that ends `Done`, unload.
async fn load_answer_unload(manager: &EngineManager, target: LoadTarget) -> String {
    within(
        manager
            .claim_load(target)
            .expect("nothing else is loading")
            .run(),
    )
    .await
    .expect("the model loads");
    let mut generation = within(manager.generate(question()))
        .await
        .expect("the gate is free");
    let mut text = String::new();
    let mut done = None;
    while let Some(event) = within(generation.next()).await.expect("the reply streams") {
        match event {
            EngineEvent::Text(piece) => text.push_str(&piece),
            EngineEvent::Done { reason, .. } => done = Some(reason),
            _ => {}
        }
    }
    within(manager.unload()).await.expect("the model unloads");

    assert!(!text.is_empty(), "the reply streamed no text");
    assert!(
        matches!(done, Some(FinishReason::Stop | FinishReason::Length)),
        "no Done: {done:?}"
    );
    text
}

async fn within<T>(step: impl Future<Output = T>) -> T {
    tokio::time::timeout(LIMIT, step)
        .await
        .expect("a native engine did not answer in time")
}

fn question() -> GenerateRequest {
    GenerateRequest {
        messages: vec![ChatMessage {
            role: Role::User,
            content: MessageContent::Text("Say hello.".to_owned()),
        }],
        params: GenerationParams {
            max_tokens: Some(REPLY_TOKENS),
            ..GenerationParams::default()
        },
    }
}

/// Both runtimes' libraries and models, as the environment names them.
struct Natives {
    llama_dir: PathBuf,
    gguf: PathBuf,
    litert_library: PathBuf,
    litertlm: PathBuf,
}

impl Natives {
    /// `None` when a variable is unset: the test skips, or fails on CI.
    fn from_env() -> Option<Natives> {
        let (Some(llama_dir), Some(gguf), Some(litert_library), Some(litertlm)) = (
            env_path("TURBOLLM_LLAMA_LIB_DIR").map(from_workspace_root),
            env_path("TURBOLLM_TEST_GGUF"),
            env_path("TURBOLLM_LITERT_LIB").map(from_workspace_root),
            env_path("TURBOLLM_TEST_LITERTLM"),
        ) else {
            let on_ci = std::env::var("CI").as_deref() == Ok("true");
            assert!(!on_ci, "{MISSING_ENV}: required on CI");
            println!("skipped: {MISSING_ENV}");
            return None;
        };
        Some(Natives {
            llama_dir,
            gguf,
            litert_library,
            litertlm,
        })
    }

    /// One handle whose only engines are the two native ones, both in-process on every host.
    fn engines(&self, cache_dir: &Path) -> Engines {
        let llama: Arc<dyn Engine> = Arc::new(InProcess::new(LlamaBackend::new(Some(
            self.llama_dir.clone(),
        ))));
        let library = self.litert_library.clone();
        let litert: Arc<dyn Engine> = Arc::new(InProcess::new(LiteRtBackend::over(move || {
            Ok(Arc::new(LiteRtApi::open(&library)?) as SharedCalls)
        })));
        let config = EnginesConfig {
            cache_dir: cache_dir.to_owned(),
            library_dir: None,
            journal_path: None,
            max_queued: MAX_QUEUED,
            stall: Duration::ZERO,
            forced_unavailable: BTreeMap::new(),
        };
        Engines::without_native(config, vec![llama, litert], None)
            .unwrap_or_else(|e: EngineError| panic!("the engines start: {e}"))
    }

    fn gguf_target(&self) -> LoadTarget {
        target(&self.gguf, ModelFormat::Gguf, EngineId::LLAMA_CPP_CPU)
    }

    fn litertlm_target(&self) -> LoadTarget {
        target(&self.litertlm, ModelFormat::Litertlm, EngineId::LITERT_LM)
    }
}

fn target(path: &Path, format: ModelFormat, engine: &str) -> LoadTarget {
    LoadTarget {
        model_ref: ModelRef::File(path.to_string_lossy().into_owned()),
        id: "two-runtimes".to_owned(),
        format,
        engine: EngineId::new(engine),
        path: path.to_owned(),
        context_size: Some(CONTEXT_SIZE),
        threads: None,
        backend: Backend::Cpu,
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Cargo runs tests from the crate folder; a relative path is meant from `core/`, where cargo is invoked.
fn from_workspace_root(path: PathBuf) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(path)
}
