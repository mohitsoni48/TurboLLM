use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_core::Stream;
use turbollm_platform::HostFacts;

use crate::descriptor::{EngineDescriptor, HttpUpstream, ModelInfo};
use crate::error::EngineError;
use crate::event::EngineEvent;
use crate::manager::GatePermit;
use crate::request::{GenerateRequest, LoadSpec};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
pub type EventStream =
    Pin<Box<dyn Stream<Item = Result<EngineEvent, EngineError>> + Send + 'static>>;
pub type AbortHook = Arc<dyn Fn() + Send + Sync>;

/// One kind of engine the manager can load models with, whichever way it runs them.
pub trait Engine: Send + Sync + 'static {
    fn descriptor(&self) -> &EngineDescriptor;
    /// Cheap, loads no native code (ABI and cpuinfo checks only). None = can run here.
    fn probe(&self, host: &HostFacts) -> Option<String>;
    fn stall_policy(&self) -> StallPolicy;
    fn load(
        &self,
        spec: LoadSpec,
        ctl: LoadControl,
    ) -> BoxFuture<Result<Box<dyn LoadedModel>, EngineError>>;
}

/// A model an engine holds open until `close`.
pub trait LoadedModel: Send + Sync {
    fn info(&self) -> &ModelInfo;
    /// Gate size (ADR-457); 1 for every in-process model.
    fn slots(&self) -> u32;
    fn generate(
        &self,
        req: GenerateRequest,
        permit: GatePermit,
        abort: AbortSignal,
    ) -> Result<EventStream, EngineError>;
    /// Supervised kind (2b) only.
    fn upstream(&self) -> Option<HttpUpstream> {
        None
    }
    /// Frees native state; resolves once it is gone.
    fn close(self: Box<Self>) -> BoxFuture<()>;
}

/// Whether a load with no progress for the stall window is aborted (ADR-460: LiteRT-LM is exempt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallPolicy {
    Watch,
    Exempt,
}

/// What a load reports to, and listens to, while it runs.
#[derive(Clone)]
pub struct LoadControl {
    pub progress: Arc<dyn Fn(f32) + Send + Sync>,
    pub abort: AbortSignal,
}

/// A stop request any thread can raise once: a flag the native loop polls, plus the hooks a backend
/// registers to interrupt a call that does not poll (T-1). A hook registered while an abort is
/// raised may run twice, so hooks only ever raise a stop request of their own, and never touch
/// the signal that runs them. Hooks run under the signal's lock, so `retire` waits for a running
/// one and no hook runs once `retire` returned.
#[derive(Clone, Default)]
pub struct AbortSignal {
    raised: Arc<AbortState>,
}

#[derive(Default)]
struct AbortState {
    flag: AtomicBool,
    hooks: Mutex<Vec<AbortHook>>,
}

impl AbortSignal {
    pub fn new() -> AbortSignal {
        AbortSignal::default()
    }

    /// Raises the flag, then runs every registered hook.
    pub fn abort(&self) {
        self.raised.flag.store(true, Ordering::SeqCst);
        for hook in self.hooks().iter() {
            hook();
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.raised.flag.load(Ordering::SeqCst)
    }

    /// Registers a hook; one added after the abort runs at once.
    pub fn add_hook(&self, hook: AbortHook) {
        let mut hooks = self.hooks();
        hooks.push(Arc::clone(&hook));
        if self.is_aborted() {
            hook();
        }
    }

    /// A hook that raises this signal, so an abort of another signal reaches this one's hooks.
    pub fn relay(&self) -> AbortHook {
        let relayed = self.clone();
        Arc::new(move || relayed.abort())
    }

    /// Drops every hook once the native call they interrupt has returned: a later abort still raises
    /// the flag but reaches no native code, so it cannot stop the call that runs next (E-11).
    pub fn retire(&self) {
        self.hooks().clear();
    }

    fn hooks(&self) -> MutexGuard<'_, Vec<AbortHook>> {
        self.raised
            .hooks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// How long the racing test's hook keeps running, so a `retire` that does not wait for it returns
    /// while it still runs.
    const HOOK_RUNNING: Duration = Duration::from_millis(50);

    fn counting_hook(count: &Arc<AtomicUsize>) -> AbortHook {
        let count = Arc::clone(count);
        Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        })
    }

    #[test]
    fn a_new_signal_is_not_aborted() {
        assert!(!AbortSignal::new().is_aborted());
    }

    #[test]
    fn an_abort_is_seen_by_every_clone() {
        let signal = AbortSignal::new();
        let seen_elsewhere = signal.clone();
        signal.abort();
        assert!(seen_elsewhere.is_aborted());
    }

    #[test]
    fn an_abort_runs_every_registered_hook() {
        let signal = AbortSignal::new();
        let count = Arc::new(AtomicUsize::new(0));
        signal.add_hook(counting_hook(&count));
        signal.add_hook(counting_hook(&count));
        signal.abort();
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_hook_added_after_the_abort_runs_at_once() {
        let signal = AbortSignal::new();
        signal.abort();
        let count = Arc::new(AtomicUsize::new(0));
        signal.add_hook(counting_hook(&count));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_retired_signal_runs_no_hook() {
        let signal = AbortSignal::new();
        let count = Arc::new(AtomicUsize::new(0));
        signal.add_hook(counting_hook(&count));

        signal.retire();
        signal.abort();

        assert!(signal.is_aborted());
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_abort_racing_retire_runs_no_hook_after_retire_returned() {
        let signal = AbortSignal::new();
        let retired = Arc::new(AtomicBool::new(false));
        let (started, hook_started) = std::sync::mpsc::channel();
        let ran_after_retire = Arc::new(AtomicBool::new(false));
        let hook: AbortHook = {
            let (retired, ran_after_retire) = (Arc::clone(&retired), Arc::clone(&ran_after_retire));
            let started = Mutex::new(started);
            Arc::new(move || {
                let _ = started.lock().unwrap().send(());
                std::thread::sleep(HOOK_RUNNING);
                ran_after_retire.store(retired.load(Ordering::SeqCst), Ordering::SeqCst);
            })
        };
        signal.add_hook(hook);
        let raiser = signal.clone();
        let aborting = std::thread::spawn(move || raiser.abort());
        hook_started.recv().unwrap();

        signal.retire();
        retired.store(true, Ordering::SeqCst);

        aborting.join().unwrap();
        assert!(!ran_after_retire.load(Ordering::SeqCst));
    }

    #[test]
    fn a_signal_raised_through_its_relay_runs_its_own_hooks() {
        let relayed = AbortSignal::new();
        let count = Arc::new(AtomicUsize::new(0));
        relayed.add_hook(counting_hook(&count));
        let source = AbortSignal::new();
        source.add_hook(relayed.relay());

        source.abort();

        assert!(relayed.is_aborted());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_abort_from_another_thread_reaches_the_hooks() {
        let signal = AbortSignal::new();
        let count = Arc::new(AtomicUsize::new(0));
        signal.add_hook(counting_hook(&count));
        let raiser = signal.clone();
        std::thread::spawn(move || raiser.abort()).join().unwrap();
        assert!(signal.is_aborted());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
