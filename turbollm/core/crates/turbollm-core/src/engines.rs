//! The engine layer as a binding holds it (arch 2.6): each `Engines` handle owns one tokio runtime
//! and one `EngineManager`; nothing is process-wide (B-5). In M-1 the catalogue is the `extra`
//! engines only; the native llama.cpp and LiteRT-LM rows arrive with features `llama` and `litert`.

use std::collections::BTreeMap;
use std::future::Future;
use std::hash::{BuildHasher, Hasher, RandomState};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::runtime::{Builder, Handle, Runtime};
use tokio::task::{JoinError, JoinHandle};
use turbollm_engine::{
    Catalog, CatalogEntry, Engine, EngineError, EngineId, EngineManager, LoadJournal,
    ManagerConfig, PlatformKind, PlatformKinds,
};
use turbollm_platform::HostFacts;

/// What one `Engines` handle is built from (the binding's `CoreEngineConfig`).
pub struct EnginesConfig {
    pub cache_dir: PathBuf,
    /// Where the native engine libraries are; unused until the native engines arrive (T18, T25).
    pub library_dir: Option<PathBuf>,
    /// `<modelRoot>/.turbollm-sdk/loading.json`; `None` keeps no journal.
    pub journal_path: Option<PathBuf>,
    pub max_queued: u32,
    /// The load stall window (ADR-460); zero turns the watch off.
    pub stall: Duration,
    /// Engines made unavailable on purpose (debug faults), with the reason each reports.
    pub forced_unavailable: BTreeMap<EngineId, String>,
}

/// One core's engines: the runtime their work runs on and the manager that drives them.
pub struct Engines {
    runtime: Option<tokio::runtime::Runtime>,
    manager: EngineManager,
}

impl Engines {
    /// A successor given its `predecessor` loads nothing before the predecessor reached `Closed`.
    pub fn new(
        cfg: EnginesConfig,
        extra: Vec<Arc<dyn Engine>>,
        predecessor: Option<&Engines>,
    ) -> Result<Engines, EngineError> {
        let runtime = core_runtime()?;
        let manager = EngineManager::new(ManagerConfig {
            catalog: catalog_of(extra, cfg.forced_unavailable),
            journal: cfg
                .journal_path
                .map(|path| LoadJournal::new(path, journal_owner())),
            predecessor: predecessor.map(|handle| handle.manager.clone()),
            stall: cfg.stall,
            max_queued: usize::try_from(cfg.max_queued).unwrap_or(usize::MAX),
            cache_dir: cfg.cache_dir,
        });
        Ok(Engines {
            runtime: Some(runtime),
            manager,
        })
    }

    pub fn manager(&self) -> &EngineManager {
        &self.manager
    }

    /// Runs `f` on this handle's runtime; dropping the returned handle aborts it.
    pub fn spawn<F>(&self, f: F) -> AbortOnDrop<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        AbortOnDrop {
            task: self.spawn_to_completion(f),
        }
    }

    /// Runs `f` on this handle's runtime to its end; dropping the returned handle only stops the wait.
    pub fn spawn_to_completion<F>(&self, f: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.runtime
            .as_ref()
            .expect("the runtime lives as long as the handle")
            .spawn(f)
    }
}

/// Stops the runtime and joins its threads. Inside an async context joining would block (and
/// tokio refuses it), so there the threads are told to stop and left to finish on their own.
impl Drop for Engines {
    fn drop(&mut self) {
        let Some(runtime) = self.runtime.take() else {
            return;
        };
        match Handle::try_current() {
            Ok(_) => runtime.shutdown_background(),
            Err(_) => drop(runtime),
        }
    }
}

fn core_runtime() -> Result<Runtime, EngineError> {
    Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("turbollm-core")
        .enable_time()
        .build()
        .map_err(|err| {
            EngineError::EngineFailure(format!("The TurboLLM core runtime could not start: {err}"))
        })
}

fn catalog_of(extra: Vec<Arc<dyn Engine>>, forced: BTreeMap<EngineId, String>) -> Catalog {
    let with_engines = extra
        .into_iter()
        .fold(Catalog::new(HostFacts::detect()), |catalog, engine| {
            catalog.with_entry(extra_entry(engine))
        });
    forced
        .into_iter()
        .fold(with_engines, |catalog, (id, reason)| {
            catalog.with_forced_unavailable(id, reason)
        })
}

/// An engine handed in by the host (a foreign backend or a test double) runs in the host's own
/// process, whichever platform that is.
fn extra_entry(engine: Arc<dyn Engine>) -> CatalogEntry {
    CatalogEntry {
        descriptor: engine.descriptor().clone(),
        per_platform: PlatformKinds {
            android: PlatformKind::InProcess,
            ios: PlatformKind::InProcess,
            linux: PlatformKind::InProcess,
            windows: PlatformKind::InProcess,
            mac_os: PlatformKind::InProcess,
        },
        engine,
    }
}

/// Unique per handle, so one core never clears the journal record another core wrote
/// (`LoadSentinel.kt` used a random UUID). Std's per-instance random hasher keys stand in for
/// a random-number dependency.
fn journal_owner() -> String {
    let random = RandomState::new().build_hasher().finish();
    format!("core-{}-{random:016x}", std::process::id())
}

/// A task on the core runtime that is aborted when its handle is dropped, so a caller that stops
/// waiting (a cancelled Kotlin coroutine) stops the work at its next await point.
pub struct AbortOnDrop<T> {
    task: JoinHandle<T>,
}

impl<T> Future for AbortOnDrop<T> {
    type Output = Result<T, JoinError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.task).poll(cx)
    }
}

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Instant;

    use tempfile::TempDir;
    use turbollm_engine::testing::{OpenGate, ScriptedBackend, Step};
    use turbollm_engine::{
        Availability, Backend, ChatMessage, EngineDescriptor, EngineKind, EngineState,
        GenerateRequest, GenerationParams, InProcess, LoadJournal, LoadTarget, MessageContent,
        ModelFormat, ModelRef, Role,
    };

    use super::*;

    const WAIT_LIMIT: Duration = Duration::from_secs(5);
    const POLL: Duration = Duration::from_millis(5);
    const LONG: Duration = Duration::from_secs(3600);
    const CORE_THREAD: &str = "turbollm-core";

    #[test]
    fn a_spawned_task_runs_on_the_core_runtime_and_answers_through_its_handle() {
        let dir = TempDir::new().unwrap();
        let engines = engines_of(config_in(dir.path()), vec![]);
        let (answer, answered) = mpsc::channel();

        let handle = engines.spawn(async { std::thread::current().name().map(str::to_owned) });
        let _relay = engines.spawn(async move { answer.send(handle.await.unwrap()).unwrap() });

        let thread = answered.recv_timeout(WAIT_LIMIT).unwrap();
        assert_eq!(thread.as_deref(), Some(CORE_THREAD));
    }

    #[test]
    fn a_dropped_handle_aborts_its_task() {
        let dir = TempDir::new().unwrap();
        let engines = engines_of(config_in(dir.path()), vec![]);
        let aborted = Arc::new(AtomicBool::new(false));
        let (started, has_started) = mpsc::channel();
        let flag = SetOnDrop(Arc::clone(&aborted));

        let handle = engines.spawn(async move {
            let _flag = flag;
            started.send(()).unwrap();
            std::future::pending::<()>().await
        });
        has_started.recv_timeout(WAIT_LIMIT).unwrap();
        drop(handle);

        wait_until("the task was aborted", || aborted.load(Ordering::SeqCst));
    }

    #[test]
    fn a_task_spawned_to_completion_runs_on_after_its_handle_is_dropped() {
        let dir = TempDir::new().unwrap();
        let engines = engines_of(config_in(dir.path()), vec![]);
        let (release, released) = mpsc::channel::<()>();
        let (finished, has_finished) = mpsc::channel();

        let handle = engines.spawn_to_completion(async move {
            tokio::task::yield_now().await;
            let _ = released.recv_timeout(WAIT_LIMIT);
            finished.send(()).unwrap();
        });
        drop(handle);
        release.send(()).unwrap();

        has_finished.recv_timeout(WAIT_LIMIT).unwrap();
    }

    #[test]
    fn dropping_the_handle_after_shutdown_stops_every_runtime_thread() {
        let dir = TempDir::new().unwrap();
        let engines = engines_of(config_in(dir.path()), vec![]);
        let live_threads = Arc::new(AtomicUsize::new(0));
        let (seen, has_seen) = mpsc::channel();
        let counter = Arc::clone(&live_threads);
        let _probe = engines.spawn(async move {
            count_this_thread_while_it_lives(&counter);
            seen.send(std::thread::current().name().map(str::to_owned))
                .unwrap();
        });
        assert_eq!(
            has_seen.recv_timeout(WAIT_LIMIT).unwrap().as_deref(),
            Some(CORE_THREAD)
        );
        assert_eq!(live_threads.load(Ordering::SeqCst), 1);

        shut_down_and_wait(&engines);
        drop(engines);

        assert_eq!(
            live_threads.load(Ordering::SeqCst),
            0,
            "a turbollm-core thread outlived the handle"
        );
    }

    #[tokio::test]
    async fn dropping_the_handle_inside_an_async_context_neither_blocks_nor_panics() {
        let dir = TempDir::new().unwrap();
        let engines = engines_of(config_in(dir.path()), vec![]);
        let _busy = engines.spawn(std::future::pending::<()>());

        drop(engines);
    }

    #[tokio::test]
    async fn a_successors_load_waits_for_its_predecessor_to_close() {
        let dir = TempDir::new().unwrap();
        let predecessor = engines_of(config_in(dir.path()), vec![scripted(backend())]);
        load(&predecessor, dir.path(), "org/repo/a").await.unwrap();
        let successor_backend = backend();
        let successor_record = successor_backend.record();
        let successor = Engines::new(
            config_in(dir.path()),
            vec![scripted(successor_backend)],
            Some(&predecessor),
        )
        .unwrap();

        let loading = start_load(&successor, dir.path(), "org/repo/b");
        wait_until_async("the successor to wait on its predecessor", || {
            predecessor.manager().parked_snapshot_waiters() == 1
        })
        .await;
        assert!(
            successor_record.history().is_empty(),
            "no open before the predecessor closed"
        );

        let manager = predecessor.manager().clone();
        predecessor
            .spawn(async move { manager.shutdown().await })
            .await
            .unwrap();

        loading.await.unwrap().expect("successor load");
        assert_eq!(successor_record.history(), ["open"]);
        assert_eq!(predecessor.manager().snapshot().state, EngineState::Closed);
    }

    #[test]
    fn the_catalogue_is_the_extra_engines_in_the_order_given() {
        let dir = TempDir::new().unwrap();
        let engines = engines_of(
            config_in(dir.path()),
            vec![
                scripted(backend_named("second-gguf")),
                scripted(backend_named("first-gguf")),
            ],
        );

        let hosted = engines.manager().catalog().hosted();

        let ids: Vec<&str> = hosted.iter().map(|(d, _)| d.id.as_str()).collect();
        assert_eq!(ids, ["second-gguf", "first-gguf"]);
        assert!(
            hosted
                .iter()
                .all(|(_, availability)| *availability == Availability::Available)
        );
    }

    #[test]
    fn a_forced_reason_makes_its_engine_unavailable() {
        let dir = TempDir::new().unwrap();
        let mut cfg = config_in(dir.path());
        let reason = "turned off for this test".to_owned();
        cfg.forced_unavailable
            .insert(EngineId::new(EngineId::LLAMA_CPP_CPU), reason.clone());

        let engines = engines_of(cfg, vec![scripted(backend())]);

        let (_, availability) = &engines.manager().catalog().hosted()[0];
        assert_eq!(*availability, Availability::Unavailable { reason });
    }

    #[tokio::test]
    async fn the_configured_queue_limit_reaches_the_manager() {
        let dir = TempDir::new().unwrap();
        let mut cfg = config_in(dir.path());
        cfg.max_queued = 0;
        let engines = engines_of(
            cfg,
            vec![scripted(ScriptedBackend::new(vec![Step::Pause(LONG)]))],
        );
        load(&engines, dir.path(), "org/repo/a").await.unwrap();

        let _running = generate(&engines).await.unwrap().expect("first generation");
        let refused = tokio::time::timeout(WAIT_LIMIT, generate(&engines)).await;

        let refusal = refused.expect("refused at once").unwrap().err();
        assert_eq!(refusal, Some(EngineError::ServerBusy));
    }

    #[tokio::test]
    async fn a_load_opens_with_the_configured_cache_dir() {
        let dir = TempDir::new().unwrap();
        let cfg = config_in(dir.path());
        let cache_dir = cfg.cache_dir.clone();
        let backend = backend();
        let record = backend.record();
        let engines = engines_of(cfg, vec![scripted(backend)]);

        load(&engines, dir.path(), "org/repo/a").await.unwrap();

        assert_eq!(record.opened_specs()[0].cache_dir, cache_dir);
    }

    #[tokio::test]
    async fn a_load_is_recorded_in_the_configured_journal_until_it_ends() {
        let dir = TempDir::new().unwrap();
        let journal = LoadJournal::path_in(dir.path());
        let slow_open = backend().with_open_pause(Duration::from_millis(300));
        let engines = engines_of(config_in(dir.path()), vec![scripted(slow_open)]);

        let loading = start_load(&engines, dir.path(), "org/repo/a");
        wait_until_async("the journal is written", || journal.exists()).await;
        loading.await.unwrap().expect("load");

        assert!(!journal.exists(), "the journal is cleared after the load");
    }

    #[tokio::test]
    async fn two_handles_on_one_journal_never_clear_each_others_record() {
        let dir = TempDir::new().unwrap();
        let journal = LoadJournal::path_in(dir.path());
        let (first_open, second_open) = (OpenGate::new(), OpenGate::new());
        let first = engines_of(
            config_in(dir.path()),
            vec![scripted(backend().with_held_open(&first_open))],
        );
        let second = engines_of(
            config_in(dir.path()),
            vec![scripted(backend().with_held_open(&second_open))],
        );

        let first_load = start_load(&first, dir.path(), "org/repo/a");
        wait_until_async("the first load is journalled", || journal.exists()).await;
        let first_record = std::fs::read_to_string(&journal).unwrap();
        let second_load = start_load(&second, dir.path(), "org/repo/b");
        wait_until_async("the second core's record", || {
            std::fs::read_to_string(&journal).is_ok_and(|record| record != first_record)
        })
        .await;
        first_open.release();
        first_load.await.unwrap().expect("first load");

        assert!(
            journal.exists(),
            "the first core cleared the record the second core wrote"
        );
        second_open.release();
        second_load.await.unwrap().expect("second load");
        assert!(!journal.exists());
    }

    struct SetOnDrop(Arc<AtomicBool>);

    impl Drop for SetOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    thread_local! {
        static LIVE_THREAD: RefCell<Option<LiveThread>> = const { RefCell::new(None) };
    }

    /// Counted while its thread lives; the thread's exit drops it.
    struct LiveThread(Arc<AtomicUsize>);

    impl Drop for LiveThread {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn count_this_thread_while_it_lives(counter: &Arc<AtomicUsize>) {
        LIVE_THREAD.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_none() {
                counter.fetch_add(1, Ordering::SeqCst);
                *slot = Some(LiveThread(Arc::clone(counter)));
            }
        });
    }

    fn shut_down_and_wait(engines: &Engines) {
        let (done, is_done) = mpsc::channel();
        let manager = engines.manager().clone();
        let _shutdown = engines.spawn(async move {
            manager.shutdown().await;
            done.send(()).unwrap();
        });
        is_done.recv_timeout(WAIT_LIMIT).unwrap();
    }

    fn engines_of(cfg: EnginesConfig, extra: Vec<Arc<dyn Engine>>) -> Engines {
        Engines::new(cfg, extra, None).unwrap()
    }

    fn config_in(dir: &Path) -> EnginesConfig {
        EnginesConfig {
            cache_dir: dir.join("cache"),
            library_dir: None,
            journal_path: Some(LoadJournal::path_in(dir)),
            max_queued: 8,
            stall: Duration::from_secs(120),
            forced_unavailable: BTreeMap::new(),
        }
    }

    fn backend() -> ScriptedBackend {
        ScriptedBackend::new(vec![])
    }

    fn backend_named(id: &str) -> ScriptedBackend {
        backend().with_descriptor(EngineDescriptor {
            id: EngineId::new(id),
            name: id.to_owned(),
            kind: EngineKind::LlamaCpp,
            formats: vec![ModelFormat::Gguf],
            backends: vec![Backend::Cpu],
        })
    }

    fn scripted(backend: ScriptedBackend) -> Arc<dyn Engine> {
        Arc::new(InProcess::new(backend))
    }

    fn start_load(
        engines: &Engines,
        dir: &Path,
        id: &str,
    ) -> AbortOnDrop<Result<turbollm_engine::LoadedModelInfo, EngineError>> {
        let claim = engines.manager().claim_load(target_in(dir, id)).unwrap();
        engines.spawn(claim.run())
    }

    async fn load(
        engines: &Engines,
        dir: &Path,
        id: &str,
    ) -> Result<turbollm_engine::LoadedModelInfo, EngineError> {
        start_load(engines, dir, id).await.unwrap()
    }

    async fn generate(
        engines: &Engines,
    ) -> Result<Result<turbollm_engine::Generation, EngineError>, JoinError> {
        let manager = engines.manager().clone();
        engines
            .spawn(async move { manager.generate(request()).await })
            .await
    }

    fn target_in(dir: &Path, id: &str) -> LoadTarget {
        LoadTarget {
            model_ref: ModelRef::Installed(id.to_owned()),
            id: id.to_owned(),
            format: ModelFormat::Gguf,
            engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
            path: dir.join(format!("{id}.gguf")),
            context_size: None,
            threads: None,
            backend: Backend::Auto,
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

    fn wait_until(what: &str, condition: impl Fn() -> bool) {
        let started = Instant::now();
        while !condition() {
            assert!(started.elapsed() < WAIT_LIMIT, "timed out waiting: {what}");
            std::thread::sleep(POLL);
        }
    }

    async fn wait_until_async(what: &str, condition: impl Fn() -> bool) {
        let started = Instant::now();
        while !condition() {
            assert!(started.elapsed() < WAIT_LIMIT, "timed out waiting: {what}");
            tokio::time::sleep(POLL).await;
        }
    }
}
