//! What the manager publishes: one `Snapshot` per transition and per gate change, in a watch.

use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::watch;

use crate::descriptor::LoadedModelInfo;
use crate::error::EngineError;
use crate::ids::ModelRef;

/// The resident model's life as callers see it (arch 2.3.5). An unload in progress still reads
/// `Ready`; there is no published `Unloading`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    Idle,
    Loading(ModelRef),
    Ready {
        model: LoadedModelInfo,
        busy: bool,
        queued: usize,
    },
    Failed(ModelRef, EngineError),
    Closed,
}

/// The state with its revision, which rises by one on every published change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub revision: u64,
    pub state: EngineState,
}

/// The watch the manager publishes into. `ready_epoch` names the resident whose gate may update
/// a `Ready` state, so a closed model's gate can never overwrite its successor's occupancy.
pub(super) struct Snapshots {
    current: watch::Sender<Snapshot>,
    ready_epoch: AtomicU64,
}

impl Snapshots {
    pub(super) fn new() -> Snapshots {
        Snapshots {
            current: watch::Sender::new(Snapshot {
                revision: 0,
                state: EngineState::Idle,
            }),
            ready_epoch: AtomicU64::new(0),
        }
    }

    pub(super) fn current(&self) -> Snapshot {
        self.current.borrow().clone()
    }

    pub(super) fn is_closed(&self) -> bool {
        self.current.borrow().state == EngineState::Closed
    }

    /// How many waits on these snapshots are parked right now.
    #[cfg(any(test, feature = "testing"))]
    pub(super) fn parked_waiters(&self) -> usize {
        self.current.receiver_count()
    }

    /// The first snapshot whose revision is above `revision`.
    pub(super) async fn after(&self, revision: u64) -> Snapshot {
        self.first_matching(|snapshot| snapshot.revision > revision)
            .await
    }

    /// Returns once this manager has published `Closed` (the successor's barrier, T-11).
    pub(super) async fn reached_closed(&self) {
        self.first_matching(|snapshot| snapshot.state == EngineState::Closed)
            .await;
    }

    /// Publishes `state` as a new revision; publishing the state already shown changes nothing.
    pub(super) fn publish(&self, state: EngineState) {
        self.current.send_if_modified(|snapshot| {
            let changed = snapshot.state != state;
            if changed {
                next_revision(snapshot, state);
            }
            changed
        });
    }

    /// Publishes the resident model of `epoch` as `Ready` with its gate's occupancy.
    pub(super) fn publish_ready(
        &self,
        epoch: u64,
        model: LoadedModelInfo,
        (busy, queued): (bool, usize),
    ) {
        self.current.send_modify(|snapshot| {
            self.ready_epoch.store(epoch, Ordering::SeqCst);
            next_revision(
                snapshot,
                EngineState::Ready {
                    model,
                    busy,
                    queued,
                },
            );
        });
    }

    /// Re-reads the gate of the resident of `epoch` into its `Ready` state, as a new revision only
    /// when `busy` or `queued` changed. Reading under the watch's lock keeps the last reader's
    /// values, so concurrent gate changes cannot leave a stale count behind.
    pub(super) fn show_occupancy(&self, epoch: u64, read_gate: impl Fn() -> (bool, usize)) {
        self.current.send_if_modified(|snapshot| {
            if self.ready_epoch.load(Ordering::SeqCst) != epoch {
                return false;
            }
            let EngineState::Ready { busy, queued, .. } = &mut snapshot.state else {
                return false;
            };
            let now = read_gate();
            let changed = (*busy, *queued) != now;
            if changed {
                (*busy, *queued) = now;
                snapshot.revision += 1;
            }
            changed
        });
    }

    async fn first_matching(&self, wanted: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let mut watching = self.current.subscribe();
        let seen = watching.wait_for(|snapshot| wanted(snapshot)).await;
        seen.map(|snapshot| snapshot.clone())
            .unwrap_or_else(|_sender_gone| self.current())
    }
}

fn next_revision(snapshot: &mut Snapshot, state: EngineState) {
    snapshot.revision += 1;
    snapshot.state = state;
}
