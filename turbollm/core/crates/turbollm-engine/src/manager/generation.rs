//! One running generation and the registry an unload cancels through.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::engine::{AbortSignal, EventStream};
use crate::error::{EngineError, MODEL_UNLOADED};
use crate::event::EngineEvent;

/// A generation's event stream. `cancel` stops it; dropping it before its end does the same.
pub struct Generation {
    events: EventStream,
    registration: Registration,
    finished: bool,
}

impl Generation {
    pub(super) fn new(events: EventStream, registration: Registration) -> Generation {
        Generation {
            events,
            registration,
            finished: false,
        }
    }

    /// The next event; `None` once the stream has ended. A generation an unload cancelled ends
    /// with `Cancelled("The model was unloaded.")` (`EngineHost.kt:165`).
    pub async fn next(&mut self) -> Result<Option<EngineEvent>, EngineError> {
        if self.registration.cancelled_by_unload() {
            return self.end(Err(unloaded()));
        }
        let item = std::future::poll_fn(|cx| self.events.as_mut().poll_next(cx)).await;
        if self.registration.cancelled_by_unload() {
            return self.end(Err(unloaded()));
        }
        match item {
            Some(Ok(done @ EngineEvent::Done { .. })) => self.end(Ok(Some(done))),
            Some(Ok(event)) => Ok(Some(event)),
            Some(Err(failure)) => self.end(Err(failure)),
            None => self.end(Ok(None)),
        }
    }

    /// Asks the engine to stop this reply; safe from any thread, any number of times.
    pub fn cancel(&self) {
        self.registration.signal.abort();
    }

    /// The signal `cancel` raises, for a caller that cancels while another task awaits `next`.
    pub fn cancel_signal(&self) -> AbortSignal {
        self.registration.abort_signal()
    }

    fn end(
        &mut self,
        outcome: Result<Option<EngineEvent>, EngineError>,
    ) -> Result<Option<EngineEvent>, EngineError> {
        self.finished = true;
        outcome
    }
}

/// A reply that already ended is never aborted afterwards (`ChatService.kt:72-75`).
impl Drop for Generation {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel();
        }
    }
}

fn unloaded() -> EngineError {
    EngineError::Cancelled(MODEL_UNLOADED.to_owned())
}

/// The generations running on one resident model.
#[derive(Clone, Default)]
pub(super) struct ActiveGenerations {
    running: Arc<Mutex<Running>>,
}

#[derive(Default)]
struct Running {
    next_id: u64,
    by_id: BTreeMap<u64, ActiveGeneration>,
}

#[derive(Clone, Default)]
struct ActiveGeneration {
    abort: AbortSignal,
    cancelled_by_unload: Arc<AtomicBool>,
}

/// A generation's place in the registry, given up when it is dropped.
pub(super) struct Registration {
    generations: ActiveGenerations,
    id: u64,
    signal: AbortSignal,
    cancelled_by_unload: Arc<AtomicBool>,
}

impl ActiveGenerations {
    pub(super) fn register(&self) -> Registration {
        let active = ActiveGeneration::default();
        let mut running = self.running();
        let id = running.next_id;
        running.next_id += 1;
        running.by_id.insert(id, active.clone());
        Registration {
            generations: self.clone(),
            id,
            signal: active.abort,
            cancelled_by_unload: active.cancelled_by_unload,
        }
    }

    /// Marks every running generation as ended by the unload, then aborts it.
    pub(super) fn cancel_for_unload(&self) {
        let running: Vec<ActiveGeneration> = self.running().by_id.values().cloned().collect();
        for active in running {
            active.cancelled_by_unload.store(true, Ordering::SeqCst);
            active.abort.abort();
        }
    }

    fn running(&self) -> MutexGuard<'_, Running> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Registration {
    pub(super) fn abort_signal(&self) -> AbortSignal {
        self.signal.clone()
    }

    fn cancelled_by_unload(&self) -> bool {
        self.cancelled_by_unload.load(Ordering::SeqCst)
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.generations.running().by_id.remove(&self.id);
    }
}
