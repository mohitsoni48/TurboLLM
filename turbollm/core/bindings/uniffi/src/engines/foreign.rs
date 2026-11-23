//! Engines Kotlin implements (arch 3.3 foreign traits). Each runs like a native backend: every call on its
//! model's engine thread (T-10), the abort request from any thread. An engine thread is marked, and the core
//! refuses a call made from one (P-17), because the engine thread is what the core would wait for.

use std::cell::Cell;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use turbollm_engine::{
    AbortHook, AbortSignal, Engine, EngineDescriptor, EngineError, EngineEvent, EventSink,
    GenerateRequest, InProcess, LoadControl, LoadSpec, ModelInfo, NativeBackend, NativeModel,
    StallPolicy,
};
use turbollm_platform::HostFacts;

use crate::engines::dto::{
    CoreEngineDescriptor, CoreEngineEvent, CoreGenerateRequest, CoreLoadSpec, CoreModelInfo,
};
use crate::engines::failure::CoreForeignException;

/// P-17: what a foreign engine gets when it calls the core from its engine thread.
pub const REENTRY_REFUSED: &str =
    "A foreign engine called back into the TurboLLM core from its engine thread.";

const FOREIGN_THREAD_NAME: &str = "turbollm-foreign";

/// A Kotlin engine: `probe` says why it cannot run here (`None` = it can); `open` blocks its engine thread.
#[uniffi::export(with_foreign)]
pub trait CoreForeignBackend: Send + Sync {
    fn probe(&self) -> Option<String>;
    fn open(&self, spec: CoreLoadSpec) -> Result<Arc<dyn CoreForeignModel>, CoreForeignException>;
}

/// A model a Kotlin engine holds open. `request_abort` may come from any thread; the rest run on the engine
/// thread, and none of them may call back into `CoreEngines`. `release` frees the model (arch 3.3 named it `close`,
/// which clashes with `AutoCloseable.close()` on the generated Kotlin wrapper).
#[uniffi::export(with_foreign)]
pub trait CoreForeignModel: Send + Sync {
    fn info(&self) -> CoreModelInfo;
    fn generate(
        &self,
        request: CoreGenerateRequest,
        sink: Arc<CoreEventSink>,
    ) -> Result<(), CoreForeignException>;
    fn request_abort(&self);
    fn release(&self);
}

/// Where a Kotlin generate writes its reply. It is lent for one generate only: afterwards `emit` refuses.
#[derive(uniffi::Object)]
pub struct CoreEventSink {
    lent: Mutex<Option<EventSink>>,
    abort: AbortSignal,
    refused: Mutex<Option<EngineError>>,
}

#[uniffi::export]
impl CoreEventSink {
    /// Blocks while the reader is behind; `false` means the reader has gone and the reply should stop.
    pub fn emit(&self, event: CoreEngineEvent) -> bool {
        match EngineEvent::try_from(event) {
            Ok(readable) => self.deliver(readable),
            Err(refusal) => {
                self.refuse(refusal);
                false
            }
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.abort.is_aborted()
    }
}

impl CoreEventSink {
    fn lend(sink: &EventSink, abort: &AbortSignal) -> CoreEventSink {
        CoreEventSink {
            lent: Mutex::new(Some(sink.clone())),
            abort: abort.clone(),
            refused: Mutex::new(None),
        }
    }

    /// Takes the sink back; the event Kotlin sent that the core could not read, if any, fails the reply.
    fn give_back(&self) -> Result<(), EngineError> {
        self.lent().take();
        self.refused().take().map_or(Ok(()), Err)
    }

    fn deliver(&self, event: EngineEvent) -> bool {
        self.lent()
            .as_mut()
            .is_some_and(|sink| sink.emit(event).is_ok())
    }

    /// The reply ends with the first refusal; nothing Kotlin emits after it is delivered.
    fn refuse(&self, refusal: EngineError) {
        self.lent().take();
        self.refused().get_or_insert(refusal);
    }

    fn lent(&self) -> MutexGuard<'_, Option<EventSink>> {
        self.lent.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn refused(&self) -> MutexGuard<'_, Option<EngineError>> {
        self.refused.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A Kotlin exception the trait does not declare reads as an engine failure.
impl From<uniffi::UnexpectedUniFFICallbackError> for CoreForeignException {
    fn from(unexpected: uniffi::UnexpectedUniFFICallbackError) -> Self {
        CoreForeignException::Failed {
            failure: EngineError::EngineFailure(unexpected.reason).into(),
        }
    }
}

/// The catalogue engine of one Kotlin backend, under the descriptor Kotlin gave it.
pub(crate) fn foreign_engine(
    descriptor: CoreEngineDescriptor,
    backend: Arc<dyn CoreForeignBackend>,
) -> Arc<dyn Engine> {
    Arc::new(InProcess::new(ForeignBackend {
        descriptor: descriptor.into(),
        foreign: backend,
    }))
}

/// Refuses a core call made from an engine thread (P-17).
pub(crate) fn refuse_reentry() -> Result<(), EngineError> {
    match ON_ENGINE_THREAD.with(Cell::get) {
        true => Err(EngineError::EngineFailure(REENTRY_REFUSED.to_owned())),
        false => Ok(()),
    }
}

thread_local! {
    static ON_ENGINE_THREAD: Cell<bool> = const { Cell::new(false) };
}

fn mark_engine_thread() {
    ON_ENGINE_THREAD.with(|marked| marked.set(true));
}

struct ForeignBackend {
    descriptor: EngineDescriptor,
    foreign: Arc<dyn CoreForeignBackend>,
}

impl NativeBackend for ForeignBackend {
    type Model = ForeignModel;

    fn descriptor(&self) -> &EngineDescriptor {
        &self.descriptor
    }

    fn probe(&self, _host: &HostFacts) -> Option<String> {
        self.foreign.probe()
    }

    /// A foreign open has no way to report progress, so a stall watch would abort every slow load.
    fn stall_policy(&self) -> StallPolicy {
        StallPolicy::Exempt
    }

    fn thread_name(&self) -> &'static str {
        FOREIGN_THREAD_NAME
    }

    fn open(
        &self,
        spec: &LoadSpec,
        _ctl: &LoadControl,
    ) -> Result<(ForeignModel, ModelInfo), EngineError> {
        mark_engine_thread();
        let model = ForeignModel {
            foreign: self.foreign.open(spec.clone().into())?,
        };
        match ModelInfo::try_from(model.foreign.info()) {
            Ok(info) => Ok((model, info)),
            Err(refusal) => {
                model.close();
                Err(refusal)
            }
        }
    }
}

struct ForeignModel {
    foreign: Arc<dyn CoreForeignModel>,
}

impl NativeModel for ForeignModel {
    fn generate(
        &mut self,
        req: &GenerateRequest,
        sink: &mut EventSink,
        abort: &AbortSignal,
    ) -> Result<(), EngineError> {
        let lent = Arc::new(CoreEventSink::lend(sink, abort));
        let generated = self.foreign.generate(req.clone().into(), Arc::clone(&lent));
        lent.give_back().and(generated.map_err(EngineError::from))
    }

    fn abort_hook(&self) -> AbortHook {
        let foreign = Arc::clone(&self.foreign);
        Arc::new(move || foreign.request_abort())
    }

    fn close(self) {
        self.foreign.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::failure::CoreFailureCode;

    #[test]
    fn the_reentry_text_is_the_plans_p17_text() {
        assert_eq!(
            REENTRY_REFUSED,
            "A foreign engine called back into the TurboLLM core from its engine thread."
        );
    }

    #[test]
    fn a_thread_that_never_ran_a_foreign_engine_may_call_the_core() {
        assert_eq!(refuse_reentry(), Ok(()));
    }

    #[test]
    fn a_thread_that_opened_a_foreign_engine_is_refused_with_the_p17_text() {
        std::thread::spawn(|| {
            mark_engine_thread();
            assert_eq!(
                refuse_reentry(),
                Err(EngineError::EngineFailure(REENTRY_REFUSED.to_owned()))
            );
        })
        .join()
        .unwrap();
    }

    #[test]
    fn an_undeclared_kotlin_exception_reads_as_an_engine_failure() {
        let unexpected =
            uniffi::UnexpectedUniFFICallbackError::new("java.lang.RuntimeException: boom");
        let CoreForeignException::Failed { failure } = CoreForeignException::from(unexpected);
        assert_eq!(failure.code, CoreFailureCode::EngineFailure);
        assert_eq!(failure.detail, "java.lang.RuntimeException: boom");
    }

    #[test]
    fn a_foreign_engine_is_never_stall_watched_because_it_cannot_report_progress() {
        let backend = backend_without_models();
        assert_eq!(backend.stall_policy(), StallPolicy::Exempt);
    }

    #[test]
    fn the_foreign_probe_answers_for_the_engine() {
        struct Missing;
        impl CoreForeignBackend for Missing {
            fn probe(&self) -> Option<String> {
                Some("no GPU".to_owned())
            }
            fn open(
                &self,
                _spec: CoreLoadSpec,
            ) -> Result<Arc<dyn CoreForeignModel>, CoreForeignException> {
                unreachable!()
            }
        }
        let backend = ForeignBackend {
            descriptor: crate::engines::test_support::descriptor("k").into(),
            foreign: Arc::new(Missing),
        };
        assert_eq!(
            backend.probe(&HostFacts::detect()),
            Some("no GPU".to_owned())
        );
    }

    fn backend_without_models() -> ForeignBackend {
        ForeignBackend {
            descriptor: crate::engines::test_support::descriptor("k").into(),
            foreign: Arc::new(crate::engines::test_support::FakeForeign::replying(
                crate::engines::test_support::Reply::Events(vec![]),
            )),
        }
    }
}
