//! A claimed load: the lifecycle lock is held from `claim_load` until the load ends or the claim is
//! abandoned (T-4). A `run` future dropped mid-load only stops waiting; the load itself ends under
//! the lifecycle in the manager's load task (arch 2.3.5).

use tokio::sync::OwnedMutexGuard;

use crate::descriptor::LoadedModelInfo;
use crate::engine::AbortSignal;
use crate::error::EngineError;
use crate::manager::EngineManager;
use crate::request::LoadTarget;

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

    /// Runs the load: waits for the predecessor, closes the resident model, opens the new one. The
    /// outcome (`Ready` or `Failed`) is published before the lifecycle is released. Dropping this
    /// future aborts the open; the load still closes any model it got before it lets the next claim in.
    pub async fn run(mut self) -> Result<LoadedModelInfo, EngineError> {
        let lifecycle = self
            .lifecycle
            .take()
            .expect("a claim holds the lifecycle until it runs");
        let caller = AbortOnDrop::arm(AbortSignal::new());
        let loaded = self
            .manager
            .load_under(lifecycle, self.target.clone(), caller.signal())
            .await;
        caller.disarm();
        loaded
    }

    /// Releases the lifecycle without loading.
    pub fn abandon(self) {}
}

/// A claim abandoned, or dropped, before it ran shows the resident model again, or `Idle`, and only
/// then lets the next claim in.
impl Drop for LoadClaim {
    fn drop(&mut self) {
        if let Some(lifecycle) = self.lifecycle.take() {
            self.manager.show_resident_or_idle();
            drop(lifecycle);
        }
    }
}

/// Tells the load task its caller stopped waiting.
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
