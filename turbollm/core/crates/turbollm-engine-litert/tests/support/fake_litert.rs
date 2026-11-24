//! A scripted LiteRT-LM: the calls a model makes, recorded in order with the thread each ran on,
//! and a reply whose chunks arrive from a thread of their own, as the real library delivers them.

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use turbollm_engine::EngineError;
use turbollm_engine_litert::api::{
    Benchmark, BenchmarkTurn, ChunkSink, ConversationHandle, EngineHandle, EngineSettings,
    LiteRtCalls, LogSeverity, RawChunk,
};
use turbollm_engine_litert::prompt::LiteRtPrompt;
use turbollm_engine_litert::{Clock, SharedCalls};

pub const CALLBACK_THREAD_NAME: &str = "fake-litert-callback";
const TICK: Duration = Duration::from_millis(1);

/// What a scripted chunk carries.
#[derive(Debug, Clone, Default)]
pub struct Piece {
    pub text: String,
    pub thought: String,
}

pub fn text(text: &str) -> Piece {
    Piece {
        text: text.to_owned(),
        thought: String::new(),
    }
}

pub fn thought(thought: &str) -> Piece {
    Piece {
        text: String::new(),
        thought: thought.to_owned(),
    }
}

impl Piece {
    /// The message JSON the library hands its stream callback.
    fn payload(&self) -> String {
        let mut message = serde_json::json!({"role": "assistant"});
        if !self.text.is_empty() {
            message["content"] = serde_json::json!([{"type": "text", "text": self.text}]);
        }
        if !self.thought.is_empty() {
            message["channels"] = serde_json::json!({"thought": self.thought});
        }
        message.to_string()
    }
}

/// A benchmark of one prefill and one decode turn.
pub fn counters(
    prompt_tokens: usize,
    prompt_per_sec: f64,
    completion_tokens: usize,
    completion_per_sec: f64,
) -> Benchmark {
    Benchmark {
        prefill: vec![BenchmarkTurn {
            tokens: prompt_tokens,
            tokens_per_sec: prompt_per_sec,
        }],
        decode: vec![BenchmarkTurn {
            tokens: completion_tokens,
            tokens_per_sec: completion_per_sec,
        }],
    }
}

/// How the fake behaves; `Default` is a healthy device and a two-chunk reply.
#[derive(Clone)]
pub struct Script {
    pub gpu_failure: Option<EngineError>,
    pub cpu_failure: Option<EngineError>,
    pub start_failure: Option<String>,
    pub chunks: Vec<Piece>,
    /// The clock reads this when the first chunk arrives, and `generation_ms` later at the last.
    pub prefill_ms: u64,
    pub generation_ms: u64,
    /// After the scripted chunks, keep streaming until the reply is cancelled.
    pub endless: bool,
    /// The error the final chunk carries when the reply was not cancelled.
    pub reply_error: Option<String>,
    /// The error the final chunk carries when it was.
    pub error_on_cancel: Option<String>,
    pub cancel_failure: Option<String>,
    pub benchmark: Result<Benchmark, String>,
}

impl Default for Script {
    fn default() -> Script {
        Script {
            gpu_failure: None,
            cpu_failure: None,
            start_failure: None,
            chunks: vec![text("Hel"), text("lo")],
            prefill_ms: 0,
            generation_ms: 0,
            endless: false,
            reply_error: None,
            error_on_cancel: None,
            cancel_failure: None,
            benchmark: Ok(counters(10, 1000.0, 5, 100.0)),
        }
    }
}

/// One call the model made, and the thread it made it on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub name: String,
    pub thread: String,
}

fn current_thread_name() -> String {
    thread::current().name().unwrap_or("unnamed").to_owned()
}

type CallLog = Arc<Mutex<Vec<Call>>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a reply's stream callback points at; dropped when the conversation handle is, which the
/// counter lets a test see exactly once and after the conversation was deleted.
struct StreamState {
    sink: Mutex<ChunkSink>,
    log: CallLog,
    drops: Arc<AtomicUsize>,
}

impl Drop for StreamState {
    fn drop(&mut self) {
        locked(&self.log).push(Call {
            name: "stream_dropped".to_owned(),
            thread: current_thread_name(),
        });
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

struct Streaming {
    thread: JoinHandle<()>,
    cancelled: Arc<AtomicBool>,
}

/// Holds `create_engine` until released, so a test can leave a load in flight.
#[derive(Default)]
pub struct OpenGate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl OpenGate {
    pub fn wait_until_entered(&self) {
        let mut state = locked(&self.state);
        while !state.0 {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    pub fn release(&self) {
        locked(&self.state).1 = true;
        self.changed.notify_all();
    }

    fn pass(&self) {
        let mut state = locked(&self.state);
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

type Probe = Arc<dyn Fn() + Send + Sync>;

pub struct FakeLiteRt {
    script: Mutex<Script>,
    log: CallLog,
    settings: Mutex<Vec<EngineSettings>>,
    prompts: Mutex<Vec<LiteRtPrompt>>,
    callback_threads: Arc<Mutex<Vec<String>>>,
    streams: Mutex<HashMap<usize, Streaming>>,
    next_conversation: AtomicUsize,
    stream_drops: Arc<AtomicUsize>,
    clock_millis: Arc<AtomicU64>,
    open_gate: Mutex<Option<Arc<OpenGate>>>,
    on_delete: Mutex<Option<Probe>>,
}

impl FakeLiteRt {
    pub fn new() -> Arc<FakeLiteRt> {
        Arc::new(FakeLiteRt {
            script: Mutex::new(Script::default()),
            log: CallLog::default(),
            settings: Mutex::default(),
            prompts: Mutex::default(),
            callback_threads: Arc::default(),
            streams: Mutex::default(),
            next_conversation: AtomicUsize::new(1),
            stream_drops: Arc::default(),
            clock_millis: Arc::default(),
            open_gate: Mutex::default(),
            on_delete: Mutex::default(),
        })
    }

    pub fn script(&self) -> MutexGuard<'_, Script> {
        locked(&self.script)
    }

    pub fn calls(self: &Arc<Self>) -> SharedCalls {
        Arc::clone(self) as SharedCalls
    }

    /// The clock the fake's chunks are stamped with.
    pub fn clock(&self) -> Clock {
        let millis = Arc::clone(&self.clock_millis);
        Arc::new(move || Duration::from_millis(millis.load(Ordering::SeqCst)))
    }

    pub fn hold_open(&self) -> Arc<OpenGate> {
        let gate = Arc::new(OpenGate::default());
        *locked(&self.open_gate) = Some(Arc::clone(&gate));
        gate
    }

    /// Runs on the thread that deletes a conversation, just before it is deleted.
    pub fn on_delete(&self, probe: impl Fn() + Send + Sync + 'static) {
        *locked(&self.on_delete) = Some(Arc::new(probe));
    }

    pub fn history(&self) -> Vec<Call> {
        locked(&self.log).clone()
    }

    pub fn names(&self) -> Vec<String> {
        self.history().into_iter().map(|call| call.name).collect()
    }

    pub fn count(&self, name: &str) -> usize {
        self.names().iter().filter(|seen| *seen == name).count()
    }

    pub fn settings(&self) -> Vec<EngineSettings> {
        locked(&self.settings).clone()
    }

    pub fn prompts(&self) -> Vec<LiteRtPrompt> {
        locked(&self.prompts).clone()
    }

    pub fn stream_states_dropped(&self) -> usize {
        self.stream_drops.load(Ordering::SeqCst)
    }

    pub fn callback_threads(&self) -> Vec<String> {
        locked(&self.callback_threads).clone()
    }

    fn record(&self, name: &str) {
        locked(&self.log).push(Call {
            name: name.to_owned(),
            thread: current_thread_name(),
        });
    }

    fn stream_reply(&self, state: &Arc<StreamState>, script: Script) -> Streaming {
        let cancelled = Arc::new(AtomicBool::new(false));
        let streaming = Reply {
            state: Arc::clone(state),
            clock_millis: Arc::clone(&self.clock_millis),
            callback_threads: Arc::clone(&self.callback_threads),
            cancelled: Arc::clone(&cancelled),
            script,
        };
        let thread = thread::Builder::new()
            .name(CALLBACK_THREAD_NAME.to_owned())
            .spawn(move || streaming.deliver())
            .expect("a thread for the scripted stream");
        Streaming { thread, cancelled }
    }
}

/// The chunks of one reply, delivered from the callback thread.
struct Reply {
    state: Arc<StreamState>,
    clock_millis: Arc<AtomicU64>,
    callback_threads: Arc<Mutex<Vec<String>>>,
    cancelled: Arc<AtomicBool>,
    script: Script,
}

impl Reply {
    fn deliver(self) {
        locked(&self.callback_threads).push(current_thread_name());
        let mut first = true;
        for piece in &self.script.chunks {
            if std::mem::take(&mut first) {
                self.clock_millis
                    .store(self.script.prefill_ms, Ordering::SeqCst);
            }
            self.send(piece.payload(), None, false);
        }
        if self.script.endless {
            self.stream_until_cancelled();
        }
        let ended_at = self.script.prefill_ms + self.script.generation_ms;
        self.clock_millis.store(ended_at, Ordering::SeqCst);
        let error = if self.cancelled.load(Ordering::SeqCst) {
            self.script.error_on_cancel.clone()
        } else {
            self.script.reply_error.clone()
        };
        self.send(String::new(), error, true);
    }

    fn stream_until_cancelled(&self) {
        while !self.cancelled.load(Ordering::SeqCst) {
            self.send(text("tick").payload(), None, false);
            thread::sleep(TICK);
        }
    }

    fn send(&self, payload: String, error: Option<String>, is_final: bool) {
        let chunk = RawChunk {
            payload,
            error,
            is_final,
        };
        (locked(&self.state.sink))(chunk);
    }
}

impl LiteRtCalls for FakeLiteRt {
    fn set_min_log_level(&self, _level: LogSeverity) -> Result<(), String> {
        self.record("set_min_log_level");
        Ok(())
    }

    fn create_engine(&self, settings: &EngineSettings) -> Result<EngineHandle, EngineError> {
        self.record(&format!("create_engine:{}", settings.backend));
        locked(&self.settings).push(settings.clone());
        let gate = locked(&self.open_gate).clone();
        if let Some(gate) = gate {
            gate.pass();
        }
        let script = self.script();
        let failure = match settings.backend.as_str() {
            "gpu" => script.gpu_failure.clone(),
            _ => script.cpu_failure.clone(),
        };
        if let Some(failure) = failure {
            return Err(failure);
        }
        // SAFETY: a fake handle is never given to the real table.
        Ok(unsafe { EngineHandle::from_raw(NonNull::dangling()) })
    }

    fn delete_engine(&self, _engine: EngineHandle) {
        self.record("delete_engine");
    }

    fn start_reply(
        &self,
        _engine: &EngineHandle,
        prompt: &LiteRtPrompt,
        sink: ChunkSink,
    ) -> Result<ConversationHandle, String> {
        self.record("start_reply");
        let script = self.script().clone();
        if let Some(failure) = script.start_failure.clone() {
            return Err(failure);
        }
        locked(&self.prompts).push(prompt.clone());
        let state = Arc::new(StreamState {
            sink: Mutex::new(sink),
            log: Arc::clone(&self.log),
            drops: Arc::clone(&self.stream_drops),
        });
        let id = self.next_conversation.fetch_add(1, Ordering::SeqCst);
        let streaming = self.stream_reply(&state, script);
        locked(&self.streams).insert(id, streaming);
        let raw = NonNull::new(ptr::without_provenance_mut::<c_void>(id)).expect("an id above 0");
        // SAFETY: a fake handle is never given to the real table; `state` is what the stream uses.
        Ok(unsafe { ConversationHandle::from_raw(raw, Box::new(state)) })
    }

    fn cancel_reply(&self, conversation: &ConversationHandle) -> Result<(), String> {
        self.record("cancel_reply");
        let id = conversation.as_ptr().addr();
        if let Some(streaming) = locked(&self.streams).get(&id) {
            streaming.cancelled.store(true, Ordering::SeqCst);
        }
        match self.script().cancel_failure.clone() {
            Some(failure) => Err(failure),
            None => Ok(()),
        }
    }

    fn benchmark(&self, _conversation: &ConversationHandle) -> Result<Benchmark, String> {
        self.record("benchmark");
        self.script().benchmark.clone()
    }

    fn delete_conversation(&self, conversation: ConversationHandle) {
        self.record("delete_conversation");
        let probe = locked(&self.on_delete).clone();
        if let Some(probe) = probe {
            probe();
        }
        let streaming = locked(&self.streams).remove(&conversation.as_ptr().addr());
        if let Some(streaming) = streaming {
            streaming.cancelled.store(true, Ordering::SeqCst);
            streaming.thread.join().expect("the scripted stream ended");
        }
    }
}
