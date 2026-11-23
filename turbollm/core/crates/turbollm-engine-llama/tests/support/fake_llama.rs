//! A scripted session library (port of the Kotlin SDK's `testing/FakeLlama.kt`). It records every
//! call with the thread that made it, polls the abort callback the way llama.cpp's decode does, and
//! notes when the engine thread that called it exits.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use turbollm_engine::EngineError;
use turbollm_engine_llama::api::{
    AbortFn, Delta, END_OF_REPLY, LlamaCalls, LoadRequest, ModelInfo, Sampling, Session, Stats,
    TL_ABORTED, TL_FAILED, TL_OK, TOKEN_SAMPLED, Token,
};
use turbollm_engine_llama::{ENGINE_THREAD_NAME, LoadedLibrary};

const PREFILL_LIMIT: Duration = Duration::from_secs(30);
const ABORT_POLL: Duration = Duration::from_millis(1);
pub const FAKE_LIBRARY_FILE: &str = "fake/turbollm_core_llama_base";
pub const LOAD_ABORTED: &str = "llama_model_load: the progress callback cancelled the load";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub path: String,
    pub context_size: i32,
    pub threads: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub name: String,
    pub thread: String,
}

/// What the test scripts before a call; each field mirrors a `FakeLlama.kt` knob.
pub struct Script {
    pub library_failure: Option<EngineError>,
    pub open_failure: Option<String>,
    pub trained_context: i32,
    pub prompt_tokens: i32,
    pub prepare_sentinel: Option<i32>,
    pub prepare_failure: String,
    pub prefill_waits_for_abort: bool,
    pub endless_reply: bool,
    pub context_full: bool,
    pub token_failure: String,
    pub sampling_failure: Option<String>,
    pub parse_failure: Option<String>,
    pub panic_on_next_token: Option<&'static str>,
    pub load_progress: Vec<f32>,
}

impl Default for Script {
    fn default() -> Script {
        Script {
            library_failure: None,
            open_failure: None,
            trained_context: 32_768,
            prompt_tokens: 12,
            prepare_sentinel: None,
            prepare_failure: String::new(),
            prefill_waits_for_abort: false,
            endless_reply: false,
            context_full: false,
            token_failure: String::new(),
            sampling_failure: None,
            parse_failure: None,
            panic_on_next_token: None,
            load_progress: Vec::new(),
        }
    }
}

/// What the fake saw, in order.
#[derive(Default)]
pub struct Seen {
    pub calls: Vec<Call>,
    pub opened: Vec<Opened>,
    pub freed: Vec<usize>,
    pub requests: Vec<String>,
    pub samplings: Vec<Sampling>,
    pub lifecycle: Vec<String>,
    pub abort_at_prepare: Vec<bool>,
    pub progress_answers: Vec<bool>,
    pub partial_parses: usize,
    pub prefill_started: bool,
    pub engine_threads_exited: usize,
}

#[derive(Default)]
struct Reply {
    tokens: VecDeque<Vec<u8>>,
    deltas: VecDeque<Delta>,
    final_delta: Delta,
    sampled: i32,
    error: String,
    next_handle: usize,
    abort: Option<NativeAbort>,
}

/// The abort callback and its data, as llama.cpp keeps them for a session.
#[derive(Clone, Copy)]
struct NativeAbort {
    poll: AbortFn,
    data: usize,
}

impl NativeAbort {
    fn raised(self) -> bool {
        // SAFETY: the model that passed this data at load is still open while its session is.
        unsafe { (self.poll)(self.data as *mut c_void) }
    }
}

#[derive(Default)]
pub struct FakeLlama {
    script: Mutex<Script>,
    seen: Arc<Mutex<Seen>>,
    reply: Mutex<Reply>,
}

pub fn delta(content: &str, reasoning: &str) -> Delta {
    Delta {
        status: TL_OK,
        content: content.to_owned(),
        reasoning: reasoning.to_owned(),
    }
}

impl FakeLlama {
    pub fn new() -> Arc<FakeLlama> {
        Arc::new(FakeLlama::default())
    }

    /// The opener a `LlamaBackend` is built over: it records the library load first.
    pub fn library(self: &Arc<FakeLlama>) -> Result<LoadedLibrary, EngineError> {
        self.record("load library");
        if let Some(failure) = self.script().library_failure.clone() {
            return Err(failure);
        }
        Ok(LoadedLibrary {
            calls: Arc::clone(self) as Arc<dyn LlamaCalls + Send + Sync>,
            file: PathBuf::from(FAKE_LIBRARY_FILE),
        })
    }

    pub fn script(&self) -> MutexGuard<'_, Script> {
        lock(&self.script)
    }

    pub fn seen(&self) -> MutexGuard<'_, Seen> {
        lock(&self.seen)
    }

    /// Each token comes with the delta the parse after it gives.
    pub fn reply(&self, token_deltas: &[(&str, Delta)], final_delta: Delta) {
        for (token, parsed) in token_deltas {
            self.reply_bytes(token.as_bytes(), Some(parsed.clone()));
        }
        self.reply_state().final_delta = final_delta;
    }

    /// A token, and the delta the parse after it gives when the engine parses there.
    pub fn reply_bytes(&self, token: &[u8], parsed: Option<Delta>) {
        let mut reply = self.reply_state();
        reply.tokens.push_back(token.to_vec());
        reply.deltas.extend(parsed);
    }

    pub fn call_names(&self) -> Vec<String> {
        self.seen()
            .calls
            .iter()
            .map(|call| call.name.clone())
            .collect()
    }

    pub fn opened_contexts(&self) -> Vec<i32> {
        self.seen()
            .opened
            .iter()
            .map(|open| open.context_size)
            .collect()
    }

    /// Reads the open session's abort flag through its callback, as llama.cpp would.
    pub fn native_abort_raised(&self) -> bool {
        self.reply_state().abort.is_some_and(NativeAbort::raised)
    }

    fn reply_state(&self) -> MutexGuard<'_, Reply> {
        lock(&self.reply)
    }

    fn record(&self, name: &str) {
        let thread = std::thread::current().name().unwrap_or("").to_owned();
        if thread == ENGINE_THREAD_NAME {
            note_engine_thread_exit(&self.seen);
        }
        self.seen().calls.push(Call {
            name: name.to_owned(),
            thread,
        });
    }

    fn note(&self, step: &str) {
        self.seen().lifecycle.push(step.to_owned());
    }

    fn fail_with<T>(&self, message: &str, sentinel: T) -> T {
        self.reply_state().error = message.to_owned();
        sentinel
    }

    /// Reports each scripted progress step; false from the callback cancels the load.
    unsafe fn report_progress(&self, request: &LoadRequest<'_>) -> bool {
        let steps = self.script().load_progress.clone();
        let Some(progress) = request.progress else {
            return true;
        };
        for step in steps {
            // SAFETY: the caller keeps the progress data valid until `load` returns.
            let carry_on = unsafe { progress(step, request.progress_data) };
            self.seen().progress_answers.push(carry_on);
            if !carry_on {
                return false;
            }
        }
        true
    }

    /// Blocks like a long prefill until llama.cpp's abort callback says stop.
    fn wait_for_abort(&self) -> i32 {
        self.seen().prefill_started = true;
        let deadline = Instant::now() + PREFILL_LIMIT;
        while Instant::now() < deadline && !self.native_abort_raised() {
            std::thread::sleep(ABORT_POLL);
        }
        if self.native_abort_raised() {
            self.note("abort seen");
        }
        self.note("prefill ended");
        TL_ABORTED
    }

    fn endless_token(&self) -> Token {
        let mut reply = self.reply_state();
        reply.sampled += 1;
        reply.deltas.push_back(delta("x", ""));
        Token {
            status: TOKEN_SAMPLED,
            piece: b"x".to_vec(),
        }
    }
}

impl LlamaCalls for FakeLlama {
    fn backend_init(&self) {
        self.record("backend_init");
    }

    unsafe fn load(&self, request: &LoadRequest<'_>) -> Result<Session, String> {
        self.record("load");
        self.seen().opened.push(Opened {
            path: request.path.to_string_lossy().into_owned(),
            context_size: request.n_ctx,
            threads: request.n_threads,
        });
        // SAFETY: forwarded from the caller's own guarantee.
        if !unsafe { self.report_progress(request) } {
            return Err(LOAD_ABORTED.to_owned());
        }
        if let Some(failure) = self.script().open_failure.clone() {
            return Err(failure);
        }
        let mut reply = self.reply_state();
        reply.next_handle += 1;
        reply.abort = request.abort.map(|poll| NativeAbort {
            poll,
            data: request.abort_data as usize,
        });
        let handle = NonNull::new(reply.next_handle as *mut c_void).expect("handles start at 1");
        // SAFETY: the handle is this fake's own session number, never dereferenced.
        Ok(unsafe { Session::from_raw(handle) })
    }

    fn model_info(&self, _session: &Session) -> ModelInfo {
        self.record("model_info");
        let n_ctx = self
            .seen()
            .opened
            .last()
            .map_or(0, |open| open.context_size);
        ModelInfo {
            n_ctx,
            n_ctx_train: self.script().trained_context,
        }
    }

    fn prepare(&self, _session: &mut Session, request_json: &str) -> i32 {
        self.record("prepare");
        let flag_at_start = self.native_abort_raised();
        {
            let mut seen = self.seen();
            seen.requests.push(request_json.to_owned());
            seen.abort_at_prepare.push(flag_at_start);
        }
        let (waits, sentinel, failure, prompt_tokens) = {
            let script = self.script();
            let failure = script.prepare_failure.clone();
            (
                script.prefill_waits_for_abort,
                script.prepare_sentinel,
                failure,
                script.prompt_tokens,
            )
        };
        if waits {
            return self.wait_for_abort();
        }
        if let Some(sentinel) = sentinel {
            return self.fail_with(&failure, sentinel);
        }
        self.reply_state().sampled = 0;
        prompt_tokens
    }

    fn start_sampling(&self, _session: &mut Session, sampling: &Sampling) -> i32 {
        self.record("start_sampling");
        self.seen().samplings.push(*sampling);
        match self.script().sampling_failure.clone() {
            Some(failure) => self.fail_with(&failure, TL_FAILED),
            None => TL_OK,
        }
    }

    fn next_token(&self, _session: &mut Session) -> Token {
        self.record("next_token");
        if let Some(message) = self.script().panic_on_next_token {
            panic!("{message}");
        }
        if self.script().endless_reply {
            return self.endless_token();
        }
        let token = self.reply_state().tokens.pop_front();
        match token {
            Some(piece) => {
                self.reply_state().sampled += 1;
                Token {
                    status: TOKEN_SAMPLED,
                    piece,
                }
            }
            None => self.end_of_reply(),
        }
    }

    fn parse_delta(&self, _session: &mut Session, is_partial: bool) -> Delta {
        self.record("parse_delta");
        if let Some(failure) = self.script().parse_failure.clone() {
            return self.fail_with(
                &failure,
                Delta {
                    status: TL_FAILED,
                    ..Delta::default()
                },
            );
        }
        if !is_partial {
            return self.reply_state().final_delta.clone();
        }
        self.seen().partial_parses += 1;
        self.reply_state().deltas.pop_front().unwrap_or_default()
    }

    fn stats(&self, _session: &Session) -> Stats {
        self.record("stats");
        let (prompt_tokens, context_full) = {
            let script = self.script();
            (script.prompt_tokens, script.context_full)
        };
        Stats {
            prompt_n: prompt_tokens,
            prompt_decoded: prompt_tokens,
            prompt_ms: 30.5,
            predicted_n: self.reply_state().sampled,
            predicted_ms: 40.0,
            context_full,
        }
    }

    fn last_error(&self, _session: &Session) -> String {
        self.reply_state().error.clone()
    }

    fn free(&self, session: Session) {
        self.record("free");
        self.seen().freed.push(session.as_ptr() as usize);
        self.reply_state().abort = None;
        self.note("free");
    }
}

impl FakeLlama {
    fn end_of_reply(&self) -> Token {
        let failure = self.script().token_failure.clone();
        if failure.is_empty() {
            return Token {
                status: END_OF_REPLY,
                piece: Vec::new(),
            };
        }
        self.fail_with(
            &failure,
            Token {
                status: TL_FAILED,
                piece: Vec::new(),
            },
        )
    }
}

thread_local! {
    static EXIT_NOTE: RefCell<Option<ExitNote>> = const { RefCell::new(None) };
}

/// Counts an engine thread as exited when its thread-local storage is torn down.
struct ExitNote(Arc<Mutex<Seen>>);

impl Drop for ExitNote {
    fn drop(&mut self) {
        lock(&self.0).engine_threads_exited += 1;
    }
}

fn note_engine_thread_exit(seen: &Arc<Mutex<Seen>>) {
    EXIT_NOTE.with(|note| {
        note.borrow_mut()
            .get_or_insert_with(|| ExitNote(Arc::clone(seen)));
    });
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
