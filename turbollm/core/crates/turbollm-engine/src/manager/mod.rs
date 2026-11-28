mod claim;
mod gate;
mod generation;
mod journal;
mod load;
mod stall;
mod state;

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::catalog::Catalog;
use crate::descriptor::LoadedModelInfo;
use crate::engine::LoadedModel;
use crate::error::EngineError;
use crate::ids::EngineKind;
use crate::request::{GenerateRequest, LoadTarget};

pub use claim::LoadClaim;
pub use gate::{GatePermit, GenerationGate, OccupancyListener};
pub use generation::{Generation, GenerationCanceller};
pub use journal::LoadJournal;
pub use stall::{ProgressListener, StallWatch};
pub use state::{EngineState, Snapshot};

use generation::ActiveGenerations;
use state::Snapshots;

/// `TurboLLMException.kt:59`: a generation asked for while no model is resident.
pub const MODEL_NOT_LOADED: &str = "The model is not loaded.";

/// `LlamaCppEngine.kt:54`, `LiteRtLmEngine.kt:50`: a second model offered to an engine holding one.
pub const ALREADY_HOLDS_A_MODEL: &str = "This engine already holds a model.";

/// What one manager is built from.
pub struct ManagerConfig {
    pub catalog: Catalog,
    pub journal: Option<LoadJournal>,
    pub predecessor: Option<EngineManager>,
    /// The load stall window (ADR-460); zero turns the watch off.
    pub stall: Duration,
    pub max_queued: usize,
    pub cache_dir: PathBuf,
}

/// Loads, unloads and serves one resident model (ADR-455 point 2) with the Kotlin `EngineHost`
/// behaviour (arch 2.3.5). Cheap to clone; clones share one manager.
#[derive(Clone)]
pub struct EngineManager {
    shared: Arc<Shared>,
}

struct Shared {
    catalog: Catalog,
    lifecycle: Arc<Mutex<()>>,
    /// Held while a finished lifecycle publishes its outcome and lets go, and while a claim takes
    /// the lifecycle: a state read as an outcome is then never followed by a refusal for it.
    handoff: StdMutex<()>,
    resident: StdMutex<Option<Resident>>,
    snapshots: Arc<Snapshots>,
    journal: Option<LoadJournal>,
    /// Only the predecessor's published states: holding its manager would keep its catalogue (and
    /// any Kotlin engine handles in it) and its own predecessor alive for this manager's life.
    predecessor_states: Option<Arc<Snapshots>>,
    stall: Duration,
    max_queued: usize,
    cache_dir: PathBuf,
    epochs: AtomicU64,
}

/// The one model a manager holds, with its gate and the generations running on it.
struct Resident {
    epoch: u64,
    info: LoadedModelInfo,
    model: Box<dyn LoadedModel>,
    gate: Arc<GenerationGate>,
    generations: ActiveGenerations,
}

impl EngineManager {
    pub fn new(config: ManagerConfig) -> EngineManager {
        EngineManager {
            shared: Arc::new(Shared {
                catalog: config.catalog,
                lifecycle: Arc::new(Mutex::new(())),
                handoff: StdMutex::new(()),
                resident: StdMutex::new(None),
                snapshots: Arc::new(Snapshots::new()),
                journal: config.journal,
                predecessor_states: config
                    .predecessor
                    .map(|predecessor| Arc::clone(&predecessor.shared.snapshots)),
                stall: config.stall,
                max_queued: config.max_queued,
                cache_dir: config.cache_dir,
                epochs: AtomicU64::new(0),
            }),
        }
    }

    pub fn catalog(&self) -> &Catalog {
        &self.shared.catalog
    }

    pub fn snapshot(&self) -> Snapshot {
        self.shared.snapshots.current()
    }

    /// How many waits on this manager's snapshots are parked, a successor's barrier (T-11) among
    /// them; lets a test see a waiter in place before it asserts what that waiter has not done.
    #[cfg(any(test, feature = "testing"))]
    pub fn parked_snapshot_waiters(&self) -> usize {
        self.shared.snapshots.parked_waiters()
    }

    /// The first snapshot whose revision is above `after_revision`.
    pub async fn next_snapshot(&self, after_revision: u64) -> Snapshot {
        self.shared.snapshots.after(after_revision).await
    }

    /// Takes the lifecycle at once or refuses with `LoadInProgress` (`EngineHost.kt:92-95`);
    /// `Loading` is published before this returns.
    pub fn claim_load(&self, target: LoadTarget) -> Result<LoadClaim, EngineError> {
        self.refuse_when_closed()?;
        let _handoff = self.handoff();
        let lifecycle = Arc::clone(&self.shared.lifecycle)
            .try_lock_owned()
            .map_err(|_held| EngineError::LoadInProgress)?;
        self.refuse_when_closed()?;
        let loading = EngineState::Loading(target.model_ref.clone());
        self.shared.snapshots.publish(loading);
        Ok(LoadClaim::new(self.clone(), target, lifecycle))
    }

    /// Cancels the resident model's generations, waits for their native calls, closes the model.
    /// Waits for a running load first.
    /// Once it holds the lifecycle, a dropped future no longer stops it.
    pub async fn unload(&self) -> Result<(), EngineError> {
        self.refuse_when_closed()?;
        let lifecycle = self.lifecycle().await;
        self.refuse_when_closed()?;
        let manager = self.clone();
        under_lifecycle(lifecycle, |lifecycle| async move {
            manager.unload_resident().await;
            manager.settle(lifecycle, || {
                manager.shared.snapshots.publish(EngineState::Idle);
            });
            Ok(())
        })
        .await
    }

    /// The gate first, then the resident check (`ChatService.kt:51-60`). With nothing resident
    /// there is no gate to queue at, so even a full queue reads `ModelNotLoaded` (E-4).
    pub async fn generate(&self, req: GenerateRequest) -> Result<Generation, EngineError> {
        self.refuse_when_closed()?;
        let gate = self.resident_gate()?;
        let permit = gate.acquire().await?;
        self.start_generation(&gate, req, permit)
    }

    /// Unloads, then refuses everything with `Closed`; a successor waiting on it continues. Once it
    /// holds the lifecycle, a dropped future no longer stops it.
    pub async fn shutdown(&self) {
        let lifecycle = self.lifecycle().await;
        if self.shared.snapshots.is_closed() {
            return;
        }
        let manager = self.clone();
        let closing = under_lifecycle(lifecycle, |lifecycle| async move {
            manager.unload_resident().await;
            manager.settle(lifecycle, || {
                manager.shared.snapshots.publish(EngineState::Closed);
            });
            Ok(())
        });
        // Its only failure is a runtime that dropped the task, which leaves nothing to close.
        let _ = closing.await;
    }

    fn lifecycle(&self) -> impl Future<Output = OwnedMutexGuard<()>> + use<> {
        Arc::clone(&self.shared.lifecycle).lock_owned()
    }

    /// Publishes the outcome that ends a lifecycle and releases the lifecycle in one step for
    /// `claim_load`: a claim that finds the outcome published finds the lifecycle free.
    fn settle(&self, lifecycle: OwnedMutexGuard<()>, publish: impl FnOnce()) {
        let _handoff = self.handoff();
        publish();
        drop(lifecycle);
    }

    fn handoff(&self) -> MutexGuard<'_, ()> {
        self.shared
            .handoff
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn refuse_when_closed(&self) -> Result<(), EngineError> {
        match self.shared.snapshots.is_closed() {
            true => Err(EngineError::Closed),
            false => Ok(()),
        }
    }

    fn resident_gate(&self) -> Result<Arc<GenerationGate>, EngineError> {
        self.resident()
            .as_ref()
            .map(|resident| Arc::clone(&resident.gate))
            .ok_or_else(|| EngineError::ModelNotLoaded(MODEL_NOT_LOADED.to_owned()))
    }

    /// Registers the generation and hands it to the model, unless the model it queued for was
    /// unloaded meanwhile.
    fn start_generation(
        &self,
        gate: &Arc<GenerationGate>,
        req: GenerateRequest,
        permit: GatePermit,
    ) -> Result<Generation, EngineError> {
        let resident = self.resident();
        let Some(serving) = resident
            .as_ref()
            .filter(|held| Arc::ptr_eq(&held.gate, gate))
        else {
            drop(resident);
            drop(permit);
            return Err(EngineError::queued_request_unloaded());
        };
        let registration = serving.generations.register();
        let events = serving
            .model
            .generate(req, permit, registration.abort_signal())?;
        Ok(Generation::new(events, registration))
    }

    async fn await_predecessor_closed(&self) {
        if let Some(states) = &self.shared.predecessor_states {
            states.reached_closed().await;
        }
    }

    /// Closes the resident model, if any, after its generations ended (`EngineHost.kt:162-169`).
    /// The published state is left as it was until the model is gone.
    async fn unload_resident(&self) {
        let leaving = self.resident().take();
        if let Some(resident) = leaving {
            resident.close().await;
        }
    }

    /// Makes `model` the resident with a fresh gate; the load publishes it `Ready` as it ends.
    async fn install(
        &self,
        target: &LoadTarget,
        kind: EngineKind,
        model: Box<dyn LoadedModel>,
    ) -> Result<LoadedModelInfo, EngineError> {
        let arriving = self.resident_for(target, kind, model);
        let info = arriving.info.clone();
        let refused = take_residence(&mut self.resident(), arriving);
        match refused {
            Ok(()) => Ok(info),
            Err((rejected, failure)) => {
                rejected.close().await;
                Err(failure)
            }
        }
    }

    fn resident_for(
        &self,
        target: &LoadTarget,
        kind: EngineKind,
        model: Box<dyn LoadedModel>,
    ) -> Resident {
        let epoch = self.shared.epochs.fetch_add(1, Ordering::SeqCst) + 1;
        let snapshots = Arc::clone(&self.shared.snapshots);
        let slots = model.slots();
        let max_queued = self.shared.max_queued;
        let gate = Arc::new_cyclic(|gate: &Weak<GenerationGate>| {
            let listener = occupancy_listener(snapshots, epoch, Weak::clone(gate));
            GenerationGate::new(slots, max_queued, listener)
        });
        Resident {
            epoch,
            info: loaded_model_info(target, kind, model.as_ref()),
            model,
            gate,
            generations: ActiveGenerations::default(),
        }
    }

    /// Publishes the resident model `Ready`, or `Idle` when none is held.
    fn show_resident_or_idle(&self) {
        let snapshots = &self.shared.snapshots;
        match &*self.resident() {
            Some(held) => snapshots.publish_ready(held.epoch, held.info.clone(), held.occupancy()),
            None => snapshots.publish(EngineState::Idle),
        }
    }

    fn resident(&self) -> MutexGuard<'_, Option<Resident>> {
        self.shared
            .resident
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Resident {
    fn occupancy(&self) -> (bool, usize) {
        (self.gate.busy(), self.gate.queued())
    }

    /// Ends every generation with the unload text, waits for their native calls, frees the model.
    async fn close(self) {
        self.generations.cancel_for_unload();
        self.gate.close();
        self.gate.await_idle().await;
        self.model.close().await;
    }
}

/// Runs `work` in a task of its own that owns `lifecycle` and releases it, through `settle` once it
/// has an outcome to show, or when the work ends or is dropped: a caller that
/// stops waiting stops only its wait (arch 2.3.5). Work the runtime dropped while shutting down
/// reads `Closed`.
async fn under_lifecycle<T, W, F>(lifecycle: OwnedMutexGuard<()>, work: F) -> Result<T, EngineError>
where
    F: FnOnce(OwnedMutexGuard<()>) -> W,
    W: Future<Output = Result<T, EngineError>> + Send + 'static,
    T: Send + 'static,
{
    let task = tokio::spawn(work(lifecycle));
    match task.await {
        Ok(ended) => ended,
        Err(stopped) if stopped.is_panic() => std::panic::resume_unwind(stopped.into_panic()),
        Err(_cancelled) => Err(EngineError::Closed),
    }
}

/// Keeps the snapshot's `busy` and `queued` live while this gate's model is the resident one
/// (`EngineHost.kt:76-79`).
fn occupancy_listener(
    snapshots: Arc<Snapshots>,
    epoch: u64,
    gate: Weak<GenerationGate>,
) -> OccupancyListener {
    Box::new(move || {
        if let Some(gate) = gate.upgrade() {
            snapshots.show_occupancy(epoch, || (gate.busy(), gate.queued()));
        }
    })
}

fn loaded_model_info(
    target: &LoadTarget,
    kind: EngineKind,
    model: &dyn LoadedModel,
) -> LoadedModelInfo {
    LoadedModelInfo {
        id: target.id.clone(),
        path: std::path::absolute(&target.path).unwrap_or_else(|_| target.path.clone()),
        format: target.format,
        engine: target.engine.clone(),
        kind,
        info: model.info().clone(),
    }
}

/// Puts `arriving` in an empty slot. A slot that already holds a model refuses it, as an engine
/// holding one refuses a second (`LlamaCppEngine.kt:54`), and hands it back to be closed.
fn take_residence<T>(slot: &mut Option<T>, arriving: T) -> Result<(), (T, EngineError)> {
    if slot.is_some() {
        let failure = EngineError::ModelLoadFailed(ALREADY_HOLDS_A_MODEL.to_owned());
        return Err((arriving, failure));
    }
    *slot = Some(arriving);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_slot_takes_the_arriving_model() {
        let mut slot = None;

        assert!(take_residence(&mut slot, 7).is_ok());

        assert_eq!(slot, Some(7));
    }

    #[test]
    fn a_slot_holding_a_model_refuses_another_with_the_kotlin_text() {
        let mut slot = Some(1);

        let (refused, failure) = take_residence(&mut slot, 2).unwrap_err();

        assert_eq!((refused, slot), (2, Some(1)));
        assert_eq!(
            failure,
            EngineError::ModelLoadFailed(ALREADY_HOLDS_A_MODEL.to_owned())
        );
        assert_eq!(failure.to_string(), "This engine already holds a model.");
    }
}
