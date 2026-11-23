//! The load task: everything a claimed load does under the lifecycle. It runs to its end even when
//! its caller stops waiting (arch 2.3.5 "`run` future dropped": the open is aborted or finishes, any
//! model it got is closed, the journal is cleared, and only then is the lifecycle released).

use std::path::Path;

use tokio::sync::OwnedMutexGuard;
use turbollm_platform::default_thread_count;

use crate::descriptor::LoadedModelInfo;
use crate::engine::{AbortSignal, Engine, LoadControl, LoadedModel};
use crate::error::EngineError;
use crate::ids::EngineKind;
use crate::manager::{EngineManager, EngineState, LoadJournal, StallWatch, under_lifecycle};
use crate::request::{LoadSpec, LoadTarget};

/// What an abandoned load ends with; its caller is gone, so nobody reads it.
const LOAD_ABANDONED: &str = "The load was abandoned: its caller stopped waiting.";

impl EngineManager {
    /// Loads `target` in a task that keeps `lifecycle` until the load fully ended. `abandoned` is
    /// raised once the caller stopped waiting: the load then shows the resident model, or `Idle`,
    /// instead of an outcome.
    pub(super) async fn load_under(
        &self,
        lifecycle: OwnedMutexGuard<()>,
        target: LoadTarget,
        abandoned: AbortSignal,
    ) -> Result<LoadedModelInfo, EngineError> {
        let manager = self.clone();
        under_lifecycle(lifecycle, async move {
            manager.load_and_publish(&target, &abandoned).await
        })
        .await
    }

    async fn load_and_publish(
        &self,
        target: &LoadTarget,
        abandoned: &AbortSignal,
    ) -> Result<LoadedModelInfo, EngineError> {
        let loaded = self.load(target, abandoned).await;
        match &loaded {
            _ if abandoned.is_aborted() => self.show_resident_or_idle(),
            Err(failure) => self.publish_failed(target, failure),
            Ok(_) => {}
        }
        loaded
    }

    /// The crash journal covers the native open and the close of a model nobody waits for any more.
    async fn load(
        &self,
        target: &LoadTarget,
        abandoned: &AbortSignal,
    ) -> Result<LoadedModelInfo, EngineError> {
        self.await_predecessor_closed().await;
        self.unload_resident().await;
        let engine = self.shared.catalog.engine(&target.engine)?;
        let _journal = JournalMark::write(self.shared.journal.as_ref(), &target.path);
        let model = self
            .open_watched(engine.as_ref(), target, abandoned)
            .await
            .map_err(|failure| self.reported(target, failure))?;
        if abandoned.is_aborted() {
            model.close().await;
            return Err(EngineError::Cancelled(LOAD_ABANDONED.to_owned()));
        }
        let kind = engine.descriptor().kind;
        self.install(target, kind, model).await
    }

    /// Opens the model under the stall watch; the caller leaving aborts the open too.
    async fn open_watched(
        &self,
        engine: &dyn Engine,
        target: &LoadTarget,
        abandoned: &AbortSignal,
    ) -> Result<Box<dyn LoadedModel>, EngineError> {
        let abort = AbortSignal::new();
        abandoned.add_hook(abort.relay());
        let watch = StallWatch::start(engine.stall_policy(), self.shared.stall, abort.clone());
        let ctl = LoadControl {
            progress: watch.progress_listener(),
            abort,
        };
        let opened = engine.load(self.load_spec_for(target), ctl).await;
        opened.map_err(|failure| watch.stall_failure().unwrap_or(failure))
    }

    fn load_spec_for(&self, target: &LoadTarget) -> LoadSpec {
        LoadSpec {
            path: target.path.clone(),
            context_size: target.context_size,
            threads: target.threads.unwrap_or_else(default_thread_count),
            backend: target.backend,
            cache_dir: self.shared.cache_dir.clone(),
        }
    }

    fn publish_failed(&self, target: &LoadTarget, failure: &EngineError) {
        let failed = EngineState::Failed(target.model_ref.clone(), failure.clone());
        self.shared.snapshots.publish(failed);
    }

    /// The failure a load is published with. An engine that cannot run here stays unavailable
    /// and the refusal names the engine the load asked for (`EngineHost.kt:132-147`); a stop the
    /// public state cannot carry is a load failure with its text (PG-4).
    fn reported(&self, target: &LoadTarget, failure: EngineError) -> EngineError {
        match failure {
            EngineError::EngineUnavailable { kind, reason, .. } => {
                self.mark_unavailable(target, kind, reason)
            }
            EngineError::Cancelled(text) => EngineError::ModelLoadFailed(text),
            EngineError::Closed => EngineError::ModelLoadFailed(EngineError::Closed.to_string()),
            other => other,
        }
    }

    fn mark_unavailable(
        &self,
        target: &LoadTarget,
        kind: EngineKind,
        reason: String,
    ) -> EngineError {
        let engine = target.engine.clone();
        self.shared
            .catalog
            .mark_unavailable(&engine, reason.clone());
        EngineError::EngineUnavailable {
            engine,
            kind,
            reason,
        }
    }
}

/// The crash journal record of one load, cleared however the load ends (E-34). A record that
/// could not be written is never cleared, as `EngineHost.kt:149-160` does.
struct JournalMark<'journal> {
    written: Option<&'journal LoadJournal>,
}

impl<'journal> JournalMark<'journal> {
    fn write(journal: Option<&'journal LoadJournal>, model_path: &Path) -> JournalMark<'journal> {
        JournalMark {
            written: journal.filter(|journal| journal.write(model_path)),
        }
    }
}

impl Drop for JournalMark<'_> {
    fn drop(&mut self) {
        if let Some(journal) = self.written {
            journal.clear();
        }
    }
}
