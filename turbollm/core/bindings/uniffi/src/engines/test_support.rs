//! Test support for the engine objects: an executor with no tokio context (as UniFFI's own polling has none,
//! P-3), and a Rust foreign engine standing in for a Kotlin one.

use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::task::{Context, Poll, Wake, Waker};
use std::thread::{self, Thread};
use std::time::{Duration, Instant};

use turbollm_engine::REPLY_CANCELLED;

use crate::engines::dto::{
    CoreBackend, CoreChatMessage, CoreChatRole, CoreEngineConfig, CoreEngineDescriptor,
    CoreEngineEvent, CoreEngineKind, CoreFinishReason, CoreGenerateRequest, CoreGenerationParams,
    CoreLoadSpec, CoreLoadTarget, CoreMessageContent, CoreModelFormat, CoreModelInfo,
    CoreModelRefKind,
};
use crate::engines::engines::CoreEngines;
use crate::engines::failure::{CoreFailure, CoreFailureCode, CoreForeignException};
use crate::engines::foreign::{CoreEventSink, CoreForeignBackend, CoreForeignModel};

pub(crate) const WAIT_LIMIT: Duration = Duration::from_secs(5);
pub(crate) const FOREIGN_ENGINE: &str = "kotlin-gguf";
const POLL: Duration = Duration::from_millis(5);

/// Drives `future` to its end on this thread, failing the test after `WAIT_LIMIT`.
pub(crate) fn finish<F: Future>(future: F) -> F::Output {
    let deadline = Instant::now() + WAIT_LIMIT;
    let waker = Waker::from(Arc::new(Unpark(thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
            return output;
        }
        let left = deadline
            .checked_duration_since(Instant::now())
            .expect("the future did not finish in time");
        thread::park_timeout(left);
    }
}

/// Polls `future` once, as a caller that must not wait would.
pub(crate) fn poll_once<F: Future>(future: F) -> Poll<F::Output> {
    let mut cx = Context::from_waker(Waker::noop());
    pin!(future).poll(&mut cx)
}

/// Waits until `condition` holds, failing the test after `WAIT_LIMIT`.
pub(crate) fn eventually(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT_LIMIT;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(POLL);
    }
}

struct Unpark(Thread);

impl Wake for Unpark {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

pub(crate) fn config_in(dir: &Path) -> CoreEngineConfig {
    CoreEngineConfig {
        cache_dir: dir.join("cache").to_string_lossy().into_owned(),
        native_library_dir: None,
        load_journal_path: None,
        max_queued_requests: 8,
        load_stall_seconds: 120,
        forced_unavailable: Default::default(),
    }
}

pub(crate) fn descriptor(id: &str) -> CoreEngineDescriptor {
    CoreEngineDescriptor {
        id: id.to_owned(),
        name: format!("Kotlin engine {id}"),
        kind: CoreEngineKind::LlamaCpp,
        formats: vec![CoreModelFormat::Gguf],
        backends: vec![CoreBackend::Cpu],
    }
}

pub(crate) fn target(model: &str) -> CoreLoadTarget {
    CoreLoadTarget {
        ref_kind: CoreModelRefKind::Installed,
        ref_value: model.to_owned(),
        id: model.to_owned(),
        path: format!("/models/{model}.gguf"),
        format: CoreModelFormat::Gguf,
        engine_id: FOREIGN_ENGINE.to_owned(),
        context_size: Some(2048),
        threads: Some(2),
        backend: CoreBackend::Cpu,
    }
}

pub(crate) fn request() -> CoreGenerateRequest {
    CoreGenerateRequest {
        messages: vec![CoreChatMessage {
            role: CoreChatRole::User,
            content: CoreMessageContent::Text {
                text: "hi".to_owned(),
            },
        }],
        params: CoreGenerationParams {
            max_tokens: Some(8),
            temperature: None,
            top_p: None,
            top_k: None,
            seed: None,
            enable_thinking: false,
            template_kwargs: Default::default(),
        },
    }
}

pub(crate) fn prefilled() -> CoreEngineEvent {
    CoreEngineEvent::Prefilled {
        prompt_tokens: 3,
        prompt_ms: 1.5,
    }
}

pub(crate) fn text(piece: &str) -> CoreEngineEvent {
    CoreEngineEvent::Text {
        text: piece.to_owned(),
    }
}

pub(crate) fn done() -> CoreEngineEvent {
    CoreEngineEvent::Done {
        reason: CoreFinishReason::Stop,
        prompt_tokens: 3,
        completion_tokens: 2,
        prompt_ms: 1.5,
        gen_ms: 4.0,
    }
}

/// How the fake's model replies.
#[derive(Clone)]
pub(crate) enum Reply {
    /// Emits the events and returns.
    Events(Vec<CoreEngineEvent>),
    /// Emits the events, then waits for the abort and ends cancelled.
    UntilAborted(Vec<CoreEngineEvent>),
}

/// A Rust foreign engine: what it was asked to do is logged in order.
pub(crate) struct FakeForeign {
    reply: Reply,
    open_failure: Option<CoreFailure>,
    log: Arc<Log>,
    reentry: Option<Arc<Reentry>>,
    reenter_on_open: bool,
}

impl FakeForeign {
    pub(crate) fn replying(reply: Reply) -> FakeForeign {
        FakeForeign {
            reply,
            open_failure: None,
            log: Arc::new(Log::default()),
            reentry: None,
            reenter_on_open: false,
        }
    }

    pub(crate) fn failing_open(failure: CoreFailure) -> FakeForeign {
        FakeForeign {
            open_failure: Some(failure),
            ..FakeForeign::replying(Reply::Events(vec![]))
        }
    }

    /// Calls back into the core from its generate (or its open) and records each answer.
    pub(crate) fn reentering(mut self, reentry: &Arc<Reentry>, on_open: bool) -> FakeForeign {
        self.reentry = Some(Arc::clone(reentry));
        self.reenter_on_open = on_open;
        self
    }

    pub(crate) fn log(&self) -> Arc<Log> {
        Arc::clone(&self.log)
    }

    fn reenter(&self, on_open: bool) {
        if let Some(reentry) = self
            .reentry
            .as_ref()
            .filter(|_| self.reenter_on_open == on_open)
        {
            reentry.call_every_export();
        }
    }
}

impl CoreForeignBackend for FakeForeign {
    fn probe(&self) -> Option<String> {
        None
    }

    fn open(&self, spec: CoreLoadSpec) -> Result<Arc<dyn CoreForeignModel>, CoreForeignException> {
        self.log.add(format!("open {}", spec.path));
        self.reenter(true);
        if let Some(failure) = self.open_failure.clone() {
            return Err(CoreForeignException::Failed { failure });
        }
        Ok(Arc::new(FakeModel {
            reply: self.reply.clone(),
            log: Arc::clone(&self.log),
            reentry: self.reentry.clone().filter(|_| !self.reenter_on_open),
            kept_sink: Mutex::new(None),
        }))
    }
}

/// Keeps the last sink it was lent, as a Kotlin object can outlive its call until a GC.
struct FakeModel {
    reply: Reply,
    log: Arc<Log>,
    reentry: Option<Arc<Reentry>>,
    kept_sink: Mutex<Option<Arc<CoreEventSink>>>,
}

impl CoreForeignModel for FakeModel {
    fn info(&self) -> CoreModelInfo {
        CoreModelInfo {
            context_size: 2048,
            trained_context: Some(32768),
            backend: CoreBackend::Cpu,
            notes: vec!["foreign".to_owned()],
        }
    }

    fn generate(
        &self,
        _request: CoreGenerateRequest,
        sink: Arc<CoreEventSink>,
    ) -> Result<(), CoreForeignException> {
        self.log.add("generate");
        *self
            .kept_sink
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Arc::clone(&sink));
        if let Some(reentry) = &self.reentry {
            reentry.call_every_export();
        }
        match &self.reply {
            Reply::Events(events) => emit_all(&sink, events),
            Reply::UntilAborted(events) => {
                emit_all(&sink, events)?;
                self.wait_for_abort(&sink)
            }
        }
    }

    fn request_abort(&self) {
        self.log.add("request_abort");
    }

    fn release(&self) {
        self.log.add("release");
    }
}

impl FakeModel {
    fn wait_for_abort(&self, sink: &CoreEventSink) -> Result<(), CoreForeignException> {
        let deadline = Instant::now() + WAIT_LIMIT;
        while !sink.is_aborted() && Instant::now() < deadline {
            thread::sleep(POLL);
        }
        self.log.add(format!("aborted {}", sink.is_aborted()));
        Err(CoreForeignException::Failed {
            failure: CoreFailure {
                code: CoreFailureCode::Cancelled,
                detail: REPLY_CANCELLED.to_owned(),
                engine_id: None,
                engine_kind: None,
                param: None,
                invalid_reason: None,
            },
        })
    }
}

fn emit_all(sink: &CoreEventSink, events: &[CoreEngineEvent]) -> Result<(), CoreForeignException> {
    for event in events {
        sink.emit(event.clone());
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Log {
    entries: Mutex<Vec<String>>,
}

impl Log {
    fn add(&self, entry: impl Into<String>) {
        self.entries().push(entry.into());
    }

    pub(crate) fn snapshot(&self) -> Vec<String> {
        self.entries().clone()
    }

    pub(crate) fn has(&self, entry: &str) -> bool {
        self.entries().iter().any(|logged| logged == entry)
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One export a foreign engine called, and what it got: `Ready(Some(failure))` refused, `Ready(None)` served,
/// `Pending` would have waited.
pub(crate) type ExportAnswer = (&'static str, Poll<Option<CoreFailure>>);

/// What a foreign engine gets back when it calls the core from its engine thread.
#[derive(Default)]
pub(crate) struct Reentry {
    core: OnceLock<Weak<CoreEngines>>,
    answers: Mutex<Vec<ExportAnswer>>,
}

impl Reentry {
    pub(crate) fn aim_at(&self, core: &Arc<CoreEngines>) {
        self.core.set(Arc::downgrade(core)).expect("aimed once");
    }

    pub(crate) fn answers(&self) -> Vec<ExportAnswer> {
        self.answers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn call_every_export(&self) {
        let core = self
            .core
            .get()
            .and_then(Weak::upgrade)
            .expect("aimed at a live core");
        let answers = vec![
            ("list", Poll::Ready(core.list().err().map(failure_of))),
            (
                "snapshot",
                Poll::Ready(core.snapshot().err().map(failure_of)),
            ),
            (
                "resolve",
                Poll::Ready(
                    core.resolve(CoreModelFormat::Gguf, None)
                        .err()
                        .map(failure_of),
                ),
            ),
            (
                "claim_load",
                Poll::Ready(core.claim_load(target("again")).err().map(failure_of)),
            ),
            ("next_snapshot", refusal(poll_once(core.next_snapshot(0)))),
            ("generate", refusal(poll_once(core.generate(request())))),
            ("unload", refusal(poll_once(core.unload()))),
            ("shutdown", refusal(poll_once(core.shutdown()))),
        ];
        *self.answers.lock().unwrap_or_else(PoisonError::into_inner) = answers;
    }
}

fn refusal<T>(
    answer: Poll<Result<T, crate::engines::failure::CoreEngineException>>,
) -> Poll<Option<CoreFailure>> {
    answer.map(|answered| answered.err().map(failure_of))
}

pub(crate) fn failure_of(error: crate::engines::failure::CoreEngineException) -> CoreFailure {
    let crate::engines::failure::CoreEngineException::Failed { failure } = error;
    failure
}
