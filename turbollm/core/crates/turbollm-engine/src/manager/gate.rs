//! The generation gate of one loaded model (ADR-457): its slots run generations, a bounded FIFO
//! queue waits behind them, and a request that finds the queue full is refused at once.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, TryAcquireError};

use crate::error::{EngineError, MODEL_UNLOADED};

/// Called whenever `busy` or `queued` may have changed; it feeds the manager's snapshot.
pub type OccupancyListener = Box<dyn Fn() + Send + Sync>;

/// One gate per loaded model, sized by the model's `slots()` (arch 2.3.6).
pub struct GenerationGate {
    permits: Arc<Semaphore>,
    slots: u32,
    waiting: AtomicUsize,
    max_queued: usize,
    occupancy: Arc<Occupancy>,
}

/// One slot of a loaded model's generation gate (ADR-457). It travels with the generate command
/// and the engine thread drops it once the native call returned (T-3), so the gate reads busy
/// exactly while native code runs.
pub struct GatePermit {
    slot: Option<OwnedSemaphorePermit>,
    occupancy: Arc<Occupancy>,
}

struct Occupancy {
    on_change: OccupancyListener,
    slot_freed: Notify,
}

/// A request waiting in the queue; leaving it, by a permit, a refusal or a dropped future,
/// takes it off the count.
struct QueuedRequest<'gate> {
    gate: &'gate GenerationGate,
}

impl GenerationGate {
    pub fn new(slots: u32, max_queued: usize, on_change: OccupancyListener) -> GenerationGate {
        GenerationGate {
            permits: Arc::new(Semaphore::new(slots as usize)),
            slots,
            waiting: AtomicUsize::new(0),
            max_queued,
            occupancy: Arc::new(Occupancy {
                on_change,
                slot_freed: Notify::new(),
            }),
        }
    }

    /// A free slot at once; else a place in the FIFO queue; `ServerBusy` when the queue is full
    /// (`GenerationGate.kt:41-53`); the unload text once the gate is closed (E-6).
    pub async fn acquire(&self) -> Result<GatePermit, EngineError> {
        let slot = match Arc::clone(&self.permits).try_acquire_owned() {
            Ok(slot) => slot,
            Err(TryAcquireError::Closed) => return Err(unloaded()),
            Err(TryAcquireError::NoPermits) => self.wait_in_queue().await?,
        };
        self.occupancy.changed();
        Ok(GatePermit {
            slot: Some(slot),
            occupancy: Arc::clone(&self.occupancy),
        })
    }

    /// Returns once every generation ahead of the caller finished. Never refused and never
    /// counted as queued. On a closed gate it waits for the generations still running.
    pub async fn await_idle(&self) {
        match Arc::clone(&self.permits)
            .acquire_many_owned(self.slots)
            .await
        {
            Ok(all_slots) => drop(all_slots),
            Err(_closed) => self.await_running_generations().await,
        }
    }

    /// Wakes every queued request with `ModelNotLoaded("The model was unloaded.")` and refuses
    /// every later one the same way; running generations keep their slots until they end.
    pub fn close(&self) {
        self.permits.close();
    }

    pub fn busy(&self) -> bool {
        self.permits.available_permits() < self.slots as usize
    }

    pub fn queued(&self) -> usize {
        self.waiting.load(Ordering::SeqCst)
    }

    async fn wait_in_queue(&self) -> Result<OwnedSemaphorePermit, EngineError> {
        let _queued = self.join_queue()?;
        Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .map_err(|_closed| unloaded())
    }

    fn join_queue(&self) -> Result<QueuedRequest<'_>, EngineError> {
        let queued = QueuedRequest { gate: self };
        if self.waiting.fetch_add(1, Ordering::SeqCst) + 1 > self.max_queued {
            return Err(EngineError::ServerBusy);
        }
        self.occupancy.changed();
        Ok(queued)
    }

    async fn await_running_generations(&self) {
        loop {
            let slot_freed = self.occupancy.slot_freed.notified();
            tokio::pin!(slot_freed);
            slot_freed.as_mut().enable();
            if !self.busy() {
                return;
            }
            slot_freed.await;
        }
    }
}

impl Drop for QueuedRequest<'_> {
    fn drop(&mut self) {
        self.gate.waiting.fetch_sub(1, Ordering::SeqCst);
        self.gate.occupancy.changed();
    }
}

impl Drop for GatePermit {
    fn drop(&mut self) {
        drop(self.slot.take());
        self.occupancy.slot_freed.notify_waiters();
        self.occupancy.changed();
    }
}

impl Occupancy {
    fn changed(&self) {
        (self.on_change)();
    }
}

fn unloaded() -> EngineError {
    EngineError::ModelNotLoaded(MODEL_UNLOADED.to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::task::JoinHandle;

    fn gate(max_queued: usize) -> Arc<GenerationGate> {
        Arc::new(GenerationGate::new(1, max_queued, Box::new(|| {})))
    }

    /// Lets every spawned task on the current-thread test runtime run until it waits again.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn queue_waiter(
        gate: &Arc<GenerationGate>,
        entered: &Arc<Mutex<Vec<u32>>>,
        waiter: u32,
    ) -> JoinHandle<Result<(), EngineError>> {
        let gate = Arc::clone(gate);
        let entered = Arc::clone(entered);
        tokio::spawn(async move {
            let _permit = gate.acquire().await?;
            entered.lock().unwrap().push(waiter);
            Ok(())
        })
    }

    fn unload_failure() -> EngineError {
        EngineError::ModelNotLoaded(MODEL_UNLOADED.to_owned())
    }

    #[tokio::test]
    async fn an_idle_gate_is_neither_busy_nor_queued() {
        let gate = gate(8);
        assert!(!gate.busy());
        assert_eq!(gate.queued(), 0);
    }

    #[tokio::test]
    async fn waiters_take_the_permit_in_arrival_order() {
        let gate = gate(8);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let holder = gate.acquire().await.unwrap();
        let mut waiters = Vec::new();
        for waiter in 1..=3 {
            waiters.push(queue_waiter(&gate, &entered, waiter));
            settle().await;
        }
        assert!(gate.busy());
        assert_eq!(gate.queued(), 3);

        drop(holder);
        for waiter in waiters {
            waiter.await.unwrap().unwrap();
        }

        assert_eq!(*entered.lock().unwrap(), [1, 2, 3]);
        assert!(!gate.busy());
        assert_eq!(gate.queued(), 0);
    }

    #[tokio::test]
    async fn a_waiter_beyond_the_queue_limit_is_refused_as_server_busy() {
        let gate = gate(2);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let _holder = gate.acquire().await.unwrap();
        for waiter in 1..=2 {
            queue_waiter(&gate, &entered, waiter);
            settle().await;
        }

        let refusal = gate.acquire().await.err();

        assert_eq!(refusal, Some(EngineError::ServerBusy));
        assert_eq!(gate.queued(), 2);
    }

    #[tokio::test]
    async fn a_waiter_cancelled_while_queued_leaves_the_queue_and_never_runs() {
        let gate = gate(8);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let holder = gate.acquire().await.unwrap();
        let cancelled = queue_waiter(&gate, &entered, 1);
        settle().await;
        assert_eq!(gate.queued(), 1);

        cancelled.abort();
        settle().await;
        assert_eq!(gate.queued(), 0);

        drop(holder);
        settle().await;
        assert!(entered.lock().unwrap().is_empty());
        assert!(!gate.busy());
    }

    #[tokio::test]
    async fn the_permit_is_released_when_the_holder_panics() {
        let gate = gate(8);
        let holder_gate = Arc::clone(&gate);
        let holder = tokio::spawn(async move {
            let _permit = holder_gate.acquire().await.unwrap();
            panic!("engine blew up");
        });

        let failure = holder.await.unwrap_err();

        assert!(failure.is_panic());
        assert!(!gate.busy());
        assert!(gate.acquire().await.is_ok());
    }

    #[tokio::test]
    async fn a_request_that_finds_the_gate_free_is_never_counted_as_queued() {
        let gate = gate(0);
        let _permit = gate.acquire().await.unwrap();
        assert_eq!(gate.queued(), 0);
    }

    #[tokio::test]
    async fn awaiting_idle_waits_for_the_holder_even_when_the_queue_is_full() {
        let gate = gate(0);
        let holder = gate.acquire().await.unwrap();
        let idle_gate = Arc::clone(&gate);
        let idle = tokio::spawn(async move { idle_gate.await_idle().await });
        settle().await;
        assert!(!idle.is_finished());
        assert_eq!(gate.queued(), 0);

        drop(holder);
        idle.await.unwrap();
        assert!(!gate.busy());
    }

    #[tokio::test]
    async fn the_sdk_queue_holds_eight_and_refuses_the_ninth_at_once() {
        let gate = gate(8);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let holder = gate.acquire().await.unwrap();
        let waiters: Vec<_> = (1..=8)
            .map(|waiter| queue_waiter(&gate, &entered, waiter))
            .collect();
        settle().await;
        assert_eq!(gate.queued(), 8);

        assert_eq!(gate.acquire().await.err(), Some(EngineError::ServerBusy));

        drop(holder);
        for waiter in waiters {
            waiter.await.unwrap().unwrap();
        }
        assert_eq!(*entered.lock().unwrap(), (1..=8).collect::<Vec<_>>());
        assert_eq!(gate.queued(), 0);
    }

    #[tokio::test]
    async fn the_next_waiter_is_served_after_one_ahead_of_it_went_away() {
        let gate = gate(8);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let holder = gate.acquire().await.unwrap();
        let gone = queue_waiter(&gate, &entered, 1);
        settle().await;
        let next = queue_waiter(&gate, &entered, 2);
        settle().await;

        gone.abort();
        settle().await;
        drop(holder);
        next.await.unwrap().unwrap();

        assert_eq!(*entered.lock().unwrap(), [2]);
    }

    #[tokio::test]
    async fn close_wakes_every_waiter_with_the_unload_text() {
        let gate = gate(8);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let _holder = gate.acquire().await.unwrap();
        let waiters: Vec<_> = (1..=3)
            .map(|waiter| queue_waiter(&gate, &entered, waiter))
            .collect();
        settle().await;

        gate.close();

        for waiter in waiters {
            assert_eq!(waiter.await.unwrap(), Err(unload_failure()));
        }
        assert_eq!(gate.queued(), 0);
        assert!(entered.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn e6_queued_waiter_on_unload_text() {
        let gate = gate(8);
        let entered = Arc::new(Mutex::new(Vec::new()));
        let _running = gate.acquire().await.unwrap();
        let queued = queue_waiter(&gate, &entered, 1);
        settle().await;

        gate.close();

        let failure = queued.await.unwrap().unwrap_err();
        assert_eq!(
            failure,
            EngineError::ModelNotLoaded(MODEL_UNLOADED.to_owned())
        );
        assert_eq!(failure.to_string(), "The model was unloaded.");
    }

    #[tokio::test]
    async fn a_closed_gate_refuses_at_once_with_the_unload_text() {
        let gate = gate(8);
        gate.close();
        assert_eq!(gate.acquire().await.err(), Some(unload_failure()));
        assert!(!gate.busy());
    }

    #[tokio::test]
    async fn awaiting_idle_on_a_closed_gate_waits_for_the_running_generation() {
        let gate = gate(8);
        let running = gate.acquire().await.unwrap();
        gate.close();
        let idle_gate = Arc::clone(&gate);
        let idle = tokio::spawn(async move { idle_gate.await_idle().await });
        settle().await;
        assert!(!idle.is_finished());
        assert!(gate.busy());

        drop(running);
        idle.await.unwrap();
        assert!(!gate.busy());
    }

    #[tokio::test]
    async fn on_change_fires_on_every_busy_or_queued_change() {
        let changes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&changes);
        let on_change = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let gate = Arc::new(GenerationGate::new(1, 8, on_change));
        let entered = Arc::new(Mutex::new(Vec::new()));
        let seen = || changes.load(Ordering::SeqCst);
        let mut last = seen();

        let mut fired = |label: &str| {
            let now = seen();
            assert!(now > last, "no change reported after {label}");
            last = now;
        };

        let holder = gate.acquire().await.unwrap();
        fired("the holder took the free slot");
        let waiter = queue_waiter(&gate, &entered, 1);
        settle().await;
        fired("a waiter queued");
        drop(holder);
        fired("the holder released its slot");
        waiter.await.unwrap().unwrap();
        fired("the waiter left the queue, ran and released");
        let blocker = gate.acquire().await.unwrap();
        fired("a new holder took the slot");
        let cancelled = queue_waiter(&gate, &entered, 2);
        settle().await;
        fired("a second waiter queued");
        cancelled.abort();
        settle().await;
        fired("the queued waiter went away");
        drop(blocker);
        fired("the new holder released its slot");
    }
}
