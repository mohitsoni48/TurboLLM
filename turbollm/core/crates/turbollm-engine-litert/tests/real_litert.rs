//! The LiteRT-LM engine on the real 0.19.0 library and a real model, on the CPU, driven through
//! the manager as a host drives it (arch 9, "LiteRT-LM CPU: load a tiny `.litertlm`, stream,
//! thinking channel, cancel, close"). `TURBOLLM_LITERT_LIB` names the library
//! (`cargo xtask fetch-litert --host`) and `TURBOLLM_TEST_LITERTLM` a small model
//! (`core/fixtures/engines/README.md`). Without them the tests skip, except on CI, where they fail.

#[path = "support/native_env.rs"]
mod native_env;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use turbollm_engine::{
    Backend, Catalog, CatalogEntry, ChatMessage, Engine, EngineError, EngineEvent, EngineId,
    EngineManager, FinishReason, GenerateRequest, Generation, GenerationParams, InProcess,
    LoadTarget, LoadedModelInfo, ManagerConfig, MessageContent, ModelFormat, ModelRef,
    PlatformKind, PlatformKinds, Role,
};
use turbollm_engine_litert::api::LiteRtApi;
use turbollm_engine_litert::{LiteRtBackend, SharedCalls};
use turbollm_platform::HostFacts;

use native_env::{NativeTestEnv, take_turn};

/// A CPU load of a small model, and a reply on it, finish well inside this; a hang does not.
const LIMIT: Duration = Duration::from_secs(120);
const CONTEXT_SIZE: u32 = 2048;
const THREADS: u32 = 4;
const SHORT_REPLY: u32 = 24;
const LONG_REPLY: u32 = 512;
const RELOAD_CYCLES: usize = 3;
const MAX_QUEUED: usize = 8;
const LONG_STORY: &str = "Write a very long story about a fox.";

#[test]
fn a_tiny_litertlm_loads_and_streams_prefilled_then_text_then_done() {
    on_the_real_library(|host| async move {
        let manager = host.manager();

        let loaded = host.load(&manager).await.expect("the model loads");
        let reply = Reply::to(&manager, chat("Say hello.", capped(SHORT_REPLY))).await;

        assert_eq!(loaded.info.backend, Backend::Cpu);
        assert_eq!(loaded.info.context_size, CONTEXT_SIZE);
        reply.assert_streamed_in_order();
        assert!(!reply.text().is_empty(), "the reply streamed no text");
        println!("streamed: {:?}", reply.text());
        println!("ending: {:?}", reply.events.last());
    });
}

#[test]
fn a_reply_reports_the_benchmark_read_after_its_final_chunk() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager).await.expect("the model loads");

        let reply = Reply::to(&manager, chat("Name three colours.", capped(SHORT_REPLY))).await;

        let Some(EngineEvent::Done {
            prompt_tokens,
            completion_tokens,
            gen_ms,
            ..
        }) = reply.events.last()
        else {
            panic!("no Done event: {:?}", reply.events);
        };
        assert!(*prompt_tokens > 0, "the benchmark counted no prompt tokens");
        assert!(
            *completion_tokens > 0,
            "the benchmark counted no completion tokens"
        );
        assert!(*gen_ms > 0.0, "no generation time");
    });
}

#[test]
fn a_reply_with_thinking_streams_reasoning_apart_from_text() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager).await.expect("the model loads");
        let params = GenerationParams {
            enable_thinking: true,
            ..capped(LONG_REPLY)
        };

        let reply = Reply::to(&manager, chat("What is 12 times 7?", params)).await;

        reply.assert_streamed_in_order();
        println!("reasoning: {:?}", reply.reasoning());
        println!("text: {:?}", reply.text());
        assert!(
            !reply.reasoning().is_empty(),
            "a thinking request streamed no reasoning"
        );
    });
}

#[test]
fn a_reply_without_thinking_streams_no_reasoning() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager).await.expect("the model loads");

        let reply = Reply::to(&manager, chat("What is 12 times 7?", capped(LONG_REPLY))).await;

        reply.assert_streamed_in_order();
        assert!(reply.reasoning().is_empty(), "{:?}", reply.reasoning());
    });
}

#[test]
fn a_cancel_mid_stream_ends_the_reply_cancelled_and_leaves_the_engine_usable() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager).await.expect("the model loads");
        let mut generation = manager
            .generate(chat(LONG_STORY, capped(LONG_REPLY)))
            .await
            .expect("the gate is free");
        let first = within(generation.next()).await;
        assert!(matches!(first, Ok(Some(_))), "first event {first:?}");

        generation.cancel();
        let cancelled = Reply::read(generation).await;
        let next = Reply::to(&manager, chat("Hi.", capped(4))).await;

        assert!(
            matches!(cancelled.ending, Err(EngineError::Cancelled(_))),
            "{:?}",
            cancelled.ending
        );
        next.assert_streamed_in_order();
    });
}

#[test]
fn a_cancel_before_any_chunk_ends_the_reply_cancelled() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager).await.expect("the model loads");
        let generation = manager
            .generate(chat(LONG_STORY, capped(LONG_REPLY)))
            .await
            .expect("the gate is free");

        generation.cancel();
        let cancelled = Reply::read(generation).await;
        let next = Reply::to(&manager, chat("Hi.", capped(4))).await;

        assert!(
            matches!(cancelled.ending, Err(EngineError::Cancelled(_))),
            "{:?}",
            cancelled.ending
        );
        next.assert_streamed_in_order();
    });
}

#[test]
fn consecutive_replies_each_run_in_their_own_conversation() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager).await.expect("the model loads");

        for question in ["Say hi.", "Say bye.", "Say ok."] {
            Reply::to(&manager, chat(question, capped(SHORT_REPLY)))
                .await
                .assert_streamed_in_order();
        }
    });
}

#[test]
fn a_cache_folder_that_does_not_exist_yet_is_created_by_the_load() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        assert!(!host.cache_dir().exists());

        host.load(&manager)
            .await
            .expect("the model loads with a missing cache folder");

        assert!(host.cache_dir().is_dir());
    });
}

#[test]
fn a_model_that_is_not_there_fails_to_load() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        let missing = LoadTarget {
            path: host.model.with_file_name("no-such-model.litertlm"),
            ..host.target()
        };

        let failure = within(manager.claim_load(missing).expect("free").run()).await;

        match failure {
            Err(EngineError::ModelLoadFailed(reason)) => {
                assert!(reason.starts_with("LiteRT-LM could not load the model: "));
                println!("load failure: {reason}");
            }
            other => panic!("expected ModelLoadFailed, got {other:?}"),
        }
    });
}

#[test]
fn load_chat_unload_cycles_run_clean() {
    on_the_real_library(|host| async move {
        let manager = host.manager();

        for cycle in 1..=RELOAD_CYCLES {
            host.load(&manager)
                .await
                .unwrap_or_else(|e| panic!("cycle {cycle}: {e}"));
            Reply::to(&manager, chat("Hi.", capped(4)))
                .await
                .assert_streamed_in_order();
            within(manager.unload()).await.expect("the model unloads");
        }
    });
}

/// Runs `test` on a single-threaded runtime with the host library, once it is this test's turn.
fn on_the_real_library<F, Fut>(test: F)
where
    F: FnOnce(Host) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(host) = Host::from_env() else { return };
    let _turn = take_turn();
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("a test runtime")
        .block_on(test(host));
}

/// Fails a step that takes longer than `LIMIT`, so a hung library fails the test instead of the run.
async fn within<T>(step: impl Future<Output = T>) -> T {
    tokio::time::timeout(LIMIT, step)
        .await
        .expect("the real library did not answer in time")
}

/// The host library and the model the environment names.
struct Host {
    cache: TempDir,
    library: PathBuf,
    model: PathBuf,
}

impl Host {
    fn from_env() -> Option<Host> {
        let NativeTestEnv { library, model } = NativeTestEnv::read()?;
        Some(Host {
            cache: TempDir::new().expect("a cache folder"),
            library,
            model,
        })
    }

    /// A folder that is not there yet: the library needs its cache folder to exist, so a load that
    /// is handed a missing one has to make it.
    fn cache_dir(&self) -> PathBuf {
        self.cache.path().join("litert-cache")
    }

    fn manager(&self) -> EngineManager {
        let library = self.library.clone();
        let engine: Arc<dyn Engine> = Arc::new(InProcess::new(LiteRtBackend::over(move || {
            Ok(Arc::new(LiteRtApi::open(&library)?) as SharedCalls)
        })));
        let entry = CatalogEntry {
            descriptor: engine.descriptor().clone(),
            per_platform: in_process_everywhere(),
            engine,
        };
        EngineManager::new(ManagerConfig {
            catalog: Catalog::new(HostFacts::detect()).with_entry(entry),
            journal: None,
            predecessor: None,
            stall: Duration::ZERO,
            max_queued: MAX_QUEUED,
            cache_dir: self.cache_dir(),
        })
    }

    async fn load(&self, manager: &EngineManager) -> Result<LoadedModelInfo, EngineError> {
        within(
            manager
                .claim_load(self.target())
                .expect("nothing else is loading")
                .run(),
        )
        .await
    }

    fn target(&self) -> LoadTarget {
        LoadTarget {
            model_ref: ModelRef::File(self.model.to_string_lossy().into_owned()),
            id: "test-litertlm".to_owned(),
            format: ModelFormat::Litertlm,
            engine: EngineId::new(EngineId::LITERT_LM),
            path: self.model.clone(),
            context_size: Some(CONTEXT_SIZE),
            threads: Some(THREADS),
            backend: Backend::Cpu,
        }
    }
}

fn in_process_everywhere() -> PlatformKinds {
    PlatformKinds {
        android: PlatformKind::InProcess,
        ios: PlatformKind::InProcess,
        linux: PlatformKind::InProcess,
        windows: PlatformKind::InProcess,
        mac_os: PlatformKind::InProcess,
    }
}

/// Everything one generation streamed, and how it ended.
struct Reply {
    events: Vec<EngineEvent>,
    ending: Result<(), EngineError>,
}

impl Reply {
    async fn to(manager: &EngineManager, request: GenerateRequest) -> Reply {
        match within(manager.generate(request)).await {
            Ok(generation) => Reply::read(generation).await,
            Err(refused) => Reply {
                events: Vec::new(),
                ending: Err(refused),
            },
        }
    }

    async fn read(mut generation: Generation) -> Reply {
        let mut events = Vec::new();
        loop {
            match within(generation.next()).await {
                Ok(Some(event)) => events.push(event),
                Ok(None) => {
                    return Reply {
                        events,
                        ending: Ok(()),
                    };
                }
                Err(failure) => {
                    return Reply {
                        events,
                        ending: Err(failure),
                    };
                }
            }
        }
    }

    /// `Prefilled` first, then text and reasoning, then `Done` with a reason.
    fn assert_streamed_in_order(&self) {
        assert!(self.ending.is_ok(), "the reply failed: {:?}", self.ending);
        let [first, middle @ .., last] = self.events.as_slice() else {
            panic!("too few events: {:?}", self.events);
        };
        assert!(
            matches!(first, EngineEvent::Prefilled { .. }),
            "first event {first:?}"
        );
        assert!(
            middle
                .iter()
                .all(|event| matches!(event, EngineEvent::Text(_) | EngineEvent::Reasoning(_))),
            "between Prefilled and Done: {middle:?}"
        );
        assert!(
            matches!(
                last,
                EngineEvent::Done {
                    reason: FinishReason::Stop | FinishReason::Length,
                    ..
                }
            ),
            "last event {last:?}"
        );
    }

    fn text(&self) -> String {
        self.joined(|event| match event {
            EngineEvent::Text(text) => Some(text),
            _ => None,
        })
    }

    fn reasoning(&self) -> String {
        self.joined(|event| match event {
            EngineEvent::Reasoning(text) => Some(text),
            _ => None,
        })
    }

    fn joined<'a>(&'a self, pick: impl Fn(&'a EngineEvent) -> Option<&'a String>) -> String {
        self.events
            .iter()
            .filter_map(pick)
            .map(String::as_str)
            .collect()
    }
}

fn chat(text: &str, params: GenerationParams) -> GenerateRequest {
    GenerateRequest {
        messages: vec![ChatMessage {
            role: Role::User,
            content: MessageContent::Text(text.to_owned()),
        }],
        params,
    }
}

fn capped(max_tokens: u32) -> GenerationParams {
    GenerationParams {
        max_tokens: Some(max_tokens),
        ..GenerationParams::default()
    }
}
