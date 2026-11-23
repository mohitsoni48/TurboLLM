use std::any::Any;
use std::panic::{self, AssertUnwindSafe};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::{Builder, JoinHandle};

use tokio::sync::oneshot;

use crate::descriptor::ModelInfo;
use crate::engine::{AbortHook, AbortSignal, LoadControl};
use crate::error::EngineError;
use crate::inprocess::backend::{NativeBackend, NativeModel};
use crate::inprocess::sink::EventSink;
use crate::manager::GatePermit;
use crate::request::{GenerateRequest, LoadSpec};

const JOINER_THREAD_NAME: &str = "turbollm-join";
const THREAD_NOT_STARTED: &str = "The engine thread could not be started: ";
pub(crate) const THREAD_STOPPED: &str = "The engine thread stopped before the model was open.";
const PANIC_WITHOUT_MESSAGE: &str = "The engine panicked while opening the model.";

/// What the engine thread is asked to do once its model is open.
pub(crate) enum Command {
    Generate {
        req: GenerateRequest,
        sink: EventSink,
        permit: GatePermit,
        abort: AbortSignal,
        /// Reaches the model-wide abort hook; raised by `abort`.
        interrupt: AbortSignal,
    },
    Close,
}

/// The open model's facts the async side keeps.
pub(crate) struct Opened {
    pub(crate) info: ModelInfo,
    pub(crate) abort_hook: AbortHook,
}

pub(crate) type OpenReply = oneshot::Sender<Result<Opened, EngineError>>;

/// Starts the model's engine thread: it opens the model, then serves commands until `Close` or
/// until every command sender is gone, and frees the model before it exits (T-5).
pub(crate) fn spawn_engine_thread<B: NativeBackend>(
    backend: Arc<B>,
    load: (LoadSpec, LoadControl),
    opened: OpenReply,
    commands: mpsc::Receiver<Command>,
) -> Result<JoinHandle<()>, EngineError> {
    Builder::new()
        .name(backend.thread_name().to_owned())
        .spawn(move || run_engine_thread(backend.as_ref(), load, opened, commands))
        .map_err(|error| EngineError::EngineFailure(format!("{THREAD_NOT_STARTED}{error}")))
}

/// Joins the engine thread off the caller's thread, then answers `joined`, so an async `close`
/// resolves after the thread is gone without blocking its executor (T-2, T-5).
pub(crate) fn join_in_background(engine_thread: JoinHandle<()>, joined: oneshot::Sender<()>) {
    // A joiner that cannot start drops `joined`, so `close` still resolves; the engine thread
    // was already told to close and frees the model on its own.
    let _ = Builder::new()
        .name(JOINER_THREAD_NAME.to_owned())
        .spawn(move || {
            let _ = engine_thread.join();
            let _ = joined.send(());
        });
}

fn run_engine_thread<B: NativeBackend>(
    backend: &B,
    (spec, ctl): (LoadSpec, LoadControl),
    opened: OpenReply,
    commands: mpsc::Receiver<Command>,
) {
    if let Some(model) = open_model(backend, &spec, &ctl, opened) {
        serve(model, &commands);
    }
}

/// Opens the model and answers the load; the model comes back only when the open succeeded.
fn open_model<B: NativeBackend>(
    backend: &B,
    spec: &LoadSpec,
    ctl: &LoadControl,
    opened: OpenReply,
) -> Option<B::Model> {
    match open_catching_panics(backend, spec, ctl) {
        Ok((model, info)) => {
            let abort_hook = model.abort_hook();
            let _ = opened.send(Ok(Opened { info, abort_hook }));
            Some(model)
        }
        Err(error) => {
            let _ = opened.send(Err(error));
            None
        }
    }
}

fn open_catching_panics<B: NativeBackend>(
    backend: &B,
    spec: &LoadSpec,
    ctl: &LoadControl,
) -> Result<(B::Model, ModelInfo), EngineError> {
    panic::catch_unwind(AssertUnwindSafe(|| backend.open(spec, ctl))).unwrap_or_else(|payload| {
        let message = panic_message(payload, PANIC_WITHOUT_MESSAGE);
        Err(EngineError::ModelLoadFailed(message))
    })
}

/// The text a panic carried, or `without_message` when it carried none.
pub(crate) fn panic_message(payload: Box<dyn Any + Send>, without_message: &str) -> String {
    match payload.downcast::<String>() {
        Ok(message) => *message,
        Err(payload) => payload
            .downcast_ref::<&str>()
            .map_or(without_message, |message| message)
            .to_owned(),
    }
}

/// Runs each generation to its end, then frees the model; a load whose caller left before the
/// model was handed over ends here too, because its command sender is gone. A generation's abort
/// stops reaching the model once its native call returned (E-11), yet still wakes a failure
/// waiting on a consumer that stopped reading (E-26).
fn serve<M: NativeModel>(mut model: M, commands: &mpsc::Receiver<Command>) {
    while let Ok(Command::Generate {
        req,
        mut sink,
        permit,
        abort,
        interrupt,
    }) = commands.recv()
    {
        let generated = model.generate(&req, &mut sink, &abort);
        interrupt.retire();
        drop(permit);
        if let Err(error) = generated {
            sink.fail(error);
        }
        abort.retire();
    }
    model.close();
}
