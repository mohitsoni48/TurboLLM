use turbollm_platform::HostFacts;

use crate::descriptor::{EngineDescriptor, ModelInfo};
use crate::engine::{AbortHook, AbortSignal, LoadControl, StallPolicy};
use crate::error::EngineError;
use crate::inprocess::sink::EventSink;
use crate::request::{GenerateRequest, LoadSpec};

/// A native library the core drives in-process, one engine thread per open model.
pub trait NativeBackend: Send + Sync + 'static {
    type Model: NativeModel;
    fn descriptor(&self) -> &EngineDescriptor;
    fn probe(&self, host: &HostFacts) -> Option<String>;
    fn stall_policy(&self) -> StallPolicy;
    /// "turbollm-llama" | "turbollm-litert"
    fn thread_name(&self) -> &'static str;
    /// Blocking; runs on the model's engine thread.
    fn open(
        &self,
        spec: &LoadSpec,
        ctl: &LoadControl,
    ) -> Result<(Self::Model, ModelInfo), EngineError>;
}

/// One open native model. Every call but `abort_hook`'s hook runs on its engine thread (T-1).
pub trait NativeModel: Send + 'static {
    /// Blocking; on the engine thread. Emits Prefilled first and returns the Done it also emitted.
    fn generate(
        &mut self,
        req: &GenerateRequest,
        sink: &mut EventSink,
        abort: &AbortSignal,
    ) -> Result<(), EngineError>;
    /// Thread-safe, never blocks on the engine thread: stops a running prefill or decode.
    fn abort_hook(&self) -> AbortHook;
    /// On the engine thread.
    fn close(self);
}
