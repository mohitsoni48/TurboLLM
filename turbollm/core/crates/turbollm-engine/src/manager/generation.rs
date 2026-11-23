//! One running generation and the registry an unload cancels through.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::engine::{AbortSignal, EventStream};
use crate::error::{EngineError, MODEL_UNLOADED, REPLY_CANCELLED};
use crate::event::EngineEvent;

/// No Kotlin text exists for this: the stream ended without `Done` and nobody cancelled it (the
/// engine thread died mid-reply). Not an arch 3.7 contract string.
const ENGINE_STOPPED_MID_REPLY: &str = "The engine stopped before the reply ended.";

/// A generation's event stream. `cancel` stops it; dropping it before its end does the same.
pub struct Generation {
    events: EventStream,
    registration: Registration,
}

impl Generation {
    pub(super) fn new(events: EventStream, registration: Registration) -> Generation {
        Generation {
            events,
            registration,
        }
    }

    /// The next event; `None` once the reply ended. A generation an unload cancelled ends with
    /// `Cancelled("The model was unloaded.")` (`EngineHost.kt:165`); a stream that stops before
    /// `Done` ends with an error, never as a complete reply.
    pub async fn next(&mut self) -> Result<Option<EngineEvent>, EngineError> {
        if self.registration.has_ended() {
            return Ok(None);
        }
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
            None => {
                let stopped = self.stopped_before_done();
                self.end(Err(stopped))
            }
        }
    }

    /// Asks the engine to stop this reply; safe from any thread, any number of times.
    pub fn cancel(&self) {
        self.canceller().cancel();
    }

    /// Cancels this generation from elsewhere, also while another task awaits its `next`.
    pub fn canceller(&self) -> GenerationCanceller {
        GenerationCanceller {
            active: self.registration.active.clone(),
        }
    }

    /// A cancelled reply may lose the engine's own `Cancelled` once its stream is closed.
    fn stopped_before_done(&self) -> EngineError {
        if self.registration.active.abort.is_aborted() {
            EngineError::Cancelled(REPLY_CANCELLED.to_owned())
        } else {
            EngineError::EngineFailure(ENGINE_STOPPED_MID_REPLY.to_owned())
        }
    }

    fn end(
        &mut self,
        outcome: Result<Option<EngineEvent>, EngineError>,
    ) -> Result<Option<EngineEvent>, EngineError> {
        self.registration.mark_ended();
        outcome
    }
}

impl Drop for Generation {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// Cancels one generation from any thread. A reply that already ended is never aborted afterwards
/// (`ChatService.kt:72-75`): its abort could reach the model while it serves the next request.
#[derive(Clone)]
pub struct GenerationCanceller {
    active: ActiveGeneration,
}

impl GenerationCanceller {
    pub fn cancel(&self) {
        if !self.active.ended.load(Ordering::SeqCst) {
            self.active.abort.abort();
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
    ended: Arc<AtomicBool>,
}

/// A generation's place in the registry, given up when it is dropped.
pub(super) struct Registration {
    generations: ActiveGenerations,
    id: u64,
    active: ActiveGeneration,
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
            active,
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
        self.active.abort.clone()
    }

    fn cancelled_by_unload(&self) -> bool {
        self.active.cancelled_by_unload.load(Ordering::SeqCst)
    }

    fn has_ended(&self) -> bool {
        self.active.ended.load(Ordering::SeqCst)
    }

    fn mark_ended(&self) {
        self.active.ended.store(true, Ordering::SeqCst);
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.generations.running().by_id.remove(&self.id);
    }
}
