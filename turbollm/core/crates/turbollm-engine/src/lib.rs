//! The engine domain: which engines exist, what a load and a generation ask for, what a generation
//! streams back, and the errors every engine and the manager report. `Engine` is the one trait the
//! manager drives; `InProcess` runs a native library with each loaded model on its own thread.

mod catalog;
mod descriptor;
mod engine;
mod error;
mod event;
mod ids;
mod inprocess;
mod manager;
mod request;
#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use catalog::{Catalog, CatalogEntry, PlatformKind, PlatformKinds};
pub use descriptor::{
    Availability, Backend, EngineDescriptor, HttpUpstream, LoadedModelInfo, ModelInfo,
};
pub use engine::{
    AbortHook, AbortSignal, BoxFuture, Engine, EventStream, LoadControl, LoadedModel, StallPolicy,
};
pub use error::{EngineError, InvalidReason, MODEL_UNLOADED, REPLY_CANCELLED};
pub use event::{EngineEvent, FinishReason};
pub use ids::{EngineId, EngineKind, ModelFormat, ModelRef};
pub use inprocess::{EventSink, InProcess, NativeBackend, NativeModel, SinkClosed};
pub use manager::GatePermit;
pub use request::{
    ChatMessage, GenerateRequest, GenerationParams, LoadSpec, LoadTarget, MessageContent, Role,
};
