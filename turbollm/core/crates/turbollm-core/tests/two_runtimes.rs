//! llama.cpp and LiteRT-LM in one process (plan P-5, arch R2a-7): one `Engines` loads the GGUF,
//! generates, unloads, then loads the `.litertlm`, generates, unloads, then the GGUF again. A test
//! binary cannot load an ASan-built library, so the two C++ runtimes meeting in one address space
//! is what is checked instead. Needs the four variables of the llama and LiteRT real-native tests
//! (`TURBOLLM_LLAMA_LIB_DIR`, `TURBOLLM_TEST_GGUF`, `TURBOLLM_LITERT_LIB`, `TURBOLLM_TEST_LITERTLM`);
//! without them the test skips, except on CI, where it fails.
//!
//! Both engines come from the core's own constructors (`LlamaBackend::new`, `LiteRtBackend::new`, the
//! ones the `llama` and `litert` features put in the catalogue), looking in a library folder. A desktop
//! core lists no native row (they are Android-only, ADR-239), so they are handed in as extra engines.

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
use turbollm_engine_litert::{LIBRARY_STEM, LiteRtBackend};
use turbollm_engine_llama::LlamaBackend;
use turbollm_platform::library_file_name;

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
    /// The folder `LiteRtBackend::new` looks in: the library under the name the AAR stages it by.
    litert_dir: TempDir,
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
            skip_unless_on_ci(std::env::var("CI").as_deref() == Ok("true"), MISSING_ENV);
            return None;
        };
        Some(Natives {
            llama_dir,
            gguf,
            litert_dir: stage_litert(&litert_library),
            litertlm,
        })
    }

    /// One handle whose only engines are the two native ones, both in-process on every host.
    fn engines(&self, cache_dir: &Path) -> Engines {
        let llama: Arc<dyn Engine> = Arc::new(InProcess::new(LlamaBackend::new(Some(
            self.llama_dir.clone(),
        ))));
        let litert: Arc<dyn Engine> = Arc::new(InProcess::new(LiteRtBackend::new(Some(
            self.litert_dir.path().to_owned(),
        ))));
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

/// The library in a folder of its own as `libturbollm_core_litertlm` (the host build is `litert-lm.dll`).
fn stage_litert(library: &Path) -> TempDir {
    let dir = TempDir::new().expect("a library folder");
    std::fs::copy(library, dir.path().join(library_file_name(LIBRARY_STEM)))
        .unwrap_or_else(|e| panic!("staging {}: {e}", library.display()));
    dir
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

/// The rule of every real-native test: a missing environment skips, except on CI, where it fails, so
/// the native tests can never pass vacuously there.
fn skip_unless_on_ci(on_ci: bool, reason: &str) {
    assert!(!on_ci, "{reason}: required on CI");
    println!("skipped: {reason}");
}

/// The rule's own check; its reason says so, so a CI log never reads it as a skipped native test.
const SELF_CHECK: &str = "two_runtimes self-check, no native test skipped";

#[test]
#[should_panic(expected = "two_runtimes self-check, no native test skipped: required on CI")]
fn a_missing_environment_fails_the_test_on_ci() {
    skip_unless_on_ci(true, SELF_CHECK);
}

#[test]
fn a_missing_environment_skips_the_test_off_ci() {
    skip_unless_on_ci(false, SELF_CHECK);
}
