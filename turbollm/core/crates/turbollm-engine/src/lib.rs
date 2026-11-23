//! The engine domain: which engines exist, what a load and a generation ask for, what a generation
//! streams back, and the errors every engine and the manager report. Plain types only; the traits,
//! the catalogue and the manager build on them.

mod descriptor;
mod error;
mod event;
mod ids;
mod request;

pub use descriptor::{
    Availability, Backend, EngineDescriptor, HttpUpstream, LoadedModelInfo, ModelInfo,
};
pub use error::{EngineError, InvalidReason, MODEL_UNLOADED, REPLY_CANCELLED};
pub use event::{EngineEvent, FinishReason};
pub use ids::{EngineId, EngineKind, ModelFormat, ModelRef};
pub use request::{
    ChatMessage, GenerateRequest, GenerationParams, LoadSpec, LoadTarget, MessageContent, Role,
};
