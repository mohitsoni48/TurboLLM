//! The engine manager over `ScriptedBackend` engines: every `EngineHostTest.kt` and `FakeEngineTest.kt`
//! case, one for one, plus arch 9's manager list, E-4 and E-6, and PG-4.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::{Pin, pin};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::task::JoinHandle;
use turbollm_engine::testing::{FakeClock, ScriptRecord, ScriptedBackend, Step};
use turbollm_engine::{
    Availability, Backend, Catalog, CatalogEntry, ChatMessage, Engine, EngineDescriptor,
    EngineError, EngineEvent, EngineId, EngineKind, EngineManager, EngineState, FinishReason,
    GenerateRequest, GenerationParams, InProcess, InvalidReason, LoadClaim, LoadJournal, LoadSpec,
    LoadTarget, LoadedModelInfo, MODEL_NOT_LOADED, MODEL_UNLOADED, ManagerConfig, MessageContent,
    ModelFormat, ModelInfo, ModelRef, PlatformKind, PlatformKinds, REPLY_CANCELLED, Role,
};
use turbollm_platform::HostFacts;

const WAIT_LIMIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(5);
const LONG: Duration = Duration::from_secs(3600);
const SDK_QUEUE: usize = 8;
const SDK_STALL: Duration = Duration::from_secs(120);
const OTHER_GGUF_ENGINE: &str = "other-gguf";
/// Long enough for a spawned unload or shutdown to be inside its model close.
const UNDERWAY: Duration = Duration::from_millis(50);
/// How soon a cancel must end a native call that waits on its consumer (QA E-26).
const CANCEL_LIMIT: Duration = Duration::from_secs(1);
/// Unread events a reply holds before the engine waits for its consumer (`sink.rs` `EVENT_BUFFER`).
const REPLY_BUFFER: usize = 32;

struct Fixture {
    manager: EngineManager,
    records: Vec<Arc<ScriptRecord>>,
    dir: TempDir,
}

impl Fixture {
    fn record(&self) -> &ScriptRecord {
        &self.records[0]
    }

    fn journal_file(&self) -> PathBuf {
        LoadJournal::path_in(self.dir.path())
    }

    fn target(&self, id: &str) -> LoadTarget {
        target_in(self.dir.path(), id, EngineId::LLAMA_CPP_CPU)
    }

    fn target_on(&self, id: &str, engine: &str) -> LoadTarget {
        target_in(self.dir.path(), id, engine)
    }

    fn claim(&self, id: &str) -> LoadClaim {
        self.manager.claim_load(self.target(id)).expect("claim")
    }

    async fn load(&self, id: &str) -> LoadedModelInfo {
        self.claim(id).run().await.expect("load")
    }

    fn state(&self) -> EngineState {
        self.manager.snapshot().state
    }
}

struct Setup {
    backends: Vec<ScriptedBackend>,
    max_queued: usize,
    predecessor: Option<EngineManager>,
}

impl Setup {
    fn of(backend: ScriptedBackend) -> Setup {
        Setup::of_all(vec![backend])
    }

    fn of_all(backends: Vec<ScriptedBackend>) -> Setup {
        Setup {
            backends,
            max_queued: SDK_QUEUE,
            predecessor: None,
        }
    }

    fn max_queued(mut self, max_queued: usize) -> Setup {
        self.max_queued = max_queued;
        self
    }

    fn after(mut self, predecessor: &EngineManager) -> Setup {
        self.predecessor = Some(predecessor.clone());
        self
    }

    fn build(self) -> Fixture {
        let dir = TempDir::new().unwrap();
        let records = self.backends.iter().map(ScriptedBackend::record).collect();
        let catalog = self
            .backends
            .into_iter()
            .fold(Catalog::new(HostFacts::detect()), |catalog, backend| {
                catalog.with_entry(entry_of(backend))
            });
        let manager = EngineManager::new(ManagerConfig {
            catalog,
            journal: Some(LoadJournal::new(LoadJournal::path_in(dir.path()), "core-a")),
            predecessor: self.predecessor,
            stall: SDK_STALL,
            max_queued: self.max_queued,
            cache_dir: dir.path().join("cache"),
        });
        Fixture {
            manager,
            records,
            dir,
        }
    }
}

fn fixture(backend: ScriptedBackend) -> Fixture {
    Setup::of(backend).build()
}

fn entry_of(backend: ScriptedBackend) -> CatalogEntry {
    let engine: Arc<dyn Engine> = Arc::new(InProcess::new(backend));
    CatalogEntry {
        descriptor: engine.descriptor().clone(),
        per_platform: in_process_everywhere(),
        engine,
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

fn descriptor(id: &str, kind: EngineKind, format: ModelFormat) -> EngineDescriptor {
    EngineDescriptor {
        id: EngineId::new(id),
        name: id.to_owned(),
        kind,
        formats: vec![format],
        backends: vec![Backend::Cpu],
    }
}

fn target_in(root: &Path, id: &str, engine: &str) -> LoadTarget {
    LoadTarget {
        model_ref: ModelRef::Installed(id.to_owned()),
        id: id.to_owned(),
        format: ModelFormat::Gguf,
        engine: EngineId::new(engine),
        path: root.join(format!("{id}.gguf")),
        context_size: None,
        threads: None,
        backend: Backend::Auto,
    }
}

fn installed(id: &str) -> ModelRef {
    ModelRef::Installed(id.to_owned())
}

fn scripted_info() -> ModelInfo {
    ModelInfo {
        context_size: 4096,
        trained_context: Some(4096),
        backend: Backend::Cpu,
        notes: Vec::new(),
    }
}

fn request() -> GenerateRequest {
    GenerateRequest {
        messages: vec![ChatMessage {
            role: Role::User,
            content: MessageContent::Text("hi".to_owned()),
        }],
        params: GenerationParams::default(),
    }
}

fn done() -> EngineEvent {
    EngineEvent::Done {
        reason: FinishReason::Stop,
        prompt_tokens: 4,
        completion_tokens: 2,
        prompt_ms: 10.0,
        gen_ms: 20.0,
    }
}

fn model_load_failed(text: &str) -> EngineError {
    EngineError::ModelLoadFailed(text.to_owned())
}

fn refusal<T>(outcome: Result<T, EngineError>) -> EngineError {
    match outcome {
        Ok(_) => panic!("expected a refusal"),
        Err(error) => error,
    }
}

fn unloaded_cancel() -> EngineError {
    EngineError::Cancelled(MODEL_UNLOADED.to_owned())
}

async fn eventually(what: &str, condition: impl Fn() -> bool) {
    eventually_within(WAIT_LIMIT, what, condition).await;
}

async fn eventually_within(limit: Duration, what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + limit;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(POLL).await;
    }
}

/// The next claim, once the lifecycle is free again.
async fn claim_once_free(f: &Fixture, id: &str) -> LoadClaim {
    let deadline = Instant::now() + WAIT_LIMIT;
    loop {
        match f.manager.claim_load(f.target(id)) {
            Ok(claim) => return claim,
            Err(EngineError::LoadInProgress) => {
                assert!(Instant::now() < deadline, "the lifecycle stayed held");
                tokio::time::sleep(POLL).await;
            }
            Err(other) => panic!("claim refused: {other:?}"),
        }
    }
}

/// Polls `future` once, leaving it suspended where it waits.
fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

fn has(record: &ScriptRecord, entry: &str) -> bool {
    record.history().iter().any(|seen| seen == entry)
}

fn native_calls(record: &ScriptRecord) -> usize {
    record
        .history()
        .iter()
        .filter(|seen| *seen == "generate")
        .count()
}

fn texts(count: usize) -> Vec<Step> {
    (0..count)
        .map(|n| Step::Emit(EngineEvent::Text(n.to_string())))
        .collect()
}

fn is_ready(state: &EngineState) -> bool {
    matches!(state, EngineState::Ready { .. })
}

fn ready_id(state: &EngineState) -> String {
    match state {
        EngineState::Ready { model, .. } => model.id.clone(),
        other => panic!("not ready: {other:?}"),
    }
}

fn occupancy(state: &EngineState) -> (bool, usize) {
    match state {
        EngineState::Ready { busy, queued, .. } => (*busy, *queued),
        other => panic!("not ready: {other:?}"),
    }
}

/// Every event up to the reply's end, or the failure it ended with.
async fn read_to_end(
    generation: &mut turbollm_engine::Generation,
) -> Result<Vec<EngineEvent>, EngineError> {
    let mut events = Vec::new();
    while let Some(event) = generation.next().await? {
        events.push(event);
    }
    Ok(events)
}

async fn collect(generation: &mut turbollm_engine::Generation) -> Vec<EngineEvent> {
    let mut events = Vec::new();
    while let Some(event) = generation.next().await.expect("event") {
        events.push(event);
    }
    events
}

/// Every snapshot a manager publishes, as long as the recorder keeps up (checked by revisions).
struct StateRecorder {
    seen: Arc<Mutex<Vec<(u64, EngineState)>>>,
    task: JoinHandle<()>,
}

impl StateRecorder {
    fn start(manager: &EngineManager) -> StateRecorder {
        let seen = Arc::new(Mutex::new(vec![{
            let first = manager.snapshot();
            (first.revision, first.state)
        }]));
        let manager = manager.clone();
        let recorded = Arc::clone(&seen);
        let task = tokio::spawn(async move {
            loop {
                let last = recorded.lock().unwrap().last().unwrap().0;
                let next = manager.next_snapshot(last).await;
                recorded.lock().unwrap().push((next.revision, next.state));
            }
        });
        StateRecorder { seen, task }
    }

    /// The states seen once the recorder caught up; panics when it missed one.
    async fn states(self, manager: &EngineManager) -> Vec<EngineState> {
        let latest = manager.snapshot().revision;
        let seen = Arc::clone(&self.seen);
        eventually("the recorder to catch up", || {
            seen.lock().unwrap().last().unwrap().0 == latest
        })
        .await;
        self.task.abort();
        let seen = self.seen.lock().unwrap().clone();
        for pair in seen.windows(2) {
            assert_eq!(
                pair[1].0,
                pair[0].0 + 1,
                "recorder missed a snapshot: {seen:?}"
            );
        }
        seen.into_iter().map(|(_, state)| state).collect()
    }
}

fn assert_never_failed_cancelled_or_closed(states: &[EngineState]) {
    for state in states {
        if let EngineState::Failed(_, error) = state {
            assert!(
                !matches!(error, EngineError::Cancelled(_) | EngineError::Closed),
                "published {state:?}"
            );
        }
    }
}

// EngineHostTest.kt, one for one.

#[tokio::test]
async fn a_load_publishes_loading_then_ready_with_the_loaded_model() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(Duration::from_millis(200)));
    let target = f.target("org/repo/a");

    let load = tokio::spawn(f.claim("org/repo/a").run());
    assert_eq!(f.state(), EngineState::Loading(installed("org/repo/a")));
    eventually("the open", || has(f.record(), "open")).await;
    assert!(f.journal_file().exists(), "journal during the native open");
    let loaded = load.await.unwrap().expect("load");

    let expected = LoadedModelInfo {
        id: "org/repo/a".to_owned(),
        path: std::path::absolute(&target.path).unwrap(),
        format: ModelFormat::Gguf,
        engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
        kind: EngineKind::LlamaCpp,
        info: scripted_info(),
    };
    assert_eq!(loaded, expected);
    let ready = EngineState::Ready {
        model: expected,
        busy: false,
        queued: 0,
    };
    assert_eq!(f.state(), ready);
    assert!(!f.journal_file().exists(), "journal after the load");
}

#[tokio::test]
async fn a_load_failure_publishes_failed_removes_the_journal_and_frees_the_engine_thread() {
    let failure = model_load_failed("bad magic");
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(failure.clone()));

    let outcome = f.claim("org/repo/a").run().await;

    assert_eq!(refusal(outcome), failure);
    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/a"), failure)
    );
    assert!(!f.journal_file().exists());
    eventually("the engine thread's exit", || {
        f.record().engine_thread_exited()
    })
    .await;
}

#[tokio::test]
async fn an_engine_unavailable_on_this_device_publishes_failed() {
    let unavailable = EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LITERT_LM),
        kind: EngineKind::LitertLm,
        reason: "LiteRT-LM cannot run here.".to_owned(),
    };
    let litert = descriptor(
        EngineId::LITERT_LM,
        EngineKind::LitertLm,
        ModelFormat::Litertlm,
    );
    let f = fixture(
        ScriptedBackend::new(vec![])
            .with_descriptor(litert)
            .with_open_failure(unavailable.clone()),
    );
    let target = LoadTarget {
        format: ModelFormat::Litertlm,
        ..f.target_on("org/repo/b", EngineId::LITERT_LM)
    };

    let outcome = f.manager.claim_load(target).unwrap().run().await;

    assert_eq!(refusal(outcome), unavailable);
    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/b"), unavailable)
    );
}

#[tokio::test]
async fn a_load_pinned_to_an_engine_runs_on_that_engine_even_when_another_is_preferred() {
    let other = descriptor(OTHER_GGUF_ENGINE, EngineKind::LlamaCpp, ModelFormat::Gguf);
    let f = Setup::of_all(vec![
        ScriptedBackend::new(vec![]),
        ScriptedBackend::new(vec![]).with_descriptor(other),
    ])
    .build();

    let claim = f
        .manager
        .claim_load(f.target_on("org/repo/pinned", OTHER_GGUF_ENGINE));
    let loaded = claim.unwrap().run().await.expect("load");

    assert_eq!(loaded.engine, EngineId::new(OTHER_GGUF_ENGINE));
    assert!(
        f.records[0].history().is_empty(),
        "the preferred engine opened nothing"
    );
    assert_eq!(f.records[1].opened_specs().len(), 1);
}

#[tokio::test]
async fn an_engine_whose_open_fails_unavailable_is_marked_unavailable_and_the_refusal_names_it() {
    let reported_elsewhere = EngineError::EngineUnavailable {
        engine: EngineId::new("whatever-the-backend-said"),
        kind: EngineKind::LlamaCpp,
        reason: "llama.cpp did not link.".to_owned(),
    };
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(reported_elsewhere));

    let outcome = f.claim("org/repo/c").run().await;

    let named = EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
        kind: EngineKind::LlamaCpp,
        reason: "llama.cpp did not link.".to_owned(),
    };
    assert_eq!(refusal(outcome), named);
    let unavailable = Availability::Unavailable {
        reason: "llama.cpp did not link.".to_owned(),
    };
    assert_eq!(f.manager.catalog().hosted()[0].1, unavailable);
}

#[tokio::test]
async fn an_engine_whose_load_finds_no_native_library_is_marked_unavailable() {
    let no_library = EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
        kind: EngineKind::LlamaCpp,
        reason: "No llama.cpp library runs here.".to_owned(),
    };
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(no_library.clone()));

    let outcome = f.claim("org/repo/d").run().await;

    assert_eq!(refusal(outcome), no_library);
    let pinned = f.manager.catalog().resolve(
        ModelFormat::Gguf,
        Some(&EngineId::new(EngineId::LLAMA_CPP_CPU)),
    );
    assert_eq!(
        refusal(pinned),
        no_library,
        "later loads are refused before any open"
    );
    assert_eq!(f.record().opened_specs().len(), 1);
}

#[tokio::test]
async fn a_pinned_load_writes_the_journal_during_the_native_open_and_clears_it_after() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(Duration::from_millis(200)));
    let target = f.target_on("org/repo/e", EngineId::LLAMA_CPP_CPU);

    let load = tokio::spawn(f.manager.claim_load(target).unwrap().run());
    eventually("the open", || has(f.record(), "open")).await;
    assert!(f.journal_file().exists(), "journal during the pinned load");
    load.await.unwrap().expect("load");

    assert!(!f.journal_file().exists(), "journal after the pinned load");
}

#[tokio::test]
async fn a_second_load_closes_the_first_model() {
    let f = fixture(ScriptedBackend::new(vec![]));
    f.load("org/repo/a").await;

    f.load("org/repo/b").await;

    assert_eq!(f.record().history(), ["open", "close", "open"]);
    assert_eq!(ready_id(&f.state()), "org/repo/b");
}

#[tokio::test]
async fn a_concurrent_second_load_is_refused_as_load_in_progress() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(Duration::from_millis(200)));
    let first = tokio::spawn(f.claim("org/repo/a").run());

    let second = f.manager.claim_load(f.target("org/repo/b"));

    assert_eq!(refusal(second), EngineError::LoadInProgress);
    assert_eq!(f.state(), EngineState::Loading(installed("org/repo/a")));
    first.await.unwrap().expect("first load");
}

#[tokio::test]
async fn a_claim_reads_loading_before_it_returns_and_before_the_old_model_unloads() {
    let f = fixture(ScriptedBackend::new(vec![]));
    f.load("org/repo/a").await;

    let claim = f.claim("org/repo/b");

    assert_eq!(f.state(), EngineState::Loading(installed("org/repo/b")));
    assert!(!has(f.record(), "close"), "the old model is still open");
    claim.run().await.expect("load");
    assert_eq!(ready_id(&f.state()), "org/repo/b");
}

#[tokio::test]
async fn a_claim_while_another_load_runs_is_refused_and_the_first_load_finishes() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(Duration::from_millis(100)));
    let first = tokio::spawn(f.claim("org/repo/a").run());

    assert_eq!(
        refusal(f.manager.claim_load(f.target("org/repo/b"))),
        EngineError::LoadInProgress
    );
    first.await.unwrap().expect("first load");
    assert_eq!(ready_id(&f.state()), "org/repo/a");
}

#[tokio::test]
async fn a_failed_background_load_is_published_and_returned() {
    let failure = model_load_failed("bad magic");
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(failure.clone()));

    let background = tokio::spawn(f.claim("org/repo/a").run());
    let outcome = background.await.unwrap();

    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/a"), failure.clone())
    );
    assert_eq!(refusal(outcome), failure);
}

#[tokio::test]
async fn a_journal_that_cannot_be_written_never_stops_the_load() {
    let f = fixture(ScriptedBackend::new(vec![]));
    std::fs::write(
        f.dir.path().join(".turbollm-sdk"),
        "a file where the folder belongs",
    )
    .unwrap();

    f.load("org/repo/a").await;

    assert_eq!(ready_id(&f.state()), "org/repo/a");
}

#[tokio::test]
async fn a_load_whose_open_panics_ends_failed_with_the_panic_message() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_panic("no libturbollm-llama.so"));

    let outcome = f.claim("org/repo/a").run().await;

    let failure = model_load_failed("no libturbollm-llama.so");
    assert_eq!(refusal(outcome), failure);
    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/a"), failure)
    );
}

#[tokio::test]
async fn a_load_whose_open_ends_cancelled_is_reported_as_model_load_failed() {
    let cancelled = EngineError::Cancelled("engine state".to_owned());
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(cancelled));

    let outcome = f.claim("org/repo/a").run().await;

    let failure = model_load_failed("engine state");
    assert_eq!(refusal(outcome), failure);
    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/a"), failure)
    );
}

#[tokio::test]
async fn a_dropped_run_future_ends_idle_and_releases_the_lifecycle() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(LONG));
    let recorder = StateRecorder::start(&f.manager);
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;

    load.abort();
    let _ = load.await;

    eventually("the aborted open", || has(f.record(), "open aborted")).await;
    eventually("Idle", || f.state() == EngineState::Idle).await;
    assert!(!f.journal_file().exists(), "journal after the dropped load");
    assert_never_failed_cancelled_or_closed(&recorder.states(&f.manager).await);
    claim_once_free(&f, "org/repo/b").await.abandon();
}

#[tokio::test]
async fn unload_cancels_the_running_generation_before_the_model_closes() {
    let script = vec![
        Step::Emit(EngineEvent::Text("a".to_owned())),
        Step::Pause(LONG),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    assert_eq!(
        generation.next().await,
        Ok(Some(EngineEvent::Text("a".to_owned())))
    );

    f.manager.unload().await.expect("unload");

    let history = f.record().history();
    let aborted = history
        .iter()
        .position(|seen| seen == "aborted")
        .expect("aborted");
    let closed = history
        .iter()
        .position(|seen| seen == "close")
        .expect("close");
    assert!(aborted < closed, "{history:?}");
    assert_eq!(generation.next().await, Err(unloaded_cancel()));
    assert_eq!(f.state(), EngineState::Idle);
}

#[tokio::test]
async fn e9_a_next_already_waiting_when_the_model_unloads_ends_with_the_unload_text() {
    let script = vec![
        Step::Emit(EngineEvent::Text("a".to_owned())),
        Step::Pause(LONG),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    generation.next().await.expect("first event");
    let mut waiting = pin!(generation.next());
    assert!(poll_once(waiting.as_mut()).is_pending());

    f.manager.unload().await.expect("unload");

    assert_eq!(waiting.await, Err(unloaded_cancel()));
}

#[tokio::test]
async fn e6_unload_with_queue_manager() {
    let f = fixture(ScriptedBackend::new(vec![Step::Pause(LONG)]));
    f.load("org/repo/a").await;
    let mut running = f.manager.generate(request()).await.unwrap();
    let manager = f.manager.clone();
    let queued = tokio::spawn(async move { manager.generate(request()).await.err() });
    eventually("one queued request", || {
        is_ready(&f.state()) && occupancy(&f.state()).1 == 1
    })
    .await;

    f.manager.unload().await.expect("unload");

    assert_eq!(running.next().await, Err(unloaded_cancel()));
    let queued_failure = queued.await.unwrap().expect("the queued request fails");
    assert_eq!(
        queued_failure,
        EngineError::ModelNotLoaded(MODEL_UNLOADED.to_owned())
    );
    assert_eq!(queued_failure.to_string(), "The model was unloaded.");
}

#[tokio::test]
async fn generate_when_idle_fails_fast_with_model_not_loaded() {
    let f = fixture(ScriptedBackend::new(vec![]));

    let refused = refusal(f.manager.generate(request()).await);

    assert_eq!(
        refused,
        EngineError::ModelNotLoaded(MODEL_NOT_LOADED.to_owned())
    );
    assert_eq!(refused.to_string(), "The model is not loaded.");
}

#[tokio::test]
async fn generate_runs_on_the_loaded_model() {
    let script = vec![
        Step::Emit(EngineEvent::Text("hi".to_owned())),
        Step::Emit(done()),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;

    let mut generation = f.manager.generate(request()).await.unwrap();

    assert_eq!(
        collect(&mut generation).await,
        [EngineEvent::Text("hi".to_owned()), done()]
    );
    assert!(has(f.record(), "generate"));
}

#[tokio::test]
async fn unloading_when_idle_stays_idle() {
    let f = fixture(ScriptedBackend::new(vec![]));

    f.manager.unload().await.expect("unload");

    assert_eq!(f.state(), EngineState::Idle);
}

// FakeEngineTest.kt, one for one (the scripted backend through the manager).

#[tokio::test]
async fn the_scripted_events_arrive_in_order_after_their_pauses() {
    let script = vec![
        Step::Emit(EngineEvent::Reasoning("hmm".to_owned())),
        Step::Pause(Duration::from_millis(100)),
        Step::Emit(EngineEvent::Text("hi".to_owned())),
        Step::Pause(Duration::from_millis(50)),
        Step::Emit(done()),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let started = Instant::now();

    let mut generation = f.manager.generate(request()).await.unwrap();
    let events = collect(&mut generation).await;

    let expected = [
        EngineEvent::Reasoning("hmm".to_owned()),
        EngineEvent::Text("hi".to_owned()),
        done(),
    ];
    assert_eq!(events, expected);
    assert!(started.elapsed() >= Duration::from_millis(150));
    assert!(!has(f.record(), "aborted"));
}

#[tokio::test]
async fn each_load_is_recorded_with_its_spec_and_reports_the_scripted_model_info() {
    let f = fixture(ScriptedBackend::new(vec![]));
    let target = LoadTarget {
        context_size: Some(1024),
        threads: Some(2),
        backend: Backend::Gpu,
        ..f.target("org/repo/a")
    };

    let loaded = f
        .manager
        .claim_load(target.clone())
        .unwrap()
        .run()
        .await
        .unwrap();

    assert_eq!(loaded.info, scripted_info());
    let spec = LoadSpec {
        path: target.path,
        context_size: Some(1024),
        threads: 2,
        backend: Backend::Gpu,
        cache_dir: f.dir.path().join("cache"),
    };
    assert_eq!(f.record().opened_specs(), [spec]);
}

#[tokio::test]
async fn a_load_without_a_thread_count_uses_the_platform_default() {
    let f = fixture(ScriptedBackend::new(vec![]));

    f.load("org/repo/a").await;

    let threads = f.record().opened_specs()[0].threads;
    assert_eq!(threads, turbollm_platform::default_thread_count());
}

#[tokio::test]
async fn each_unload_closes_the_model_once() {
    let f = fixture(ScriptedBackend::new(vec![]));
    f.load("org/repo/a").await;

    f.manager.unload().await.expect("first unload");
    f.manager.unload().await.expect("second unload");

    assert_eq!(f.record().history(), ["open", "close"]);
}

#[tokio::test]
async fn a_scripted_open_failure_comes_after_the_open_is_recorded() {
    let failure = model_load_failed("bad magic");
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(failure.clone()));

    let outcome = f.claim("org/repo/a").run().await;

    assert_eq!(refusal(outcome), failure);
    assert_eq!(f.record().opened_specs().len(), 1);
}

#[tokio::test]
async fn cancelling_a_generation_mid_stream_aborts_the_backend() {
    let script = vec![
        Step::Emit(EngineEvent::Text("a".to_owned())),
        Step::Pause(LONG),
        Step::Emit(done()),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    generation.next().await.expect("first event");

    generation.cancel();

    let cancelled = EngineError::Cancelled(REPLY_CANCELLED.to_owned());
    assert_eq!(generation.next().await, Err(cancelled));
    eventually("the backend's abort", || has(f.record(), "aborted")).await;
}

#[tokio::test]
async fn the_cancel_signal_stops_a_generation_whose_next_is_pending_elsewhere() {
    let script = vec![
        Step::Emit(EngineEvent::Text("a".to_owned())),
        Step::Pause(LONG),
        Step::Emit(done()),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    generation.next().await.expect("first event");
    let canceller = generation.canceller();
    let pending = tokio::spawn(async move { generation.next().await });

    canceller.cancel();

    let cancelled = EngineError::Cancelled(REPLY_CANCELLED.to_owned());
    let ended = tokio::time::timeout(WAIT_LIMIT, pending).await;
    assert_eq!(ended.unwrap().unwrap(), Err(cancelled));
    eventually("the backend's abort", || has(f.record(), "aborted")).await;
}

#[tokio::test]
async fn dropping_a_generation_early_aborts_the_backend() {
    let script = vec![
        Step::Emit(EngineEvent::Text("a".to_owned())),
        Step::Pause(LONG),
        Step::Emit(EngineEvent::Text("b".to_owned())),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    generation.next().await.expect("first event");

    drop(generation);

    eventually("the backend's abort", || has(f.record(), "aborted")).await;
    eventually("the freed slot", || !occupancy(&f.state()).0).await;
}

#[tokio::test]
async fn the_loaded_model_reports_the_kind_of_its_engine() {
    let litert = descriptor(
        EngineId::LITERT_LM,
        EngineKind::LitertLm,
        ModelFormat::Litertlm,
    );
    let f = fixture(ScriptedBackend::new(vec![]).with_descriptor(litert));
    let target = LoadTarget {
        format: ModelFormat::Litertlm,
        ..f.target_on("org/repo/l", EngineId::LITERT_LM)
    };

    let loaded = f.manager.claim_load(target).unwrap().run().await.unwrap();

    assert_eq!(loaded.kind, EngineKind::LitertLm);
}

// Arch 9's manager list, the QA edge cases and PG-4.

#[tokio::test]
async fn a_held_claim_refuses_another_claim() {
    let f = fixture(ScriptedBackend::new(vec![]));
    let _held = f.claim("org/repo/a");

    assert_eq!(
        refusal(f.manager.claim_load(f.target("org/repo/b"))),
        EngineError::LoadInProgress
    );
}

#[tokio::test]
async fn loading_is_visible_as_soon_as_claim_load_returns() {
    let f = fixture(ScriptedBackend::new(vec![]));
    let before = f.manager.snapshot().revision;

    let _claim = f.claim("org/repo/a");

    let snapshot = f.manager.snapshot();
    assert_eq!(
        snapshot.state,
        EngineState::Loading(installed("org/repo/a"))
    );
    assert!(snapshot.revision > before);
}

#[tokio::test]
async fn an_abandoned_claim_ends_idle_and_releases_the_lifecycle() {
    let f = fixture(ScriptedBackend::new(vec![]));

    f.claim("org/repo/a").abandon();

    assert_eq!(f.state(), EngineState::Idle);
    f.load("org/repo/b").await;
    assert!(
        f.record()
            .opened_specs()
            .iter()
            .all(|spec| spec.path.ends_with("b.gguf"))
    );
}

#[tokio::test]
async fn a_claim_abandoned_while_a_model_is_resident_shows_that_model_ready_again() {
    let f = fixture(ScriptedBackend::new(vec![]));
    f.load("org/repo/a").await;

    f.claim("org/repo/b").abandon();

    assert_eq!(ready_id(&f.state()), "org/repo/a");
    assert_eq!(
        f.record().history(),
        ["open"],
        "the resident model stays open"
    );
    assert!(f.manager.generate(request()).await.is_ok());
}

#[tokio::test]
async fn a_dropped_claim_ends_idle_and_releases_the_lifecycle() {
    let f = fixture(ScriptedBackend::new(vec![]));

    drop(f.claim("org/repo/a"));

    assert_eq!(f.state(), EngineState::Idle);
    assert_eq!(f.load("org/repo/b").await.id, "org/repo/b");
}

#[tokio::test]
async fn a_dropped_run_future_closes_the_model_its_open_still_produced() {
    let f = fixture(
        ScriptedBackend::new(vec![]).with_unabortable_open_pause(Duration::from_millis(200)),
    );
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;

    load.abort();
    let _ = load.await;

    assert_eq!(
        f.state(),
        EngineState::Loading(installed("org/repo/a")),
        "not Idle while the abandoned open still runs"
    );
    eventually("Idle", || f.state() == EngineState::Idle).await;
    assert!(has(f.record(), "close"), "Idle only after the close");
}

#[tokio::test]
async fn a_dropped_run_future_holds_the_lifecycle_until_its_open_ended_and_closed() {
    let f = fixture(
        ScriptedBackend::new(vec![]).with_unabortable_open_pause(Duration::from_millis(300)),
    );
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;

    load.abort();
    let _ = load.await;

    assert_eq!(
        refusal(f.manager.claim_load(f.target("org/repo/b"))),
        EngineError::LoadInProgress
    );
    eventually("the close", || has(f.record(), "close")).await;
    let next = claim_once_free(&f, "org/repo/b").await;
    next.run().await.expect("load");
    assert_eq!(f.record().history(), ["open", "close", "open"]);
}

#[tokio::test]
async fn a_dropped_run_future_keeps_the_journal_until_the_open_returned() {
    let f = fixture(
        ScriptedBackend::new(vec![]).with_unabortable_open_pause(Duration::from_millis(300)),
    );
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;

    load.abort();
    let _ = load.await;

    assert!(
        f.journal_file().exists(),
        "journal while the abandoned open still runs"
    );
    eventually("the close", || has(f.record(), "close")).await;
    eventually("the cleared journal", || !f.journal_file().exists()).await;
}

#[tokio::test]
async fn shutdown_after_a_dropped_run_publishes_closed_only_after_the_open_was_closed() {
    let f = fixture(
        ScriptedBackend::new(vec![]).with_unabortable_open_pause(Duration::from_millis(300)),
    );
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;
    load.abort();
    let _ = load.await;

    f.manager.shutdown().await;

    assert_eq!(f.record().history(), ["open", "close"]);
    assert_eq!(f.state(), EngineState::Closed);
}

#[tokio::test]
async fn a_cancelled_unload_still_ends_idle_after_the_model_closed() {
    let f = fixture(ScriptedBackend::new(vec![]).with_close_pause(Duration::from_millis(300)));
    f.load("org/repo/a").await;
    let manager = f.manager.clone();
    let unload = tokio::spawn(async move { manager.unload().await });
    tokio::time::sleep(UNDERWAY).await;

    unload.abort();
    let _ = unload.await;

    assert_eq!(
        refusal(f.manager.claim_load(f.target("org/repo/b"))),
        EngineError::LoadInProgress
    );
    eventually("Idle", || f.state() == EngineState::Idle).await;
    assert_eq!(f.record().history(), ["open", "close"]);
    assert!(f.record().engine_thread_exited());
}

#[tokio::test]
async fn a_cancelled_shutdown_still_reaches_closed() {
    let f = fixture(ScriptedBackend::new(vec![]).with_close_pause(Duration::from_millis(300)));
    f.load("org/repo/a").await;
    let manager = f.manager.clone();
    let shutdown = tokio::spawn(async move { manager.shutdown().await });
    tokio::time::sleep(UNDERWAY).await;

    shutdown.abort();
    let _ = shutdown.await;

    eventually("Closed", || f.state() == EngineState::Closed).await;
    assert_eq!(f.record().history(), ["open", "close"]);
}

#[tokio::test]
async fn a_successors_run_waits_for_the_predecessor_to_close() {
    let first = fixture(ScriptedBackend::new(vec![]));
    first.load("org/repo/a").await;
    let second = Setup::of(ScriptedBackend::new(vec![]))
        .after(&first.manager)
        .build();
    let load = tokio::spawn(second.claim("org/repo/b").run());

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        second.state(),
        EngineState::Loading(installed("org/repo/b"))
    );
    assert!(
        second.record().history().is_empty(),
        "no open before the predecessor closed"
    );

    first.manager.shutdown().await;

    load.await.unwrap().expect("successor load");
    assert_eq!(first.record().history(), ["open", "close"]);
    assert_eq!(ready_id(&second.state()), "org/repo/b");
}

#[tokio::test]
async fn a_successor_lets_go_of_its_predecessor_once_it_closed() {
    let first = fixture(ScriptedBackend::new(vec![]));
    let predecessors_engine = Arc::downgrade(&first.records[0]);
    let second = Setup::of(ScriptedBackend::new(vec![]))
        .after(&first.manager)
        .build();

    first.manager.shutdown().await;
    second.load("org/repo/b").await;
    drop(first);

    assert!(
        predecessors_engine.upgrade().is_none(),
        "the successor keeps its predecessor's engines alive"
    );
}

#[tokio::test]
async fn a_stalled_open_ends_failed_with_the_stall_text_and_releases_everything() {
    let clock = FakeClock::paused();
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(LONG));
    let started = tokio::time::Instant::now();

    let outcome = f.claim("org/repo/a").run().await;

    let stalled =
        model_load_failed("llama.cpp could not load the model: no load progress for 120 s");
    assert_eq!(refusal(outcome), stalled);
    let waited = started.elapsed();
    assert!(
        waited >= SDK_STALL && waited < SDK_STALL + Duration::from_secs(1),
        "{waited:?}"
    );
    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/a"), stalled)
    );
    assert!(has(f.record(), "open aborted"));
    assert!(!f.journal_file().exists(), "journal after the stall");
    f.claim("org/repo/b").abandon();
    clock.settle().await;
}

#[tokio::test]
async fn an_open_that_ends_closed_is_reported_as_model_load_failed() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_failure(EngineError::Closed));

    let outcome = f.claim("org/repo/a").run().await;

    let failure = model_load_failed("The TurboLLM core is closed.");
    assert_eq!(refusal(outcome), failure);
    assert_eq!(
        f.state(),
        EngineState::Failed(installed("org/repo/a"), failure)
    );
}

#[tokio::test]
async fn a_target_naming_an_engine_this_build_lacks_fails_without_an_open() {
    let f = fixture(ScriptedBackend::new(vec![]));

    let outcome = f
        .manager
        .claim_load(f.target_on("org/repo/a", "no-such-engine"))
        .unwrap();
    let failure = refusal(outcome.run().await);

    assert!(matches!(
        failure,
        EngineError::InvalidRequest {
            reason: InvalidReason::UnknownEngine,
            ..
        }
    ));
    assert!(f.record().history().is_empty());
}

#[tokio::test]
async fn revision_rises_on_every_transition_and_gate_change() {
    let f = fixture(ScriptedBackend::new(vec![
        Step::Pause(Duration::from_millis(100)),
        Step::Emit(done()),
    ]));
    let mut revisions = vec![f.manager.snapshot().revision];
    let mut note = |manager: &EngineManager| revisions.push(manager.snapshot().revision);

    let claim = f.claim("org/repo/a");
    note(&f.manager);
    claim.run().await.unwrap();
    note(&f.manager);
    let mut generation = f.manager.generate(request()).await.unwrap();
    eventually("busy", || occupancy(&f.state()).0).await;
    note(&f.manager);
    collect(&mut generation).await;
    eventually("idle gate", || !occupancy(&f.state()).0).await;
    note(&f.manager);
    f.manager.unload().await.unwrap();
    note(&f.manager);

    assert!(
        revisions.windows(2).all(|pair| pair[1] > pair[0]),
        "{revisions:?}"
    );
}

#[tokio::test]
async fn a_refused_request_that_changes_nothing_keeps_the_revision() {
    let f = Setup::of(ScriptedBackend::new(vec![Step::Pause(LONG)]))
        .max_queued(0)
        .build();
    f.load("org/repo/a").await;
    let running = f.manager.generate(request()).await.unwrap();
    eventually("busy", || occupancy(&f.state()).0).await;
    let before = f.manager.snapshot().revision;

    let refused = refusal(f.manager.generate(request()).await);

    assert_eq!(refused, EngineError::ServerBusy);
    assert_eq!(f.manager.snapshot().revision, before);
    running.cancel();
}

#[tokio::test]
async fn e4_no_model_full_queue_is_model_not_loaded() {
    let f = Setup::of(ScriptedBackend::new(vec![]))
        .max_queued(0)
        .build();
    let requests = (0..SDK_QUEUE + 2).map(|_| {
        let manager = f.manager.clone();
        tokio::spawn(async move { manager.generate(request()).await.err() })
    });

    for request in requests.collect::<Vec<_>>() {
        let refused = request.await.unwrap().expect("refused");
        assert_eq!(
            refused,
            EngineError::ModelNotLoaded(MODEL_NOT_LOADED.to_owned())
        );
    }
}

#[tokio::test]
async fn unload_waits_for_the_running_native_call_and_reads_ready_until_the_model_is_gone() {
    let f = fixture(ScriptedBackend::new(vec![Step::Block(
        Duration::from_millis(300),
    )]));
    f.load("org/repo/a").await;
    let _generation = f.manager.generate(request()).await.unwrap();
    eventually("the native call", || has(f.record(), "generate")).await;
    let manager = f.manager.clone();
    let unload = tokio::spawn(async move { manager.unload().await });

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        is_ready(&f.state()),
        "still Ready while the native call runs"
    );
    unload.await.unwrap().expect("unload");

    assert!(has(f.record(), "generate returned"));
    assert!(has(f.record(), "close"));
    assert!(f.record().engine_thread_exited());
    assert_eq!(f.state(), EngineState::Idle);
}

#[tokio::test]
async fn unload_during_a_load_waits_for_it_then_ends_idle() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(Duration::from_millis(200)));
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;

    f.manager.unload().await.expect("unload");

    assert_eq!(f.record().history(), ["open", "close"]);
    assert_eq!(f.state(), EngineState::Idle);
    load.await.unwrap().expect("the load itself finished");
}

#[tokio::test]
async fn a_finished_generation_dropped_after_done_is_not_aborted() {
    let f = fixture(ScriptedBackend::new(vec![Step::Emit(done())]));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    assert_eq!(generation.next().await, Ok(Some(done())));

    drop(generation);
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(!has(f.record(), "abort hook"), "{:?}", f.record().history());
}

#[tokio::test]
async fn shutdown_during_a_load_ends_closed_never_failed() {
    let f = fixture(ScriptedBackend::new(vec![]).with_open_pause(Duration::from_millis(200)));
    let recorder = StateRecorder::start(&f.manager);
    let load = tokio::spawn(f.claim("org/repo/a").run());
    eventually("the open", || has(f.record(), "open")).await;

    f.manager.shutdown().await;

    assert_eq!(f.state(), EngineState::Closed);
    let _ = load.await;
    let states = recorder.states(&f.manager).await;
    assert_eq!(states.last(), Some(&EngineState::Closed));
    assert_never_failed_cancelled_or_closed(&states);
}

#[tokio::test]
async fn every_call_after_shutdown_is_refused_as_closed() {
    let f = fixture(ScriptedBackend::new(vec![]));
    f.load("org/repo/a").await;

    f.manager.shutdown().await;
    f.manager.shutdown().await;

    assert_eq!(f.record().history(), ["open", "close"]);
    assert_eq!(f.state(), EngineState::Closed);
    assert_eq!(
        refusal(f.manager.claim_load(f.target("org/repo/b"))),
        EngineError::Closed
    );
    assert_eq!(
        refusal(f.manager.generate(request()).await),
        EngineError::Closed
    );
    assert_eq!(f.manager.unload().await, Err(EngineError::Closed));
}

#[tokio::test]
async fn a_watcher_sees_the_next_revision() {
    let f = fixture(ScriptedBackend::new(vec![]));
    let start = f.manager.snapshot().revision;
    let manager = f.manager.clone();
    let watcher = tokio::spawn(async move { manager.next_snapshot(start).await });

    let _claim = f.claim("org/repo/a");

    let seen = watcher.await.unwrap();
    assert_eq!(seen.revision, start + 1);
    assert_eq!(seen.state, EngineState::Loading(installed("org/repo/a")));
}

#[tokio::test]
async fn cancel_after_done_never_runs_the_abort_hook() {
    let f = fixture(ScriptedBackend::new(vec![Step::Emit(done())]));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    assert_eq!(generation.next().await, Ok(Some(done())));

    generation.cancel();

    assert!(!has(f.record(), "abort hook"), "{:?}", f.record().history());
}

#[tokio::test]
async fn cancel_after_done_while_the_native_call_still_runs_never_runs_the_abort_hook() {
    let script = vec![Step::Emit(done()), Step::Block(Duration::from_millis(300))];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    assert_eq!(generation.next().await, Ok(Some(done())));
    assert!(
        !has(f.record(), "generate returned"),
        "the native call still runs"
    );

    generation.cancel();

    assert!(!has(f.record(), "abort hook"), "{:?}", f.record().history());
}

#[tokio::test]
async fn a_cancel_after_done_never_reaches_the_queued_request_that_follows() {
    let script = vec![Step::Pause(Duration::from_millis(300)), Step::Emit(done())];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut first = f.manager.generate(request()).await.unwrap();
    let manager = f.manager.clone();
    let second = tokio::spawn(async move {
        let mut queued = manager.generate(request()).await?;
        read_to_end(&mut queued).await
    });
    eventually("the queued request", || occupancy(&f.state()).1 == 1).await;
    assert_eq!(first.next().await, Ok(Some(done())));
    eventually("the queued request's native call", || {
        native_calls(f.record()) == 2
    })
    .await;

    first.cancel();

    assert_eq!(second.await.unwrap(), Ok(vec![done()]));
}

#[tokio::test]
async fn cancel_wakes_an_engine_thread_blocked_on_an_unread_reply() {
    let f = fixture(ScriptedBackend::new(texts(100)));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    generation.next().await.expect("first event");

    generation.cancel();

    eventually_within(CANCEL_LIMIT, "the native call to return", || {
        has(f.record(), "generate returned")
    })
    .await;
    eventually_within(CANCEL_LIMIT, "the freed slot", || !occupancy(&f.state()).0).await;
    let unload = tokio::time::timeout(Duration::from_secs(2), f.manager.unload()).await;
    assert_eq!(unload, Ok(Ok(())), "unload with the unread generation held");
    drop(generation);
}

#[tokio::test]
async fn e26_a_slow_consumer_back_pressures_the_engine_and_cancel_wakes_it() {
    let f = fixture(ScriptedBackend::new(texts(10_000)));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();
    let mut pulled = 0;
    let reading = Instant::now();
    while reading.elapsed() < Duration::from_secs(1) {
        generation.next().await.expect("event");
        pulled += 1;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let emitted = f.record().emitted();
    assert!(
        emitted <= REPLY_BUFFER + pulled,
        "emitted {emitted}, pulled {pulled}"
    );
    generation.cancel();

    eventually_within(CANCEL_LIMIT, "the native call to return", || {
        has(f.record(), "generate returned")
    })
    .await;
    let ended = loop {
        match generation.next().await {
            Ok(Some(_buffered)) => continue,
            other => break other,
        }
    };
    assert_eq!(
        ended,
        Err(EngineError::Cancelled(REPLY_CANCELLED.to_owned()))
    );
}

#[tokio::test]
async fn a_reply_whose_engine_stops_before_done_ends_with_an_engine_failure() {
    let script = vec![
        Step::Emit(EngineEvent::Text("partial".to_owned())),
        Step::Panic("the engine crashed mid-reply"),
    ];
    let f = fixture(ScriptedBackend::new(script));
    f.load("org/repo/a").await;
    let mut generation = f.manager.generate(request()).await.unwrap();

    assert_eq!(
        generation.next().await,
        Ok(Some(EngineEvent::Text("partial".to_owned())))
    );
    let ended = generation.next().await;
    assert!(
        matches!(ended, Err(EngineError::EngineFailure(_))),
        "{ended:?}"
    );
}
