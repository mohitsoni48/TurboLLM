/// What a generation streams back, in order (`EngineEvent.kt:5-20`): `Prefilled` once, before the
/// first `Text` or `Reasoning`; `Done` last.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Prefilled {
        prompt_tokens: u32,
        prompt_ms: f64,
    },
    Text(String),
    Reasoning(String),
    Done {
        reason: FinishReason,
        prompt_tokens: u32,
        completion_tokens: u32,
        prompt_ms: f64,
        gen_ms: f64,
    },
}

/// Why a reply ended. A cancelled reply has no client left to answer, so it has no reason here
/// (`TurboLLMTypes.kt:86-91` keeps `CANCELLED` on the Kotlin side only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    Length,
}
