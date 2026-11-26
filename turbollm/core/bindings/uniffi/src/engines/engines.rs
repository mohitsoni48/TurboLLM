//! `CoreEngines`, the core Kotlin holds one of per `TurboLLM` instance (arch 3.3, T-11). Every async export
//! runs its work on the core's own runtime and awaits it there (P-3, T-2), or awaits a channel UniFFI's
//! executor can poll; none blocks its caller. Every export first refuses a call from an engine thread (P-17).

use std::future::Future;
use std::path::Path;
use std::sync::{Arc, mpsc};
use std::thread;

use tokio::task::JoinError;
use turbollm_core::engines::{Engines, EnginesConfig};
use turbollm_engine::{
    Engine, EngineError, EngineId, EngineManager, GenerateRequest, InvalidReason, LoadJournal,
    LoadTarget,
};

use crate::engines::claim::CoreLoadClaim;
use crate::engines::dto::{
    CoreEngineConfig, CoreEngineDescriptor, CoreEngineInfo, CoreEngineSnapshot,
    CoreGenerateRequest, CoreLoadTarget, CoreModelFormat, count,
};
use crate::engines::failure::CoreEngineException;
use crate::engines::foreign::{CoreForeignBackend, foreign_engine, refuse_reentry};
use crate::engines::generation::CoreGeneration;

const SHUTDOWN_THREAD_NAME: &str = "turbollm-shutdown";

#[derive(uniffi::Object)]
pub struct CoreEngines {
    engines: Arc<Engines>,
}

#[uniffi::export]
impl CoreEngines {
    /// A core over this build's native engines; given its `predecessor`, it loads nothing before the
    /// predecessor has closed.
    #[uniffi::constructor]
    pub fn new(
        config: CoreEngineConfig,
        predecessor: Option<Arc<CoreEngines>>,
    ) -> Result<Arc<Self>, CoreEngineException> {
        CoreEngines::with_foreign(config, predecessor, Vec::new(), Vec::new(), true)
    }

    /// A core with Kotlin engines, one backend per descriptor, listed after the native ones; a foreign
    /// descriptor whose id equals a native entry replaces that entry.
    #[uniffi::constructor]
    pub fn with_foreign(
        config: CoreEngineConfig,
        predecessor: Option<Arc<CoreEngines>>,
        descriptors: Vec<CoreEngineDescriptor>,
        backends: Vec<Arc<dyn CoreForeignBackend>>,
        include_native: bool,
    ) -> Result<Arc<Self>, CoreEngineException> {
        refuse_reentry()?;
        let config = EnginesConfig::try_from(config)?;
        let foreign = foreign_engines(descriptors, backends)?;
        let preceding = predecessor.as_deref().map(|core| core.engines.as_ref());
        let engines = if include_native {
            Engines::new(config, foreign, preceding)?
        } else {
            Engines::without_native(config, foreign, preceding)?
        };
        Ok(Arc::new(CoreEngines {
            engines: Arc::new(engines),
        }))
    }

    pub fn list(&self) -> Result<Vec<CoreEngineInfo>, CoreEngineException> {
        refuse_reentry()?;
        let hosted = self.manager().catalog().hosted();
        Ok(hosted.into_iter().map(CoreEngineInfo::from).collect())
    }

    /// The engine a model of `format` loads on, or the refusal (ADR-462).
    pub fn resolve(
        &self,
        format: CoreModelFormat,
        requested: Option<String>,
    ) -> Result<String, CoreEngineException> {
        refuse_reentry()?;
        let requested = requested.map(EngineId::new);
        let resolved = self
            .manager()
            .catalog()
            .resolve(format.into(), requested.as_ref())?;
        Ok(resolved.to_string())
    }

    pub fn snapshot(&self) -> Result<CoreEngineSnapshot, CoreEngineException> {
        refuse_reentry()?;
        Ok(self.manager().snapshot().into())
    }

    /// The first snapshot whose revision is above `after_revision`.
    pub async fn next_snapshot(
        &self,
        after_revision: i64,
    ) -> Result<CoreEngineSnapshot, CoreEngineException> {
        refuse_reentry()?;
        let after = count(after_revision, "after_revision")?;
        Ok(self.manager().next_snapshot(after).await.into())
    }

    /// Takes the lifecycle at once (`Loading` is published before this returns) or refuses with
    /// `LoadInProgress`.
    pub fn claim_load(
        &self,
        target: CoreLoadTarget,
    ) -> Result<Arc<CoreLoadClaim>, CoreEngineException> {
        refuse_reentry()?;
        let claim = self.manager().claim_load(LoadTarget::try_from(target)?)?;
        Ok(Arc::new(CoreLoadClaim::new(
            Arc::clone(&self.engines),
            claim,
        )))
    }

    /// Once asked, the unload runs to its end even if this future is dropped.
    pub async fn unload(&self) -> Result<(), CoreEngineException> {
        refuse_reentry()?;
        let manager = self.manager().clone();
        on_core_to_completion(&self.engines, async move { manager.unload().await }).await
    }

    /// Waits for a gate slot; the generation's events are then pulled with `next`.
    pub async fn generate(
        &self,
        request: CoreGenerateRequest,
    ) -> Result<Arc<CoreGeneration>, CoreEngineException> {
        refuse_reentry()?;
        let request = GenerateRequest::try_from(request)?;
        let manager = self.manager().clone();
        let generation = on_core(
            &self.engines,
            async move { manager.generate(request).await },
        )
        .await?;
        Ok(Arc::new(CoreGeneration::new(generation)))
    }

    /// Unloads, then refuses every call with `Closed`; a successor waiting on this core continues. Once
    /// asked, the shutdown runs to its end even if this future is dropped.
    pub async fn shutdown(&self) -> Result<(), CoreEngineException> {
        refuse_reentry()?;
        let manager = self.manager().clone();
        on_core_to_completion(&self.engines, async move {
            manager.shutdown().await;
            Ok(())
        })
        .await
    }
}

impl CoreEngines {
    fn manager(&self) -> &EngineManager {
        self.engines.manager()
    }
}

/// A core destroyed without `shutdown` still shuts down, so a successor waiting for it is never stuck (T-11,
/// increments T8). The shutdown may wait for a claim Kotlin still holds, so it is awaited on a thread of its
/// own, never on the destroying thread (which may be a finaliser).
impl Drop for CoreEngines {
    fn drop(&mut self) {
        let engines = Arc::clone(&self.engines);
        let manager = engines.manager().clone();
        let (closed, on_closed) = mpsc::channel();
        let shutdown = engines.spawn(async move {
            manager.shutdown().await;
            let _ = closed.send(());
        });
        let _ = thread::Builder::new()
            .name(SHUTDOWN_THREAD_NAME.to_owned())
            .spawn(move || {
                let _ = on_closed.recv();
                drop(shutdown);
                drop(engines);
            });
    }
}

/// The crash journal's record of a load the process did not survive, read once.
#[uniffi::export]
pub fn consume_stale_load(journal_path: String) -> Option<String> {
    LoadJournal::consume_stale(Path::new(&journal_path))
}

#[uniffi::export]
pub fn default_thread_count() -> i32 {
    i32::try_from(turbollm_platform::default_thread_count()).unwrap_or(i32::MAX)
}

/// Runs `work` on the core's runtime and awaits it there; dropping the returned future aborts the work.
pub(crate) async fn on_core<T, F>(engines: &Engines, work: F) -> Result<T, CoreEngineException>
where
    F: Future<Output = Result<T, EngineError>> + Send + 'static,
    T: Send + 'static,
{
    answer(engines.spawn(work).await)
}

/// Runs `work` on the core's runtime to its end; dropping the returned future only stops the wait.
async fn on_core_to_completion<T, F>(engines: &Engines, work: F) -> Result<T, CoreEngineException>
where
    F: Future<Output = Result<T, EngineError>> + Send + 'static,
    T: Send + 'static,
{
    answer(engines.spawn_to_completion(work).await)
}

fn answer<T>(
    finished: Result<Result<T, EngineError>, JoinError>,
) -> Result<T, CoreEngineException> {
    let outcome = finished.unwrap_or_else(|stopped| Err(task_stopped(stopped)));
    outcome.map_err(CoreEngineException::from)
}

/// Work the runtime dropped (it was shutting down) reads as a closed core; work that panicked as a failure.
fn task_stopped(stopped: JoinError) -> EngineError {
    match stopped.is_cancelled() {
        true => EngineError::Closed,
        false => EngineError::EngineFailure(stopped.to_string()),
    }
}

fn foreign_engines(
    descriptors: Vec<CoreEngineDescriptor>,
    backends: Vec<Arc<dyn CoreForeignBackend>>,
) -> Result<Vec<Arc<dyn Engine>>, EngineError> {
    if descriptors.len() != backends.len() {
        return Err(unpaired(descriptors.len(), backends.len()));
    }
    let paired = descriptors.into_iter().zip(backends);
    Ok(paired
        .map(|(descriptor, backend)| foreign_engine(descriptor, backend))
        .collect())
}

fn unpaired(descriptors: usize, backends: usize) -> EngineError {
    EngineError::InvalidRequest {
        param: Some("backends".to_owned()),
        reason: InvalidReason::Other,
        message: format!(
            "Each foreign engine needs one backend, but there were {descriptors} descriptors and {backends} backends."
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::sync::{Arc, Barrier};
    use std::task::Poll;
    use std::thread;

    use tempfile::TempDir;
    use turbollm_engine::{MODEL_UNLOADED, REPLY_CANCELLED};

    use super::*;
    use crate::engines::dto::{CoreEngineEvent, CoreEngineState, CoreLoadedModel};
    use crate::engines::failure::{CoreFailure, CoreFailureCode};
    use crate::engines::foreign::REENTRY_REFUSED;
    use crate::engines::test_support::{
        FOREIGN_ENGINE, FakeForeign, Log, Reentry, Reply, config_in, descriptor, done, eventually,
        failure_of, finish, poll_once, prefilled, request, target, text,
    };

    struct Core {
        core: Arc<CoreEngines>,
        log: Arc<Log>,
        _dir: TempDir,
    }

    fn core_with(foreign: FakeForeign) -> Core {
        let dir = TempDir::new().unwrap();
        let log = foreign.log();
        let core = CoreEngines::with_foreign(
            config_in(dir.path()),
            None,
            vec![descriptor(FOREIGN_ENGINE)],
            vec![Arc::new(foreign)],
            false,
        )
        .unwrap();
        Core {
            core,
            log,
            _dir: dir,
        }
    }

    fn replying(events: Vec<CoreEngineEvent>) -> Core {
        core_with(FakeForeign::replying(Reply::Events(events)))
    }

    fn load(core: &CoreEngines, model: &str) -> CoreLoadedModel {
        let claim = core.claim_load(target(model)).unwrap();
        finish(claim.run()).unwrap()
    }

    fn state(core: &CoreEngines) -> CoreEngineState {
        core.snapshot().unwrap().state
    }

    fn code(error: CoreEngineException) -> CoreFailureCode {
        failure_of(error).code
    }

    #[test]
    fn a_claim_publishes_loading_and_its_run_publishes_ready() {
        let c = replying(vec![]);

        let claim = c.core.claim_load(target("org/a")).unwrap();
        assert!(
            matches!(state(&c.core), CoreEngineState::Loading { ref ref_value, .. } if ref_value == "org/a")
        );

        let loaded = finish(claim.run()).unwrap();
        assert_eq!(loaded.engine_id, FOREIGN_ENGINE);
        assert_eq!(loaded.context_size, 2048);
        assert_eq!(loaded.notes, vec!["foreign".to_owned()]);
        let ready = CoreEngineState::Ready {
            model: loaded,
            busy: false,
            queued: 0,
        };
        assert_eq!(state(&c.core), ready);
        assert_eq!(c.log.snapshot(), vec!["open /models/org/a.gguf"]);
    }

    #[test]
    fn a_generation_yields_prefilled_text_and_done_then_none() {
        let c = replying(vec![prefilled(), text("he"), text("llo"), done()]);
        load(&c.core, "org/a");

        let generation = finish(c.core.generate(request())).unwrap();

        let mut events = Vec::new();
        while let Some(event) = finish(generation.next()).unwrap() {
            events.push(event);
        }
        assert_eq!(events, vec![prefilled(), text("he"), text("llo"), done()]);
        assert_eq!(finish(generation.next()).unwrap(), None);
    }

    #[test]
    fn a_cancel_after_done_never_asks_the_foreign_model_to_abort() {
        let c = replying(vec![done()]);
        load(&c.core, "org/a");
        let generation = finish(c.core.generate(request())).unwrap();
        assert_eq!(finish(generation.next()).unwrap(), Some(done()));

        generation.cancel();

        assert!(!c.log.has("request_abort"), "{:?}", c.log.snapshot());
    }

    #[test]
    fn a_dropped_next_future_then_cancel_stops_the_foreign_generate() {
        let c = core_with(FakeForeign::replying(Reply::UntilAborted(
            vec![prefilled()],
        )));
        load(&c.core, "org/a");
        let generation = finish(c.core.generate(request())).unwrap();
        assert_eq!(finish(generation.next()).unwrap(), Some(prefilled()));

        assert!(poll_once(generation.next()).is_pending());
        generation.cancel();

        eventually("the foreign generate to see the abort", || {
            c.log.has("aborted true")
        });
        assert!(c.log.has("request_abort"));
        let cancelled = finish(generation.next()).unwrap_err();
        assert_eq!(failure_of(cancelled).detail, REPLY_CANCELLED);
    }

    #[test]
    fn cancel_from_two_threads_while_next_waits_ends_the_reply_once() {
        let c = core_with(FakeForeign::replying(Reply::UntilAborted(vec![])));
        load(&c.core, "org/a");
        let generation = finish(c.core.generate(request())).unwrap();
        let waiting = {
            let generation = Arc::clone(&generation);
            thread::spawn(move || finish(generation.next()))
        };

        let both = Arc::new(Barrier::new(2));
        let cancellers: Vec<_> = (0..2)
            .map(|_| {
                let (generation, both) = (Arc::clone(&generation), Arc::clone(&both));
                thread::spawn(move || {
                    both.wait();
                    generation.cancel();
                })
            })
            .collect();
        cancellers
            .into_iter()
            .for_each(|canceller| canceller.join().unwrap());

        assert_eq!(
            code(waiting.join().unwrap().unwrap_err()),
            CoreFailureCode::Cancelled
        );
        generation.cancel();
    }

    #[test]
    fn an_event_the_core_cannot_read_fails_the_reply() {
        let negative = CoreEngineEvent::Prefilled {
            prompt_tokens: -1,
            prompt_ms: 0.0,
        };
        let c = replying(vec![negative]);
        load(&c.core, "org/a");
        let generation = finish(c.core.generate(request())).unwrap();

        let refused = failure_of(finish(generation.next()).unwrap_err());

        assert_eq!(refused.code, CoreFailureCode::InvalidRequest);
        assert_eq!(refused.param.as_deref(), Some("prompt_tokens"));
    }

    #[test]
    fn a_second_run_of_one_claim_is_closed() {
        let c = replying(vec![]);
        let claim = c.core.claim_load(target("org/a")).unwrap();
        finish(claim.run()).unwrap();

        assert_eq!(
            code(finish(claim.run()).unwrap_err()),
            CoreFailureCode::Closed
        );
    }

    #[test]
    fn an_abandoned_claim_lets_a_new_claim_in_and_abandoning_again_does_nothing() {
        let c = replying(vec![]);
        let claim = c.core.claim_load(target("org/a")).unwrap();
        assert_eq!(
            code(c.core.claim_load(target("org/b")).err().unwrap()),
            CoreFailureCode::LoadInProgress
        );

        claim.abandon();
        claim.abandon();

        assert_eq!(state(&c.core), CoreEngineState::Idle);
        load(&c.core, "org/b");
    }

    #[test]
    fn a_destroyed_claim_releases_the_lifecycle() {
        let c = replying(vec![]);
        drop(c.core.claim_load(target("org/a")).unwrap());

        load(&c.core, "org/b");
    }

    #[test]
    fn without_native_engines_only_the_foreign_entries_are_listed() {
        let c = replying(vec![]);

        let listed = c.core.list().unwrap();

        assert_eq!(
            listed,
            vec![CoreEngineInfo {
                descriptor: descriptor(FOREIGN_ENGINE),
                unavailable_reason: None,
            }]
        );
        assert_eq!(
            c.core.resolve(CoreModelFormat::Gguf, None).unwrap(),
            FOREIGN_ENGINE
        );
    }

    #[test]
    fn a_core_without_engines_refuses_to_resolve_naming_the_engine() {
        let dir = TempDir::new().unwrap();
        let core = CoreEngines::new(config_in(dir.path()), None).unwrap();

        let refused = failure_of(
            core.resolve(CoreModelFormat::Gguf, Some("nope".to_owned()))
                .unwrap_err(),
        );

        assert_eq!(refused.code, CoreFailureCode::InvalidRequest);
        assert_eq!(refused.detail, "This SDK has no engine named nope.");
        assert!(core.list().unwrap().is_empty());
    }

    #[test]
    fn each_descriptor_needs_exactly_one_backend() {
        let dir = TempDir::new().unwrap();

        let refused = CoreEngines::with_foreign(
            config_in(dir.path()),
            None,
            vec![descriptor("a"), descriptor("b")],
            vec![Arc::new(FakeForeign::replying(Reply::Events(vec![])))],
            false,
        )
        .err()
        .map(failure_of)
        .unwrap();

        assert_eq!(refused.code, CoreFailureCode::InvalidRequest);
        assert_eq!(refused.param.as_deref(), Some("backends"));
        assert_eq!(
            refused.detail,
            "Each foreign engine needs one backend, but there were 2 descriptors and 1 backends."
        );
    }

    #[test]
    fn a_foreign_open_failure_is_published_with_its_code() {
        let failure = CoreFailure::from(EngineError::ContextLengthExceeded("too long".to_owned()));
        let c = core_with(FakeForeign::failing_open(failure));
        let claim = c.core.claim_load(target("org/a")).unwrap();

        let refused = failure_of(finish(claim.run()).unwrap_err());

        assert_eq!(refused.code, CoreFailureCode::ContextLengthExceeded);
        assert!(
            matches!(state(&c.core), CoreEngineState::Failed { failure, .. } if failure.detail == "too long")
        );
    }

    #[test]
    fn next_snapshot_waits_for_a_newer_revision() {
        let c = replying(vec![]);
        let seen = c.core.snapshot().unwrap().revision;
        let waiting = {
            let core = Arc::clone(&c.core);
            thread::spawn(move || finish(core.next_snapshot(seen)))
        };
        assert!(poll_once(c.core.next_snapshot(seen)).is_pending());

        let claim = c.core.claim_load(target("org/a")).unwrap();

        let newer = waiting.join().unwrap().unwrap();
        assert!(newer.revision > seen);
        claim.abandon();
    }

    #[test]
    fn a_negative_revision_is_refused() {
        let c = replying(vec![]);

        let refused = failure_of(finish(c.core.next_snapshot(-1)).unwrap_err());

        assert_eq!(refused.code, CoreFailureCode::InvalidRequest);
        assert_eq!(refused.param.as_deref(), Some("after_revision"));
    }

    #[test]
    fn unload_closes_the_foreign_model_and_ends_idle() {
        let c = replying(vec![]);
        load(&c.core, "org/a");

        finish(c.core.unload()).unwrap();

        assert_eq!(state(&c.core), CoreEngineState::Idle);
        eventually("the foreign model to be released", || c.log.has("release"));
    }

    #[test]
    fn an_unload_whose_future_is_dropped_after_one_poll_still_ends_idle() {
        let c = replying(vec![]);
        load(&c.core, "org/a");

        let _ = poll_once(c.core.unload());

        eventually("Idle", || state(&c.core) == CoreEngineState::Idle);
        eventually("the foreign model to be released", || c.log.has("release"));
    }

    #[test]
    fn a_shutdown_whose_future_is_dropped_after_one_poll_still_ends_closed() {
        let c = replying(vec![]);
        load(&c.core, "org/a");

        let _ = poll_once(c.core.shutdown());

        eventually("Closed", || state(&c.core) == CoreEngineState::Closed);
        assert!(c.log.has("release"));
    }

    #[test]
    fn a_generation_running_when_the_model_unloads_ends_with_the_unload_text() {
        let c = core_with(FakeForeign::replying(Reply::UntilAborted(vec![])));
        load(&c.core, "org/a");
        let generation = finish(c.core.generate(request())).unwrap();

        finish(c.core.unload()).unwrap();

        let ended = failure_of(finish(generation.next()).unwrap_err());
        assert_eq!(
            (ended.code, ended.detail.as_str()),
            (CoreFailureCode::Cancelled, MODEL_UNLOADED)
        );
    }

    #[test]
    fn a_next_already_waiting_when_the_model_unloads_ends_with_the_unload_text() {
        let c = core_with(FakeForeign::replying(Reply::UntilAborted(vec![])));
        load(&c.core, "org/a");
        let generation = finish(c.core.generate(request())).unwrap();
        let mut waiting = pin!(generation.next());
        assert!(poll_once(waiting.as_mut()).is_pending());

        finish(c.core.unload()).unwrap();

        let ended = failure_of(finish(waiting).unwrap_err());
        assert_eq!(
            (ended.code, ended.detail.as_str()),
            (CoreFailureCode::Cancelled, MODEL_UNLOADED)
        );
    }

    #[test]
    fn every_call_after_shutdown_is_closed() {
        let c = replying(vec![]);
        load(&c.core, "org/a");

        finish(c.core.shutdown()).unwrap();

        assert_eq!(state(&c.core), CoreEngineState::Closed);
        assert_eq!(
            code(c.core.claim_load(target("org/b")).err().unwrap()),
            CoreFailureCode::Closed
        );
        assert_eq!(
            code(finish(c.core.generate(request())).err().unwrap()),
            CoreFailureCode::Closed
        );
        assert_eq!(
            code(finish(c.core.unload()).unwrap_err()),
            CoreFailureCode::Closed
        );
        finish(c.core.shutdown()).unwrap();
        assert!(c.log.has("release"));
    }

    #[test]
    fn a_predecessor_destroyed_without_shutdown_still_closes_before_its_successor_loads() {
        let first = replying(vec![]);
        load(&first.core, "org/a");
        let dir = TempDir::new().unwrap();
        let next_engine = FakeForeign::replying(Reply::Events(vec![]));
        let next_log = next_engine.log();
        let successor = CoreEngines::with_foreign(
            config_in(dir.path()),
            Some(Arc::clone(&first.core)),
            vec![descriptor(FOREIGN_ENGINE)],
            vec![Arc::new(next_engine)],
            false,
        )
        .unwrap();

        drop(first.core);

        load(&successor, "org/b");
        assert!(first.log.has("release"));
        assert_eq!(next_log.snapshot(), vec!["open /models/org/b.gguf"]);
    }

    #[test]
    fn a_foreign_generate_that_calls_back_into_the_core_is_refused_at_once() {
        let reentry = Arc::new(Reentry::default());
        let c = core_with(
            FakeForeign::replying(Reply::Events(vec![done()])).reentering(&reentry, false),
        );
        reentry.aim_at(&c.core);
        load(&c.core, "org/a");

        let generation = finish(c.core.generate(request())).unwrap();
        assert_eq!(finish(generation.next()).unwrap(), Some(done()));

        assert_every_export_refused(&reentry);
        assert!(
            c.core.list().is_ok(),
            "the same call from a normal thread is served"
        );
    }

    #[test]
    fn a_foreign_open_that_calls_back_into_the_core_is_refused_at_once() {
        let reentry = Arc::new(Reentry::default());
        let c = core_with(FakeForeign::replying(Reply::Events(vec![])).reentering(&reentry, true));
        reentry.aim_at(&c.core);

        load(&c.core, "org/a");

        assert_every_export_refused(&reentry);
    }

    fn assert_every_export_refused(reentry: &Reentry) {
        let answers = reentry.answers();
        assert_eq!(answers.len(), 8, "{answers:?}");
        for (export, answer) in answers {
            let Poll::Ready(Some(failure)) = answer else {
                panic!("{export} was not refused at once: {answer:?}");
            };
            assert_eq!(failure.code, CoreFailureCode::EngineFailure, "{export}");
            assert_eq!(failure.detail, REENTRY_REFUSED, "{export}");
        }
    }

    #[test]
    fn a_task_that_panics_on_the_core_runtime_reads_as_an_engine_failure() {
        let dir = TempDir::new().unwrap();
        let config = EnginesConfig::try_from(config_in(dir.path())).unwrap();
        let engines = Engines::new(config, Vec::new(), None).unwrap();

        let failed = finish(on_core::<(), _>(&engines, async { panic!("boom") })).unwrap_err();

        let failure = failure_of(failed);
        assert_eq!(failure.code, CoreFailureCode::EngineFailure);
        assert!(failure.detail.contains("boom"), "{}", failure.detail);
    }

    #[test]
    fn a_stale_load_is_read_once_from_the_journal() {
        let dir = TempDir::new().unwrap();
        let journal = LoadJournal::path_in(dir.path());
        LoadJournal::new(journal.clone(), "dead-core".to_owned())
            .write(Path::new("/models/crashed.gguf"));
        let journal_path = journal.to_string_lossy().into_owned();

        let stale = consume_stale_load(journal_path.clone()).expect("a stale record");

        assert!(stale.ends_with("crashed.gguf"), "{stale}");
        assert_eq!(consume_stale_load(journal_path), None);
    }

    #[test]
    fn the_default_thread_count_is_the_platforms() {
        let count = default_thread_count();
        assert_eq!(
            u32::try_from(count).unwrap(),
            turbollm_platform::default_thread_count()
        );
    }
}
