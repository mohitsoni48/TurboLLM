//! Test doubles for the engine layer (feature `testing`, never a default): `ScriptedBackend` plays a
//! fixed script on every generation and records what was asked of it, like the SDK's `FakeEngine.kt`.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use turbollm_platform::HostFacts;

use crate::descriptor::{Backend, EngineDescriptor, ModelInfo};
use crate::engine::{AbortHook, AbortSignal, LoadControl, StallPolicy};
use crate::error::{EngineError, REPLY_CANCELLED};
use crate::event::EngineEvent;
use crate::ids::{EngineId, EngineKind, ModelFormat};
use crate::inprocess::{EventSink, NativeBackend, NativeModel};
use crate::request::{GenerateRequest, LoadSpec};

pub const SCRIPTED_THREAD_NAME: &str = "turbollm-scripted";

/// What a scripted open that heeds the load's abort fails with once aborted.
pub const SCRIPTED_OPEN_ABORTED: &str = "The scripted open was aborted.";

const PAUSE_SLICE: Duration = Duration::from_millis(5);

/// One step a scripted generation plays.
#[derive(Debug, Clone)]
pub enum Step {
    Emit(EngineEvent),
    /// Waits, ending the generation early when it is aborted.
    Pause(Duration),
    /// A native call that does not look at the abort until it returns.
    Block(Duration),
    Fail(EngineError),
}

/// A `NativeBackend` whose open and generate follow a script. History entries, in order:
/// `open`, `open aborted`, `generate`, `aborted`, `abort hook`, `generate returned`, `close`.
pub struct ScriptedBackend {
    descriptor: EngineDescriptor,
    script: Vec<Step>,
    open_pause: OpenPause,
    open_outcome: OpenOutcome,
    close_pause: Duration,
    probe: ScriptedProbe,
    record: Arc<ScriptRecord>,
}

/// What a `ScriptedBackend`'s probe answers: `None` = can run here, else why not.
pub type ScriptedProbe = Box<dyn Fn() -> Option<String> + Send + Sync>;

enum OpenPause {
    None,
    HeedingAbort(Duration),
    IgnoringAbort(Duration),
}

enum OpenOutcome {
    Opens,
    Fails(EngineError),
    Panics(&'static str),
}

impl ScriptedBackend {
    pub fn new(script: Vec<Step>) -> ScriptedBackend {
        ScriptedBackend {
            descriptor: scripted_descriptor(),
            script,
            open_pause: OpenPause::None,
            open_outcome: OpenOutcome::Opens,
            close_pause: Duration::ZERO,
            probe: Box::new(|| None),
            record: Arc::new(ScriptRecord::default()),
        }
    }

    /// Stands in for another engine: its id, name, kind and formats.
    pub fn with_descriptor(mut self, descriptor: EngineDescriptor) -> ScriptedBackend {
        self.descriptor = descriptor;
        self
    }

    /// Makes the open take this long, or until the load is aborted (then it fails `Cancelled`).
    /// It never reports progress, so a watched load stalls.
    pub fn with_open_pause(mut self, pause: Duration) -> ScriptedBackend {
        self.open_pause = OpenPause::HeedingAbort(pause);
        self
    }

    /// Makes the open take this long whatever happens to the load meanwhile.
    pub fn with_unabortable_open_pause(mut self, pause: Duration) -> ScriptedBackend {
        self.open_pause = OpenPause::IgnoringAbort(pause);
        self
    }

    pub fn with_probe(
        mut self,
        probe: impl Fn() -> Option<String> + Send + Sync + 'static,
    ) -> ScriptedBackend {
        self.probe = Box::new(probe);
        self
    }

    pub fn with_open_failure(mut self, error: EngineError) -> ScriptedBackend {
        self.open_outcome = OpenOutcome::Fails(error);
        self
    }

    pub fn with_open_panic(mut self, message: &'static str) -> ScriptedBackend {
        self.open_outcome = OpenOutcome::Panics(message);
        self
    }

    /// Makes the native close take this long, to tell a waiting dropper from a detaching one.
    pub fn with_close_pause(mut self, pause: Duration) -> ScriptedBackend {
        self.close_pause = pause;
        self
    }

    pub fn record(&self) -> Arc<ScriptRecord> {
        Arc::clone(&self.record)
    }
}

impl NativeBackend for ScriptedBackend {
    type Model = ScriptedModel;

    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    fn probe(&self, _host: &HostFacts) -> Option<String> {
        (self.probe)()
    }

    fn stall_policy(&self) -> StallPolicy {
        StallPolicy::Watch
    }

    fn thread_name(&self) -> &'static str {
        SCRIPTED_THREAD_NAME
    }

    fn open(
        &self,
        spec: &LoadSpec,
        ctl: &LoadControl,
    ) -> Result<(ScriptedModel, ModelInfo), EngineError> {
        self.record.note_open_thread();
        self.record.note_open(spec);
        self.pause_open(&ctl.abort)?;
        match &self.open_outcome {
            OpenOutcome::Opens => Ok((self.model(), scripted_model_info())),
            OpenOutcome::Fails(error) => Err(error.clone()),
            OpenOutcome::Panics(message) => panic!("{message}"),
        }
    }
}

impl ScriptedBackend {
    fn pause_open(&self, abort: &AbortSignal) -> Result<(), EngineError> {
        match self.open_pause {
            OpenPause::None => Ok(()),
            OpenPause::IgnoringAbort(pause) => {
                std::thread::sleep(pause);
                Ok(())
            }
            OpenPause::HeedingAbort(pause) if pause_unless_aborted(pause, abort) => Ok(()),
            OpenPause::HeedingAbort(_) => {
                self.record.note("open aborted");
                Err(EngineError::Cancelled(SCRIPTED_OPEN_ABORTED.to_owned()))
            }
        }
    }

    fn model(&self) -> ScriptedModel {
        ScriptedModel {
            script: self.script.clone(),
            close_pause: self.close_pause,
            record: Arc::clone(&self.record),
        }
    }
}

/// The model a `ScriptedBackend` opens.
pub struct ScriptedModel {
    script: Vec<Step>,
    close_pause: Duration,
    record: Arc<ScriptRecord>,
}

impl NativeModel for ScriptedModel {
    fn generate(
        &mut self,
        _req: &GenerateRequest,
        sink: &mut EventSink,
        abort: &AbortSignal,
    ) -> Result<(), EngineError> {
        self.record.note("generate");
        let played = self.play_script(sink, abort);
        self.record.note("generate returned");
        played
    }

    fn abort_hook(&self) -> AbortHook {
        let record = Arc::clone(&self.record);
        Arc::new(move || record.note("abort hook"))
    }

    fn close(self) {
        std::thread::sleep(self.close_pause);
        self.record.note("close");
    }
}

impl ScriptedModel {
    fn play_script(&self, sink: &mut EventSink, abort: &AbortSignal) -> Result<(), EngineError> {
        for step in &self.script {
            match step {
                Step::Emit(event) => {
                    if sink.emit(event.clone()).is_err() {
                        return Err(self.aborted());
                    }
                }
                Step::Pause(pause) => {
                    if !pause_unless_aborted(*pause, abort) {
                        return Err(self.aborted());
                    }
                }
                Step::Block(busy) => std::thread::sleep(*busy),
                Step::Fail(error) => return Err(error.clone()),
            }
        }
        Ok(())
    }

    fn aborted(&self) -> EngineError {
        self.record.note("aborted");
        EngineError::Cancelled(REPLY_CANCELLED.to_owned())
    }
}

/// Sleeps for `pause`, waking early on an abort; true when the whole pause passed.
fn pause_unless_aborted(pause: Duration, abort: &AbortSignal) -> bool {
    let until = Instant::now() + pause;
    while Instant::now() < until {
        if abort.is_aborted() {
            return false;
        }
        std::thread::sleep(PAUSE_SLICE);
    }
    !abort.is_aborted()
}

/// What a `ScriptedBackend` saw, shared with the test that drives it.
#[derive(Default)]
pub struct ScriptRecord {
    history: Mutex<Vec<String>>,
    opened_specs: Mutex<Vec<LoadSpec>>,
    open_thread: Mutex<Option<String>>,
    engine_thread_exited: AtomicBool,
}

impl ScriptRecord {
    pub fn history(&self) -> Vec<String> {
        self.history.lock().unwrap().clone()
    }

    /// The spec of every open, in order.
    pub fn opened_specs(&self) -> Vec<LoadSpec> {
        self.opened_specs.lock().unwrap().clone()
    }

    fn note_open(&self, spec: &LoadSpec) {
        self.opened_specs.lock().unwrap().push(spec.clone());
        self.note("open");
    }

    pub fn open_thread(&self) -> Option<String> {
        self.open_thread.lock().unwrap().clone()
    }

    /// True once the thread that ran `open` has finished, thread-local destructors included.
    pub fn engine_thread_exited(&self) -> bool {
        self.engine_thread_exited.load(Ordering::SeqCst)
    }

    fn note(&self, entry: &str) {
        self.history.lock().unwrap().push(entry.to_owned());
    }

    fn note_open_thread(self: &Arc<Self>) {
        *self.open_thread.lock().unwrap() = std::thread::current().name().map(str::to_owned);
        let probe = ThreadExitProbe(Arc::clone(self));
        THREAD_EXIT_PROBE.with(|slot| *slot.borrow_mut() = Some(probe));
    }
}

thread_local! {
    static THREAD_EXIT_PROBE: RefCell<Option<ThreadExitProbe>> = const { RefCell::new(None) };
}

struct ThreadExitProbe(Arc<ScriptRecord>);

impl Drop for ThreadExitProbe {
    fn drop(&mut self) {
        self.0.engine_thread_exited.store(true, Ordering::SeqCst);
    }
}

fn scripted_descriptor() -> EngineDescriptor {
    EngineDescriptor {
        id: EngineId::new(EngineId::LLAMA_CPP_CPU),
        name: "llama.cpp (CPU)".to_owned(),
        kind: EngineKind::LlamaCpp,
        formats: vec![ModelFormat::Gguf],
        backends: vec![Backend::Cpu],
    }
}

fn scripted_model_info() -> ModelInfo {
    ModelInfo {
        context_size: 4096,
        trained_context: Some(4096),
        backend: Backend::Cpu,
        notes: Vec::new(),
    }
}

/// Test time for the core runtime: tokio's clock, paused, moved forward only by `advance`.
/// Needs a current-thread runtime (`#[tokio::test]`).
pub struct FakeClock {
    _paused: (),
}

/// Yields enough times for a task woken by the last step to run and park again.
const SETTLE_YIELDS: usize = 8;

impl FakeClock {
    pub fn paused() -> FakeClock {
        tokio::time::pause();
        FakeClock { _paused: () }
    }

    /// Moves the clock forward and lets every task woken by it run.
    pub async fn advance(&self, by: Duration) {
        tokio::time::advance(by).await;
        self.settle().await;
    }

    /// Lets every task that is ready run before the test looks at what they did.
    pub async fn settle(&self) {
        for _ in 0..SETTLE_YIELDS {
            tokio::task::yield_now().await;
        }
    }
}
