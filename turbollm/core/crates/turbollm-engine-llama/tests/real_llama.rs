//! The llama engine on the real session library and a real model, driven through the manager and
//! the in-process engine as a host drives it (arch 9, "Rust integration, real natives").
//! Needs a host build (`cargo xtask build-llama --host`): `TURBOLLM_LLAMA_LIB_DIR` names its folder
//! and `TURBOLLM_TEST_GGUF` a small model (`core/fixtures/engines/README.md`). Without them the
//! tests skip, except on CI, where they fail.

#[path = "support/llama_manager.rs"]
mod llama_manager;
#[path = "support/native_host.rs"]
mod native_host;

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use libloading::Library;
use turbollm_engine::{
    Backend, ChatMessage, EngineError, EngineEvent, EngineId, EngineManager, FinishReason,
    GenerateRequest, Generation, GenerationParams, LoadTarget, LoadedModelInfo, MessageContent,
    ModelFormat, ModelRef, Role,
};
use turbollm_engine_llama::api::{
    Delta, LlamaApi, LlamaCalls, LoadRequest, ModelInfo, ProgressFn, Sampling, Session, Stats,
    Token,
};
use turbollm_engine_llama::variant::{self, Variant};
use turbollm_engine_llama::{LlamaBackend, LoadedLibrary};
use turbollm_platform::library_file_name;

use llama_manager::manager_over;
use native_host::{NativeTestEnv, take_turn};

const LOAD_STALL: Duration = Duration::from_secs(120);
const SHORT_STALL: Duration = Duration::from_secs(1);
/// Longer than `SHORT_STALL`, so a load whose progress goes quiet this long is a stalled load.
const PROGRESS_SILENCE: Duration = Duration::from_secs(3);
const STALLED_LOAD: &str = "llama.cpp could not load the model: no load progress for 1 s";
const CANCEL_AFTER: Duration = Duration::from_millis(200);
const ABORT_LIMIT: Duration = Duration::from_secs(1);
const UNLOAD_LIMIT: Duration = Duration::from_secs(5);
const LOAD_UNLOAD_CYCLES: usize = 20;
const SMALL_CONTEXT: u32 = 512;
const GREEDY_PROMPT: &str = "Name three colours.";
const GREEDY_SEED: i64 = 42;
const GREEDY_MAX_TOKENS: u32 = 48;
/// About 3,000 tokens (QA E-23): far beyond `SMALL_CONTEXT`, and a prefill that outlasts `CANCEL_AFTER`.
const LONG_PROMPT_SENTENCES: usize = 300;

#[test]
fn a_tiny_gguf_loads_and_streams_prefilled_then_text_then_done() {
    on_the_real_library(|host| async move {
        let manager = host.manager();

        let loaded = host.load(&manager, None).await.expect("the model loads");
        let reply = Reply::to(&manager, chat("Say hello.", capped(16))).await;

        assert_eq!(loaded.info.context_size, 4096);
        assert_eq!(loaded.info.trained_context, Some(40_960));
        reply.assert_streamed_in_order();
        assert!(!reply.text().is_empty(), "the reply streamed no text");
        println!("streamed: {:?}", reply.text());
    });
}

/// Each run gets a fresh load: on one session the second run reuses the first one's cached prompt
/// and decodes only its last token, and llama.cpp's CPU sums for a one-token batch can differ from
/// a whole-prompt batch enough to flip a near-tie (the session's prefill cache, kept as it was).
#[test]
fn two_greedy_runs_of_one_prompt_on_fresh_loads_give_identical_text() {
    on_the_real_library(|host| async move {
        let manager = host.manager();

        let first = host.greedy_reply_on_a_fresh_load(&manager).await;
        let second = host.greedy_reply_on_a_fresh_load(&manager).await;

        first.assert_streamed_in_order();
        assert_eq!(first.pieces(), second.pieces());
        println!("greedy: {:?}", first.text());
    });
}

#[test]
fn a_cancel_during_prefill_stops_the_native_work_within_a_second() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager, None).await.expect("the model loads");
        let generation = manager
            .generate(chat(&long_prompt(), capped(16)))
            .await
            .expect("the gate is free");
        tokio::time::sleep(CANCEL_AFTER).await;

        let cancelled_at = Instant::now();
        generation.cancel();
        let cancelled = Reply::read(generation).await;
        let next = Reply::to(&manager, chat("Hi.", capped(1))).await;
        let latency = cancelled_at.elapsed();

        assert!(
            matches!(cancelled.ending, Err(EngineError::Cancelled(_))),
            "{:?}",
            cancelled.ending
        );
        assert!(
            !cancelled.has_prefilled(),
            "the prefill ended before the cancel: the prompt is too short to test an abort"
        );
        next.assert_streamed_in_order();
        assert!(
            latency < ABORT_LIMIT,
            "the engine was busy {latency:?} after the cancel"
        );
        println!("abort latency: {latency:?}");
    });
}

#[test]
fn a_prompt_longer_than_the_context_is_context_length_exceeded() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager, Some(SMALL_CONTEXT))
            .await
            .expect("the model loads");

        let reply = Reply::to(&manager, chat(&long_prompt(), capped(16))).await;

        match reply.ending {
            Err(EngineError::ContextLengthExceeded(reason)) => {
                assert!(!reason.is_empty(), "the failure carries no native reason");
                println!("context exceeded: {reason}");
            }
            other => panic!("expected ContextLengthExceeded, got {other:?}"),
        }
    });
}

#[test]
fn unloading_frees_the_native_session() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager, None).await.expect("the model loads");
        assert_eq!(host.live_sessions(), 1);

        manager.unload().await.expect("the model unloads");

        assert_eq!(host.live_sessions(), 0);
    });
}

#[test]
fn unloading_during_a_prefill_aborts_it_and_frees_the_session_without_a_crash() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager, None).await.expect("the model loads");
        let generation = manager
            .generate(chat(&long_prompt(), capped(16)))
            .await
            .expect("the gate is free");
        tokio::time::sleep(CANCEL_AFTER).await;

        let unload_ms = time_to_unload(&manager).await;
        let reply = Reply::read(generation).await;

        assert_eq!(host.live_sessions(), 0, "the session outlived the unload");
        assert!(reply.ending.is_err(), "the prefill ended normally");
        assert!(
            !reply.has_prefilled(),
            "the prefill ended before the unload"
        );
        assert!(unload_ms < UNLOAD_LIMIT, "the unload took {unload_ms:?}");
        manager
            .unload()
            .await
            .expect("a second unload of an empty engine is fine");
    });
}

#[test]
fn unloading_while_tokens_are_generated_ends_the_reply_and_frees_the_session() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        host.load(&manager, None).await.expect("the model loads");
        let mut generation = manager
            .generate(chat("Count to one thousand.", capped(1024)))
            .await
            .expect("the gate is free");
        let first = generation.next().await;
        assert!(
            matches!(first, Ok(Some(EngineEvent::Prefilled { .. }))),
            "{first:?}"
        );
        tokio::time::sleep(CANCEL_AFTER).await;

        let unload_ms = time_to_unload(&manager).await;
        let reply = Reply::read(generation).await;

        assert_eq!(host.live_sessions(), 0, "the session outlived the unload");
        assert!(reply.ending.is_err(), "the reply ended normally");
        assert!(unload_ms < UNLOAD_LIMIT, "the unload took {unload_ms:?}");
    });
}

#[test]
fn a_model_that_does_not_exist_gives_no_session_and_says_why() {
    on_the_real_library(|host| async move {
        let manager = host.manager();
        let missing = host.model.with_file_name("no-such-model.gguf");

        let failure = host
            .load_target(&manager, host.target_at(&missing, None))
            .await
            .err();

        let Some(EngineError::ModelLoadFailed(reason)) = failure else {
            panic!("expected ModelLoadFailed, got {failure:?}");
        };
        assert!(reason.contains("no-such-model.gguf"), "{reason}");
        assert_eq!(host.live_sessions(), 0);
    });
}

#[test]
fn twenty_load_chat_unload_cycles_leave_no_session_behind() {
    on_the_real_library(|host| async move {
        let manager = host.manager();

        for cycle in 1..=LOAD_UNLOAD_CYCLES {
            host.load(&manager, Some(SMALL_CONTEXT))
                .await
                .unwrap_or_else(|e| panic!("cycle {cycle}: {e}"));
            Reply::to(&manager, chat("Hi.", capped(4)))
                .await
                .assert_streamed_in_order();
            manager.unload().await.expect("the model unloads");

            assert_eq!(host.live_sessions(), 0, "cycle {cycle} left a session");
        }
    });
}

#[test]
fn a_load_whose_progress_goes_quiet_is_stopped_by_the_stall_watch() {
    on_the_real_library(|host| async move {
        let manager = manager_with_stall(host.backend_whose_progress_goes_quiet(), SHORT_STALL);

        let failure = host.load(&manager, None).await.err();

        assert_eq!(
            failure,
            Some(EngineError::ModelLoadFailed(STALLED_LOAD.to_owned()))
        );
        assert_eq!(host.live_sessions(), 0);
        manager
            .claim_load(host.target(None))
            .expect("the stalled load released the lifecycle")
            .abandon();
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

/// The host build and the model the environment names, and a handle on the library's test probe.
struct Host {
    library_dir: PathBuf,
    model: PathBuf,
    probe: Library,
}

impl Host {
    fn from_env() -> Option<Host> {
        let NativeTestEnv { library_dir, model } = NativeTestEnv::read()?;
        let probe = open_base_library(&library_dir);
        Some(Host {
            library_dir,
            model,
            probe,
        })
    }

    fn manager(&self) -> EngineManager {
        manager_with_stall(
            LlamaBackend::new(Some(self.library_dir.clone())),
            LOAD_STALL,
        )
    }

    /// The real library, with every load progress report after the first held back.
    fn backend_whose_progress_goes_quiet(&self) -> LlamaBackend {
        let library_dir = self.library_dir.clone();
        LlamaBackend::over(move || {
            let chosen = variant::load_best(Some(&library_dir))?;
            let calls = QuietAfterFirstProgress {
                library: LlamaApi::resolve(chosen.library)?,
            };
            Ok(LoadedLibrary {
                calls: Arc::new(calls),
                file: chosen.file,
            })
        })
    }

    async fn load(
        &self,
        manager: &EngineManager,
        context_size: Option<u32>,
    ) -> Result<LoadedModelInfo, EngineError> {
        self.load_target(manager, self.target(context_size)).await
    }

    async fn load_target(
        &self,
        manager: &EngineManager,
        target: LoadTarget,
    ) -> Result<LoadedModelInfo, EngineError> {
        manager
            .claim_load(target)
            .expect("nothing else is loading")
            .run()
            .await
    }

    async fn greedy_reply_on_a_fresh_load(&self, manager: &EngineManager) -> Reply {
        self.load(manager, None).await.expect("the model loads");
        let reply = Reply::to(manager, chat(GREEDY_PROMPT, greedy())).await;
        manager.unload().await.expect("the model unloads");
        reply
    }

    fn target(&self, context_size: Option<u32>) -> LoadTarget {
        self.target_at(&self.model, context_size)
    }

    fn target_at(&self, model: &Path, context_size: Option<u32>) -> LoadTarget {
        LoadTarget {
            model_ref: ModelRef::File(model.to_string_lossy().into_owned()),
            id: "test-gguf".to_owned(),
            format: ModelFormat::Gguf,
            engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
            path: model.to_path_buf(),
            context_size,
            threads: None,
            backend: Backend::Auto,
        }
    }

    /// `tl_llama_live_sessions`, the test probe the host build exports.
    fn live_sessions(&self) -> i32 {
        type LiveSessionsFn = unsafe extern "C" fn() -> i32;
        // SAFETY: the signature is the header's `int32_t tl_llama_live_sessions(void)`.
        unsafe {
            let live_sessions = self
                .probe
                .get::<LiveSessionsFn>(b"tl_llama_live_sessions")
                .expect("the host build exports its test probe");
            live_sessions()
        }
    }
}

/// The same file the backend opens; the loader hands both the one instance of the library.
fn open_base_library(library_dir: &Path) -> Library {
    let path = library_dir.join(library_file_name(Variant::Base.library_stem()));
    // SAFETY: the library is ours; its initialisers only set up llama.cpp's static state.
    unsafe { Library::new(&path) }.unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

async fn time_to_unload(manager: &EngineManager) -> Duration {
    let started = Instant::now();
    manager.unload().await.expect("the model unloads");
    started.elapsed()
}

fn manager_with_stall(backend: LlamaBackend, stall: Duration) -> EngineManager {
    manager_over(backend, stall, std::env::temp_dir())
}

/// Everything one generation streamed, and how it ended.
struct Reply {
    events: Vec<EngineEvent>,
    ending: Result<(), EngineError>,
}

impl Reply {
    async fn to(manager: &EngineManager, request: GenerateRequest) -> Reply {
        match manager.generate(request).await {
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
            match generation.next().await {
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

    /// `Prefilled` first, then text and reasoning, then `Done` with a reason and the token counts.
    fn assert_streamed_in_order(&self) {
        assert!(self.ending.is_ok(), "the reply failed: {:?}", self.ending);
        let [first, middle @ .., last] = self.events.as_slice() else {
            panic!("too few events: {:?}", self.events);
        };
        assert!(
            matches!(first, EngineEvent::Prefilled { prompt_tokens, .. } if *prompt_tokens > 0),
            "first event {first:?}"
        );
        assert!(
            middle.iter().all(is_piece),
            "between Prefilled and Done: {middle:?}"
        );
        assert!(
            matches!(
                last,
                EngineEvent::Done { reason: FinishReason::Stop | FinishReason::Length, completion_tokens, .. }
                    if *completion_tokens > 0
            ),
            "last event {last:?}"
        );
    }

    fn pieces(&self) -> Vec<&EngineEvent> {
        self.events.iter().filter(|event| is_piece(event)).collect()
    }

    fn text(&self) -> String {
        self.events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn has_prefilled(&self) -> bool {
        self.events
            .iter()
            .any(|event| matches!(event, EngineEvent::Prefilled { .. }))
    }
}

fn is_piece(event: &EngineEvent) -> bool {
    matches!(event, EngineEvent::Text(_) | EngineEvent::Reasoning(_))
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

/// The determinism rule of arch 9: temperature 0, a fixed seed, the same model file.
fn greedy() -> GenerationParams {
    GenerationParams {
        temperature: Some(0.0),
        seed: Some(GREEDY_SEED),
        ..capped(GREEDY_MAX_TOKENS)
    }
}

fn long_prompt() -> String {
    "The quick brown fox jumps over the lazy dog. ".repeat(LONG_PROMPT_SENTENCES)
}

/// The real table, except that a load reports its first progress and then goes quiet for
/// `PROGRESS_SILENCE` before its second: a load the stall watch must stop (QA E-4). Only one report
/// is held back, so a load the watch fails to stop completes instead of crawling.
struct QuietAfterFirstProgress {
    library: LlamaApi,
}

/// What the quiet progress callback forwards to, and how many reports it has seen.
struct HeldBackProgress {
    forward: ProgressFn,
    forward_data: *mut c_void,
    reports: AtomicU32,
}

unsafe extern "C" fn hold_back_progress(progress: f32, data: *mut c_void) -> bool {
    // SAFETY: `data` is the `HeldBackProgress` that `load` keeps alive until the load returns.
    let held = unsafe { &*data.cast::<HeldBackProgress>() };
    if held.reports.fetch_add(1, Ordering::SeqCst) == 1 {
        std::thread::sleep(PROGRESS_SILENCE);
    }
    // SAFETY: the engine's own callback with the data it passed for this load.
    unsafe { (held.forward)(progress, held.forward_data) }
}

impl LlamaCalls for QuietAfterFirstProgress {
    fn backend_init(&self) {
        self.library.backend_init();
    }

    unsafe fn load(&self, request: &LoadRequest<'_>) -> Result<Session, String> {
        let forward = request.progress.expect("the engine reports load progress");
        let held = HeldBackProgress {
            forward,
            forward_data: request.progress_data,
            reports: AtomicU32::new(0),
        };
        let quiet = LoadRequest {
            progress: Some(hold_back_progress),
            progress_data: std::ptr::from_ref(&held).cast_mut().cast::<c_void>(),
            ..*request
        };
        // SAFETY: `held` outlives the load; everything else is the caller's request.
        unsafe { self.library.load(&quiet) }
    }

    fn model_info(&self, session: &Session) -> ModelInfo {
        self.library.model_info(session)
    }

    fn prepare(&self, session: &mut Session, request_json: &str) -> i32 {
        self.library.prepare(session, request_json)
    }

    fn start_sampling(&self, session: &mut Session, sampling: &Sampling) -> i32 {
        self.library.start_sampling(session, sampling)
    }

    fn next_token(&self, session: &mut Session) -> Token {
        self.library.next_token(session)
    }

    fn parse_delta(&self, session: &mut Session, is_partial: bool) -> Delta {
        self.library.parse_delta(session, is_partial)
    }

    fn stats(&self, session: &Session) -> Stats {
        self.library.stats(session)
    }

    fn last_error(&self, session: &Session) -> String {
        self.library.last_error(session)
    }

    fn free(&self, session: Session) {
        self.library.free(session);
    }
}
