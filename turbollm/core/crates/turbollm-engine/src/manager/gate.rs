use tokio::sync::OwnedSemaphorePermit;

/// One slot of a loaded model's generation gate (ADR-457). It travels with the generate command
/// and the engine thread drops it once the native call returned (T-3), so the gate reads busy
/// exactly while native code runs.
pub struct GatePermit {
    _slot: OwnedSemaphorePermit,
}

impl GatePermit {
    pub fn new(slot: OwnedSemaphorePermit) -> GatePermit {
        GatePermit { _slot: slot }
    }
}
