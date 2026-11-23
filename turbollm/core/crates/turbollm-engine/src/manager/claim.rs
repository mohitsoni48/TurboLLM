//! A claimed load: the lifecycle lock is held from `claim_load` until the load ends, is abandoned,
//! or its claim or `run` future is dropped (T-4).

use std::path::Path;

use tokio::sync::OwnedMutexGuard;
use turbollm_platform::default_thread_count;

use crate::descriptor::LoadedModelInfo;
use crate::engine::{AbortSignal, Engine, LoadControl, LoadedModel};
use crate::error::EngineError;
use crate::ids::EngineKind;
use crate::manager::{EngineManager, EngineState, LoadJournal, StallWatch};
use crate::request::{LoadSpec, LoadTarget};

/// The right to run one load. Dropping it unrun is the same as `abandon`.
pub struct LoadClaim {
    manager: EngineManager,
    target: LoadTarget,
    lifecycle: Option<OwnedMutexGuard<()>>,
}

impl LoadClaim {
    pub(super) fn new(
        manager: EngineManager,
        target: LoadTarget,
        lifecycle: OwnedMutexGuard<()>,
    ) -> LoadClaim {
        LoadClaim {
            manager,
            target,
            lifecycle: Some(lifecycle),
        }
    }

    /// Runs the load: waits for the predecessor, closes the resident model, opens the new one.
    /// The outcome (`Ready` or `Failed`) is published before the lifecycle is released.
    pub async fn run(mut self) -> Result<LoadedModelInfo, EngineError> {
        let loaded = self.load().await;
        let lifecycle = self.lifecycle.take();
        if let Err(failure) = &loaded {
            let failed = EngineState::Failed(self.target.model_ref.clone(), failure.clone());
            self.manager.shared.snapshots.publish(failed);
        }
        drop(lifecycle);
        loaded
    }

    /// Releases the lifecycle without loading.
    pub fn abandon(self) {}

    async fn load(&self) -> Result<LoadedModelInfo, EngineError> {
        self.manager.await_predecessor_closed().await;
        self.manager.unload_resident().await;
        let engine = self.manager.shared.catalog.engine(&self.target.engine)?;
        let model = self
            .open(engine.as_ref())
            .await
            .map_err(|failure| self.reported(failure))?;
        let kind = engine.descriptor().kind;
        self.manager.install(&self.target, kind, model).await
    }

    /// Opens the model under the journal and the stall watch; a dropped open is aborted.
    async fn open(&self, engine: &dyn Engine) -> Result<Box<dyn LoadedModel>, EngineError> {
        let shared = &self.manager.shared;
        let abort = AbortOnDrop::arm(AbortSignal::new());
        let watch = StallWatch::start(engine.stall_policy(), shared.stall, abort.signal());
        let ctl = LoadControl {
            progress: watch.progress_listener(),
            abort: abort.signal(),
        };
        let _journal = JournalMark::write(shared.journal.as_ref(), &self.target.path);
        let opened = engine.load(self.spec(), ctl).await;
        abort.disarm();
        opened.map_err(|failure| watch.stall_failure().unwrap_or(failure))
    }

    fn spec(&self) -> LoadSpec {
        LoadSpec {
            path: self.target.path.clone(),
            context_size: self.target.context_size,
            threads: self.target.threads.unwrap_or_else(default_thread_count),
            backend: self.target.backend,
            cache_dir: self.manager.shared.cache_dir.clone(),
        }
    }

    /// The failure a load is published with. An engine that cannot run here stays unavailable
    /// and the refusal names the engine the load asked for (`EngineHost.kt:132-147`); a stop the
    /// public state cannot carry is a load failure with its text (PG-4).
    fn reported(&self, failure: EngineError) -> EngineError {
        match failure {
            EngineError::EngineUnavailable { kind, reason, .. } => {
                self.marked_unavailable(kind, reason)
            }
            EngineError::Cancelled(text) => EngineError::ModelLoadFailed(text),
            EngineError::Closed => EngineError::ModelLoadFailed(EngineError::Closed.to_string()),
            other => other,
        }
    }

    fn marked_unavailable(&self, kind: EngineKind, reason: String) -> EngineError {
        let engine = self.target.engine.clone();
        self.manager
            .shared
            .catalog
            .mark_unavailable(&engine, reason.clone());
        EngineError::EngineUnavailable {
            engine,
            kind,
            reason,
        }
    }
}

/// A claim abandoned, or a `run` future dropped, before the load ended shows the resident model
/// again, or `Idle`, and only then lets the next claim in.
impl Drop for LoadClaim {
    fn drop(&mut self) {
        if let Some(lifecycle) = self.lifecycle.take() {
            self.manager.show_resident_or_idle();
            drop(lifecycle);
        }
    }
}

/// Aborts a load whose future was dropped before the open answered.
struct AbortOnDrop {
    signal: Option<AbortSignal>,
}

impl AbortOnDrop {
    fn arm(signal: AbortSignal) -> AbortOnDrop {
        AbortOnDrop {
            signal: Some(signal),
        }
    }

    fn signal(&self) -> AbortSignal {
        self.signal.clone().unwrap_or_default()
    }

    fn disarm(mut self) {
        self.signal = None;
    }
}

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(signal) = &self.signal {
            signal.abort();
        }
    }
}

/// The crash journal record of one open, cleared however the open ends (E-34). A record that
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
