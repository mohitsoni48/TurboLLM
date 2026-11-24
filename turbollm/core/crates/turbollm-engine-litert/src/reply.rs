//! One reply in its own conversation, on the engine thread (arch 2.5, T-7). The library streams
//! the reply's chunks from a thread of its own into a channel; this thread drains it until the
//! final chunk, and only then ends the conversation, so the stream state the library points at
//! is never freed under it.

use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use turbollm_engine::{
    AbortSignal, EngineError, EngineEvent, EventSink, FinishReason, GenerateRequest,
};

use crate::Clock;
use crate::api::{Benchmark, BenchmarkTurn, ChunkSink, EngineHandle, LiteRtCalls, RawChunk};
use crate::chunk::parse_chunk;
use crate::model::{CurrentConversation, cancel_current, lock};
use crate::prompt::LiteRtPrompt;

const GENERATING_FAILED: &str = "LiteRT-LM failed while generating: ";
/// How often a reply that should stop is told so again. A cancel flags only the tasks the runtime
/// has queued, and the decode task is queued, with a fresh flag, only once prefill has finished: a
/// cancel landing in between is lost, and the turn would run to its end for nobody, holding the
/// engine. The repo's own server re-cancels every 200 ms until the final chunk
/// (`engines/litert-lm-server/src/main.cc:2303-2311`); cancelling an ended turn is a no-op.
const RECANCEL_EVERY: Duration = Duration::from_millis(200);
const ENDED_WITHOUT_FINAL_CHUNK: &str = "the reply ended without a final chunk";

/// What a reply runs on: the engine's calls and handle, and where its conversation is kept.
pub(crate) struct ReplyContext<'a> {
    pub calls: &'a (dyn LiteRtCalls + Send + Sync),
    pub engine: &'a EngineHandle,
    pub current: &'a CurrentConversation,
    pub clock: &'a Clock,
}

/// Streams one reply into `sink`: Prefilled at the first chunk, reasoning before text per chunk,
/// then Done. A raised `abort`, or a consumer that went away, ends it `Cancelled`.
pub(crate) fn generate(
    context: &ReplyContext<'_>,
    req: &GenerateRequest,
    sink: &mut EventSink,
    abort: &AbortSignal,
) -> Result<(), EngineError> {
    let prompt = LiteRtPrompt::of(&req.messages, &req.params)?;
    let mut reply = Reply {
        context,
        sink,
        abort,
        prompt,
        sent_at: Duration::ZERO,
        prompt_tokens: 0,
    };
    reply.run()
}

/// A chunk and when it reached the callback thread.
struct Arrival {
    chunk: RawChunk,
    at: Duration,
}

/// What the drained stream came to.
#[derive(Default)]
struct Streamed {
    first_chunk_at: Option<Duration>,
    ended_at: Duration,
    error: Option<String>,
    consumer_left: bool,
    /// When the next re-cancel is due, once the reply is known to be leaving.
    recancel_at: Option<Instant>,
}

struct Reply<'a, 'b> {
    context: &'a ReplyContext<'a>,
    sink: &'b mut EventSink,
    abort: &'b AbortSignal,
    prompt: LiteRtPrompt,
    sent_at: Duration,
    /// What the conversation held before the user turn was sent.
    prompt_tokens: u32,
}

impl Reply<'_, '_> {
    fn run(&mut self) -> Result<(), EngineError> {
        self.check_not_aborted()?;
        let arrivals = self.start()?;
        let streamed = self.stream(&arrivals);
        let benchmark = self.release_conversation(
            streamed
                .as_ref()
                .is_ok_and(|streamed| self.ended_well(streamed)),
        );
        self.conclude(&streamed?, &benchmark)
    }

    /// The callback only stamps each chunk and queues it: it runs on a LiteRT thread, which it
    /// must not hold up, and must not call LiteRT from.
    fn start(&mut self) -> Result<Receiver<Arrival>, EngineError> {
        let (queue, arrivals) = mpsc::channel();
        self.sent_at = (self.context.clock)();
        let sink = stamping_sink(queue, Arc::clone(self.context.clock));
        let started = self
            .context
            .calls
            .start_reply(self.context.engine, &self.prompt, sink);
        let started = started.map_err(|message| self.failure(&message))?;
        self.prompt_tokens = started.prompt_tokens;
        lock(self.context.current).replace(started.conversation);
        self.cancel_if_aborted();
        Ok(arrivals)
    }

    /// An abort raised before the conversation was kept found nothing to cancel.
    fn cancel_if_aborted(&self) {
        if self.abort.is_aborted() {
            cancel_current(self.context.calls, self.context.current);
        }
    }

    /// Drains chunks until the final one; after an error, a cancel or a departed consumer it
    /// still reads on, emits nothing, and keeps telling the library to stop.
    fn stream(&mut self, arrivals: &Receiver<Arrival>) -> Result<Streamed, EngineError> {
        let mut streamed = Streamed::default();
        loop {
            match arrivals.recv_timeout(RECANCEL_EVERY) {
                Ok(arrival) => {
                    self.take(arrival.chunk.clone(), arrival.at, &mut streamed);
                    if arrival.chunk.is_final {
                        streamed.ended_at = arrival.at;
                        return Ok(streamed);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.failure(ENDED_WITHOUT_FINAL_CHUNK));
                }
            }
            self.cancel_again_when_due(&mut streamed);
        }
    }

    /// The first cancel came from the abort hook or from `emit`; this repeats it, under the same
    /// lock, so a repeat never reaches a conversation being deleted.
    fn cancel_again_when_due(&self, streamed: &mut Streamed) {
        if self.ended_well(streamed) {
            return;
        }
        let now = Instant::now();
        match streamed.recancel_at {
            Some(due) if now < due => {}
            Some(_) => {
                cancel_current(self.context.calls, self.context.current);
                streamed.recancel_at = Some(now + RECANCEL_EVERY);
            }
            None => streamed.recancel_at = Some(now + RECANCEL_EVERY),
        }
    }

    /// An error chunk is not necessarily the end of the generation (the runtime reports a tool call
    /// it cannot parse and keeps decoding), so the turn is stopped, as `main.cc:2330-2337` does.
    fn stop_on_first_error(&self, streamed: &Streamed) {
        if self.ended_well(streamed) {
            cancel_current(self.context.calls, self.context.current);
        }
    }

    /// The first chunk that delivers something is Prefilled's moment; a bare final chunk ends a reply
    /// that delivered nothing, as in Kotlin, where Done then measures from the end (`LiteRtReply.kt:43`).
    fn take(&mut self, chunk: RawChunk, at: Duration, streamed: &mut Streamed) {
        if let Some(error) = chunk.error {
            self.stop_on_first_error(streamed);
            streamed.error.get_or_insert(error);
        }
        if !self.ended_well(streamed) {
            return;
        }
        let parts = parse_chunk(&chunk.payload);
        let delivers_nothing = chunk.is_final && parts.text.is_empty() && parts.thought.is_empty();
        if streamed.first_chunk_at.is_none() && !delivers_nothing {
            streamed.first_chunk_at = Some(at);
            self.emit(self.prefilled(at), streamed);
        }
        if !parts.thought.is_empty() {
            self.emit(EngineEvent::Reasoning(parts.thought), streamed);
        }
        if !parts.text.is_empty() {
            self.emit(EngineEvent::Text(parts.text), streamed);
        }
    }

    /// LiteRT does not say when its prefill ends; the first chunk arriving is the earliest sign of
    /// it. The prompt count is the one read before the send, as Kotlin's `Prefilled` carried.
    fn prefilled(&self, first_chunk_at: Duration) -> EngineEvent {
        EngineEvent::Prefilled {
            prompt_tokens: self.prompt_tokens,
            prompt_ms: millis(first_chunk_at.saturating_sub(self.sent_at)),
        }
    }

    /// A consumer that went away cancels the reply: the library is told to stop, unless an abort
    /// already told it (an abort closes the reply's channel, which is how it is seen here).
    fn emit(&mut self, event: EngineEvent, streamed: &mut Streamed) {
        if self.sink.emit(event).is_err() {
            streamed.consumer_left = true;
            if !self.abort.is_aborted() {
                cancel_current(self.context.calls, self.context.current);
            }
        }
    }

    fn ended_well(&self, streamed: &Streamed) -> bool {
        streamed.error.is_none() && !streamed.consumer_left && !self.abort.is_aborted()
    }

    /// Takes the conversation back under the lock, so no abort can reach it, then ends it. The
    /// benchmark is read only for a reply that is about to report its usage.
    fn release_conversation(&self, read_benchmark: bool) -> Benchmark {
        let conversation = lock(self.context.current).take();
        let Some(conversation) = conversation else {
            return Benchmark::default();
        };
        let benchmark = if read_benchmark {
            self.context
                .calls
                .benchmark(&conversation)
                .unwrap_or_default()
        } else {
            Benchmark::default()
        };
        self.context.calls.delete_conversation(conversation);
        benchmark
    }

    fn conclude(&mut self, streamed: &Streamed, benchmark: &Benchmark) -> Result<(), EngineError> {
        if streamed.consumer_left || self.abort.is_aborted() {
            return Err(EngineError::reply_cancelled());
        }
        if let Some(error) = &streamed.error {
            return Err(self.failure(error));
        }
        let done = self.done(streamed, benchmark);
        self.sink
            .emit(done)
            .map_err(|_closed| EngineError::reply_cancelled())
    }

    /// Usage is the benchmark's counters and speeds (E-3); what it lacks is the wall clock.
    fn done(&self, streamed: &Streamed, benchmark: &Benchmark) -> EngineEvent {
        let first_chunk_at = streamed.first_chunk_at.unwrap_or(streamed.ended_at);
        let prompt_wall = first_chunk_at.saturating_sub(self.sent_at);
        let gen_wall = streamed.ended_at.saturating_sub(first_chunk_at);
        let prefill = benchmark.prefill.last();
        let decode = benchmark.decode.last();
        let completion_tokens = tokens_of(decode);
        EngineEvent::Done {
            reason: self.finish_reason(completion_tokens),
            prompt_tokens: prefill.map_or(self.prompt_tokens, |turn| tokens_of(Some(turn))),
            completion_tokens,
            prompt_ms: measured_ms(prefill, prompt_wall),
            gen_ms: measured_ms(decode, gen_wall),
        }
    }

    /// LiteRT says nothing about why a reply ended; one that used its whole budget was cut short.
    fn finish_reason(&self, completion_tokens: u32) -> FinishReason {
        match self.prompt.max_output_tokens {
            Some(cap) if completion_tokens >= cap => FinishReason::Length,
            _ => FinishReason::Stop,
        }
    }

    /// An aborted call fails as the cancel it is (`LiteRtReply.kt:76-82`).
    fn failure(&self, message: &str) -> EngineError {
        if self.abort.is_aborted() {
            return EngineError::reply_cancelled();
        }
        EngineError::EngineFailure(format!("{GENERATING_FAILED}{message}"))
    }

    fn check_not_aborted(&self) -> Result<(), EngineError> {
        if self.abort.is_aborted() {
            return Err(EngineError::reply_cancelled());
        }
        Ok(())
    }
}

fn stamping_sink(queue: Sender<Arrival>, clock: Clock) -> ChunkSink {
    Box::new(move |chunk| {
        let _ = queue.send(Arrival { chunk, at: clock() });
    })
}

fn tokens_of(turn: Option<&BenchmarkTurn>) -> u32 {
    turn.map_or(0, |turn| u32::try_from(turn.tokens).unwrap_or(u32::MAX))
}

/// The turn's tokens over its speed, or `wall` when the benchmark gave no speed.
fn measured_ms(turn: Option<&BenchmarkTurn>, wall: Duration) -> f64 {
    turn.filter(|turn| turn.tokens_per_sec > 0.0).map_or_else(
        || millis(wall),
        |turn| turn.tokens as f64 * 1000.0 / turn.tokens_per_sec,
    )
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}
