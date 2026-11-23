//! The in-process kind: a native library driven from Rust, each loaded model on its own named
//! engine thread (arch 2.3.3, rules T-1, T-3, T-5).

mod backend;
mod sink;
mod thread;

use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

use tokio::sync::oneshot;
use turbollm_platform::HostFacts;

use crate::descriptor::{EngineDescriptor, ModelInfo};
use crate::engine::{
    AbortHook, AbortSignal, BoxFuture, Engine, EventStream, LoadControl, LoadedModel, StallPolicy,
};
use crate::error::{EngineError, MODEL_UNLOADED};
use crate::manager::GatePermit;
use crate::request::{GenerateRequest, LoadSpec};

pub use backend::{NativeBackend, NativeModel};
pub use sink::{EventSink, SinkClosed};
pub(crate) use thread::panic_message;

/// An `Engine` over a native backend that runs each loaded model on its own thread.
pub struct InProcess<B: NativeBackend> {
    backend: Arc<B>,
}

impl<B: NativeBackend> InProcess<B> {
    pub fn new(backend: B) -> InProcess<B> {
        InProcess {
            backend: Arc::new(backend),
        }
    }
}

impl<B: NativeBackend> Engine for InProcess<B> {
    fn descriptor(&self) -> &EngineDescriptor {
        self.backend.descriptor()
    }

    fn probe(&self, host: &HostFacts) -> Option<String> {
        self.backend.probe(host)
    }

    fn stall_policy(&self) -> StallPolicy {
        self.backend.stall_policy()
    }

    /// Starts the model's engine thread at once; the future resolves when the open finished.
    /// Dropping the future before then makes the thread free whatever it opened.
    fn load(
        &self,
        spec: LoadSpec,
        ctl: LoadControl,
    ) -> BoxFuture<Result<Box<dyn LoadedModel>, EngineError>> {
        let (opened_reply, opened) = oneshot::channel();
        let (commands, served) = mpsc::channel();
        let started = thread::spawn_engine_thread(
            Arc::clone(&self.backend),
            (spec, ctl),
            opened_reply,
            served,
        );
        Box::pin(async move {
            let engine_thread = started?;
            let opened = opened
                .await
                .unwrap_or_else(|_| Err(engine_thread_stopped()))?;
            let model: Box<dyn LoadedModel> = Box::new(InProcessModel {
                info: opened.info,
                abort_hook: opened.abort_hook,
                commands,
                engine_thread: Some(engine_thread),
            });
            Ok(model)
        })
    }
}

fn engine_thread_stopped() -> EngineError {
    EngineError::EngineFailure(thread::THREAD_STOPPED.to_owned())
}

/// A model open on its engine thread. Dropping it without `close` asks the thread to free the
/// model and detaches; nothing ever joins from the dropping thread (T-5).
struct InProcessModel {
    info: ModelInfo,
    abort_hook: AbortHook,
    commands: mpsc::Sender<thread::Command>,
    engine_thread: Option<JoinHandle<()>>,
}

impl LoadedModel for InProcessModel {
    fn info(&self) -> &ModelInfo {
        &self.info
    }

    fn slots(&self) -> u32 {
        1
    }

    fn generate(
        &self,
        req: GenerateRequest,
        permit: GatePermit,
        abort: AbortSignal,
    ) -> Result<EventStream, EngineError> {
        let (sink, stream) = sink::reply_channel(&abort);
        abort.add_hook(Arc::clone(&self.abort_hook));
        let generate = thread::Command::Generate {
            req,
            sink,
            permit,
            abort,
        };
        self.commands
            .send(generate)
            .map_err(|_| EngineError::ModelNotLoaded(MODEL_UNLOADED.to_owned()))?;
        Ok(stream)
    }

    fn close(mut self: Box<Self>) -> BoxFuture<()> {
        let (joined, on_joined) = oneshot::channel();
        if let Some(engine_thread) = self.engine_thread.take() {
            self.request_close();
            thread::join_in_background(engine_thread, joined);
        }
        Box::pin(async move {
            let _ = on_joined.await;
        })
    }
}

impl InProcessModel {
    /// An engine thread that already stopped has nothing left to free.
    fn request_close(&self) {
        let _ = self.commands.send(thread::Command::Close);
    }
}

impl Drop for InProcessModel {
    fn drop(&mut self) {
        if self.engine_thread.take().is_some() {
            self.request_close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::REPLY_CANCELLED;
    use crate::event::{EngineEvent, FinishReason};
    use crate::inprocess::sink::tests::next_event;
    use crate::manager::GenerationGate;
    use crate::request::{ChatMessage, GenerationParams, MessageContent, Role};
    use crate::testing::{SCRIPTED_THREAD_NAME, ScriptRecord, ScriptedBackend, Step};
    use crate::{Backend, EngineId};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    const WAIT_LIMIT: Duration = Duration::from_secs(1);

    fn spec() -> LoadSpec {
        LoadSpec {
            path: PathBuf::from("model.gguf"),
            context_size: None,
            threads: 4,
            backend: Backend::Cpu,
            cache_dir: PathBuf::from("cache"),
        }
    }

    fn control() -> LoadControl {
        LoadControl {
            progress: Arc::new(|_| {}),
            abort: AbortSignal::new(),
        }
    }

    fn request() -> GenerateRequest {
        GenerateRequest {
            messages: vec![ChatMessage {
                role: Role::User,
                content: MessageContent::Text("hi".to_owned()),
            }],
            params: GenerationParams::default(),
        }
    }

    fn prefilled() -> EngineEvent {
        EngineEvent::Prefilled {
            prompt_tokens: 3,
            prompt_ms: 1.0,
        }
    }

    fn text(piece: &str) -> EngineEvent {
        EngineEvent::Text(piece.to_owned())
    }

    fn done() -> EngineEvent {
        EngineEvent::Done {
            reason: FinishReason::Stop,
            prompt_tokens: 3,
            completion_tokens: 2,
            prompt_ms: 1.0,
            gen_ms: 2.0,
        }
    }

    async fn one_slot_gate() -> (GenerationGate, GatePermit) {
        let gate = GenerationGate::new(1, 8, Box::new(|| {}));
        let permit = gate.acquire().await.unwrap();
        (gate, permit)
    }

    async fn load(backend: ScriptedBackend) -> (Box<dyn LoadedModel>, Arc<ScriptRecord>) {
        let record = backend.record();
        let model = InProcess::new(backend)
            .load(spec(), control())
            .await
            .unwrap();
        (model, record)
    }

    async fn drain(stream: &mut EventStream) -> Vec<Result<EngineEvent, EngineError>> {
        let mut events = Vec::new();
        while let Some(event) = next_event(stream).await {
            events.push(event);
        }
        events
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + WAIT_LIMIT;
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        condition()
    }

    fn has(record: &ScriptRecord, entry: &str) -> bool {
        record.history().iter().any(|seen| seen == entry)
    }

    #[test]
    fn the_engine_reports_its_backends_descriptor_probe_and_stall_policy() {
        let backend = ScriptedBackend::new(Vec::new());
        let engine = InProcess::new(backend);
        assert_eq!(
            engine.descriptor().id,
            EngineId::new(EngineId::LLAMA_CPP_CPU)
        );
        assert_eq!(engine.probe(&HostFacts::detect()), None);
        assert_eq!(engine.stall_policy(), StallPolicy::Watch);
    }

    #[tokio::test]
    async fn the_model_opens_on_a_thread_named_by_the_backend() {
        let (model, record) = load(ScriptedBackend::new(Vec::new())).await;
        assert_eq!(record.open_thread().as_deref(), Some(SCRIPTED_THREAD_NAME));
        assert_eq!(model.info().context_size, 4096);
        assert_eq!(model.slots(), 1);
    }

    #[tokio::test]
    async fn a_failed_open_is_the_loads_error() {
        let failure = EngineError::ModelLoadFailed("not a GGUF file".to_owned());
        let backend = ScriptedBackend::new(Vec::new()).with_open_failure(failure.clone());
        let loaded = InProcess::new(backend).load(spec(), control()).await;
        assert_eq!(loaded.err(), Some(failure));
    }

    #[tokio::test]
    async fn a_panicking_open_is_a_load_failure_carrying_the_panic_message() {
        let backend = ScriptedBackend::new(Vec::new()).with_open_panic("the weights are torn");
        let loaded = InProcess::new(backend).load(spec(), control()).await;
        assert_eq!(
            loaded.err(),
            Some(EngineError::ModelLoadFailed(
                "the weights are torn".to_owned()
            ))
        );
    }

    #[tokio::test]
    async fn generated_events_arrive_in_order_and_the_stream_then_ends() {
        let script = vec![
            Step::Emit(prefilled()),
            Step::Emit(text("Hel")),
            Step::Emit(text("lo")),
            Step::Emit(done()),
        ];
        let (model, _record) = load(ScriptedBackend::new(script)).await;
        let (_gate, permit) = one_slot_gate().await;
        let mut stream = model
            .generate(request(), permit, AbortSignal::new())
            .unwrap();
        let expected = [prefilled(), text("Hel"), text("lo"), done()].map(Ok);
        assert_eq!(drain(&mut stream).await, expected);
    }

    #[tokio::test]
    async fn the_permit_is_released_only_after_the_backends_generate_returned() {
        let script = vec![
            Step::Emit(prefilled()),
            Step::Pause(Duration::from_millis(400)),
            Step::Emit(done()),
        ];
        let (model, record) = load(ScriptedBackend::new(script)).await;
        let (gate, permit) = one_slot_gate().await;
        let mut stream = model
            .generate(request(), permit, AbortSignal::new())
            .unwrap();
        assert_eq!(next_event(&mut stream).await, Some(Ok(prefilled())));
        assert!(gate.busy());
        assert!(!has(&record, "generate returned"));
        drain(&mut stream).await;
        assert!(has(&record, "generate returned"));
        assert!(!gate.busy());
    }

    #[tokio::test]
    async fn a_dropped_stream_makes_the_backend_see_an_abort() {
        let script = vec![
            Step::Pause(Duration::from_millis(100)),
            Step::Emit(text("lost")),
        ];
        let (model, record) = load(ScriptedBackend::new(script)).await;
        let (gate, permit) = one_slot_gate().await;
        let stream = model
            .generate(request(), permit, AbortSignal::new())
            .unwrap();
        drop(stream);
        assert!(wait_until(|| has(&record, "aborted")).await);
        assert!(wait_until(|| !gate.busy()).await);
    }

    #[tokio::test]
    async fn a_failing_generation_reports_its_error_on_the_stream() {
        let failure = EngineError::EngineFailure("decode failed".to_owned());
        let script = vec![Step::Emit(prefilled()), Step::Fail(failure.clone())];
        let (model, _record) = load(ScriptedBackend::new(script)).await;
        let (_gate, permit) = one_slot_gate().await;
        let mut stream = model
            .generate(request(), permit, AbortSignal::new())
            .unwrap();
        assert_eq!(drain(&mut stream).await, [Ok(prefilled()), Err(failure)]);
    }

    #[tokio::test]
    async fn an_abort_runs_the_models_hook_and_ends_the_stream() {
        let script = vec![
            Step::Emit(prefilled()),
            Step::Pause(Duration::from_secs(30)),
        ];
        let (model, record) = load(ScriptedBackend::new(script)).await;
        let (_gate, permit) = one_slot_gate().await;
        let abort = AbortSignal::new();
        let mut stream = model.generate(request(), permit, abort.clone()).unwrap();
        assert_eq!(next_event(&mut stream).await, Some(Ok(prefilled())));
        abort.abort();
        let cancelled = EngineError::Cancelled(REPLY_CANCELLED.to_owned());
        let rest = drain(&mut stream).await;
        assert!(
            rest.iter().all(|item| *item == Err(cancelled.clone())),
            "the abort closes the reply; only the engine's own cancel may come first: {rest:?}"
        );
        assert!(has(&record, "abort hook"));
    }

    #[tokio::test]
    async fn an_abort_raised_after_the_native_call_returned_never_reaches_the_model() {
        let (model, record) = load(ScriptedBackend::new(vec![Step::Emit(done())])).await;
        let (gate, permit) = one_slot_gate().await;
        let abort = AbortSignal::new();
        let mut stream = model.generate(request(), permit, abort.clone()).unwrap();
        assert_eq!(drain(&mut stream).await, [Ok(done())]);
        assert!(wait_until(|| !gate.busy()).await);

        abort.abort();

        assert!(!has(&record, "abort hook"), "{:?}", record.history());
    }

    #[tokio::test]
    async fn close_resolves_only_after_the_engine_thread_joined() {
        let backend = ScriptedBackend::new(Vec::new()).with_close_pause(Duration::from_millis(100));
        let (model, record) = load(backend).await;
        model.close().await;
        assert!(record.engine_thread_exited());
        assert_eq!(record.history().last().map(String::as_str), Some("close"));
    }

    #[tokio::test]
    async fn a_dropped_model_is_freed_on_its_thread_without_joining_the_dropper() {
        let backend = ScriptedBackend::new(Vec::new()).with_close_pause(Duration::from_millis(300));
        let (model, record) = load(backend).await;
        let dropping = Instant::now();
        drop(model);
        assert!(dropping.elapsed() < Duration::from_millis(150));
        assert!(!record.engine_thread_exited());
        assert!(wait_until(|| record.engine_thread_exited()).await);
        assert!(has(&record, "close"));
    }
}
