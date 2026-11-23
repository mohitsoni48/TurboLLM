//! One reply from an open session (port of `LlamaReply.kt:32-121`): prefill, sample token by
//! token, then report the native stats. Runs entirely on the engine thread.

use turbollm_engine::{
    AbortSignal, EngineError, EngineEvent, EventSink, FinishReason, GenerateRequest,
    GenerationParams,
};

use crate::api::{
    Delta, LlamaCalls, Sampling, Session, Stats, TL_CONTEXT_LENGTH_EXCEEDED, TL_OK,
    TL_TEMPLATE_UNSUPPORTED,
};
use crate::utf8::Utf8Completion;
use crate::wire;

/// `LlamaReply.kt:17-20`.
const DEFAULT_TEMPERATURE: f32 = 0.8;
const DEFAULT_TOP_P: f32 = 0.95;
const DEFAULT_TOP_K: i32 = 40;
const RANDOM_SEED: i64 = -1;

/// `tl_llama_next_token`'s status for a sampled token.
const TOKEN_SAMPLED: i32 = 1;
const END_OF_REPLY: i32 = 0;

const PROMPT_FAILED: &str = "llama.cpp could not process the prompt: ";
const SAMPLING_FAILED: &str = "llama.cpp could not start sampling: ";
const GENERATING_FAILED: &str = "llama.cpp failed while generating: ";
const READING_FAILED: &str = "llama.cpp could not read the reply: ";

/// Streams one reply into `sink`: Prefilled, reasoning and text deltas, then Done. A raised
/// `abort`, or a consumer that went away, ends it `Cancelled`.
pub(crate) fn generate(
    calls: &dyn LlamaCalls,
    session: &mut Session,
    req: &GenerateRequest,
    sink: &mut EventSink,
    abort: &AbortSignal,
) -> Result<(), EngineError> {
    let mut reply = Reply {
        calls,
        session,
        sink,
        abort,
        characters: Utf8Completion::default(),
        sampled: 0,
    };
    reply.run(req)
}

struct Reply<'a> {
    calls: &'a dyn LlamaCalls,
    session: &'a mut Session,
    sink: &'a mut EventSink,
    abort: &'a AbortSignal,
    characters: Utf8Completion,
    sampled: u32,
}

impl Reply<'_> {
    fn run(&mut self, req: &GenerateRequest) -> Result<(), EngineError> {
        self.prefill(req)?;
        self.emit(prefilled(&self.stats()))?;
        self.start_sampling(&req.params)?;
        let reason = self.stream_tokens(req.params.max_tokens)?;
        let last = self.parse(false)?;
        self.emit_delta(last)?;
        self.emit(done(reason, &self.stats()))
    }

    fn prefill(&mut self, req: &GenerateRequest) -> Result<(), EngineError> {
        self.check_not_aborted()?;
        let outcome = self
            .calls
            .prepare(self.session, &wire::prepare_request(req));
        if outcome < 0 {
            return Err(self.prefill_failure(outcome));
        }
        Ok(())
    }

    fn prefill_failure(&self, sentinel: i32) -> EngineError {
        match sentinel {
            TL_CONTEXT_LENGTH_EXCEEDED => EngineError::ContextLengthExceeded(self.last_error()),
            TL_TEMPLATE_UNSUPPORTED => EngineError::TemplateUnsupported(String::new()),
            _ => self.unless_aborted(PROMPT_FAILED),
        }
    }

    fn start_sampling(&mut self, params: &GenerationParams) -> Result<(), EngineError> {
        let status = self
            .calls
            .start_sampling(self.session, &sampling_for(params));
        if status != TL_OK {
            return Err(self.failure(SAMPLING_FAILED));
        }
        Ok(())
    }

    fn stream_tokens(&mut self, max_tokens: Option<u32>) -> Result<FinishReason, EngineError> {
        loop {
            self.check_not_aborted()?;
            if max_tokens.is_some_and(|max| self.sampled >= max) {
                return Ok(FinishReason::Length);
            }
            let token = self.calls.next_token(self.session);
            match token.status {
                TOKEN_SAMPLED => self.take_token(&token.piece)?,
                END_OF_REPLY => return Ok(self.end_of_reply()),
                _ => return Err(self.unless_aborted(GENERATING_FAILED)),
            }
        }
    }

    /// The native parser frames UTF-8 itself; a token carrying half a character is not worth a parse.
    fn take_token(&mut self, piece: &[u8]) -> Result<(), EngineError> {
        self.sampled += 1;
        if self.characters.push(piece) {
            let delta = self.parse(true)?;
            self.emit_delta(delta)?;
        }
        Ok(())
    }

    fn end_of_reply(&self) -> FinishReason {
        if self.stats().context_full {
            FinishReason::Length
        } else {
            FinishReason::Stop
        }
    }

    fn parse(&mut self, is_partial: bool) -> Result<Delta, EngineError> {
        let delta = self.calls.parse_delta(self.session, is_partial);
        if delta.status != TL_OK {
            return Err(self.failure(READING_FAILED));
        }
        Ok(delta)
    }

    /// Reasoning before content within one delta (`LlamaReply.kt:101-104`).
    fn emit_delta(&mut self, delta: Delta) -> Result<(), EngineError> {
        if !delta.reasoning.is_empty() {
            self.emit(EngineEvent::Reasoning(delta.reasoning))?;
        }
        if !delta.content.is_empty() {
            self.emit(EngineEvent::Text(delta.content))?;
        }
        Ok(())
    }

    /// A consumer that went away is an abort (arch 2.3.3).
    fn emit(&mut self, event: EngineEvent) -> Result<(), EngineError> {
        self.sink
            .emit(event)
            .map_err(|_closed| EngineError::reply_cancelled())
    }

    fn check_not_aborted(&self) -> Result<(), EngineError> {
        if self.abort.is_aborted() {
            return Err(EngineError::reply_cancelled());
        }
        Ok(())
    }

    /// An aborted call fails as the cancel it is (`LlamaReply.kt:97-99`).
    fn unless_aborted(&self, attempt: &str) -> EngineError {
        if self.abort.is_aborted() {
            return EngineError::reply_cancelled();
        }
        self.failure(attempt)
    }

    fn failure(&self, attempt: &str) -> EngineError {
        EngineError::EngineFailure(format!("{attempt}{}", self.last_error()))
    }

    fn last_error(&self) -> String {
        self.calls.last_error(self.session)
    }

    fn stats(&self) -> Stats {
        self.calls.stats(self.session)
    }
}

fn sampling_for(params: &GenerationParams) -> Sampling {
    Sampling {
        temperature: params.temperature.unwrap_or(DEFAULT_TEMPERATURE),
        top_p: params.top_p.unwrap_or(DEFAULT_TOP_P),
        top_k: params.top_k.unwrap_or(DEFAULT_TOP_K),
        seed: params.seed.unwrap_or(RANDOM_SEED),
    }
}

fn prefilled(stats: &Stats) -> EngineEvent {
    EngineEvent::Prefilled {
        prompt_tokens: count(stats.prompt_n),
        prompt_ms: stats.prompt_ms,
    }
}

fn done(reason: FinishReason, stats: &Stats) -> EngineEvent {
    EngineEvent::Done {
        reason,
        prompt_tokens: count(stats.prompt_n),
        completion_tokens: count(stats.predicted_n),
        prompt_ms: stats.prompt_ms,
        gen_ms: stats.predicted_ms,
    }
}

fn count(native: i32) -> u32 {
    u32::try_from(native).unwrap_or(0)
}
