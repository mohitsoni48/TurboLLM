use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::task::{Context, Poll};

use futures_core::Stream;
use tokio::sync::mpsc;

use crate::engine::{AbortHook, AbortSignal, EventStream};
use crate::error::EngineError;
use crate::event::EngineEvent;

/// Unread events a reply may hold before the engine thread waits for its consumer: a client that
/// reads slowly paces the native decode loop.
pub(crate) const EVENT_BUFFER: usize = 32;

type ReplyItem = Result<EngineEvent, EngineError>;

/// The reply's consumer went away, or the reply was aborted; a backend treats this as an abort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

/// Where a native model's generate writes its events, on the engine thread. A clone writes into the
/// same reply, which ends only once every clone is gone; a backend that lends one out (a foreign
/// engine's sink object) drops its loan before its generate returns.
#[derive(Clone)]
pub struct EventSink {
    consumer: mpsc::Sender<ReplyItem>,
}

impl EventSink {
    /// Blocks while the consumer has `EVENT_BUFFER` events unread, until it reads or the reply is aborted.
    pub fn emit(&mut self, event: EngineEvent) -> Result<(), SinkClosed> {
        self.deliver(Ok(event))
    }

    /// Ends the reply with `error`; a consumer that already left needs no answer.
    pub(crate) fn fail(&mut self, error: EngineError) {
        let _ = self.deliver(Err(error));
    }

    fn deliver(&mut self, item: ReplyItem) -> Result<(), SinkClosed> {
        self.consumer.blocking_send(item).map_err(|_| SinkClosed)
    }
}

/// A bounded reply channel: the engine thread's sink and the consumer's stream. `abort` closes it,
/// so an engine waiting on a consumer that stopped reading wakes (QA E-26); events already sent can
/// still be read, then the stream ends.
pub(crate) fn reply_channel(abort: &AbortSignal) -> (EventSink, EventStream) {
    let (consumer, events) = mpsc::channel(EVENT_BUFFER);
    let events = Arc::new(Mutex::new(events));
    abort.add_hook(closing(&events));
    (EventSink { consumer }, Box::pin(ReplyStream { events }))
}

type SharedReceiver = Mutex<mpsc::Receiver<ReplyItem>>;

/// Closes the reply while its stream lives; a dropped stream closed it already.
fn closing(events: &Arc<SharedReceiver>) -> AbortHook {
    let events = Arc::downgrade(events);
    Arc::new(move || {
        if let Some(events) = Weak::upgrade(&events) {
            receiver(&events).close();
        }
    })
}

fn receiver(events: &SharedReceiver) -> MutexGuard<'_, mpsc::Receiver<ReplyItem>> {
    events.lock().unwrap_or_else(PoisonError::into_inner)
}

struct ReplyStream {
    events: Arc<SharedReceiver>,
}

impl Stream for ReplyStream {
    type Item = ReplyItem;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<ReplyItem>> {
        receiver(&self.events).poll_recv(cx)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    pub(crate) async fn next_event(stream: &mut EventStream) -> Option<ReplyItem> {
        std::future::poll_fn(|cx| stream.as_mut().poll_next(cx)).await
    }

    fn text(piece: &str) -> EngineEvent {
        EngineEvent::Text(piece.to_owned())
    }

    #[tokio::test]
    async fn emitted_events_reach_the_stream_in_order() {
        let (mut sink, mut stream) = reply_channel(&AbortSignal::new());
        std::thread::spawn(move || {
            sink.emit(text("a")).unwrap();
            sink.emit(text("b")).unwrap();
        });
        assert_eq!(next_event(&mut stream).await, Some(Ok(text("a"))));
        assert_eq!(next_event(&mut stream).await, Some(Ok(text("b"))));
        assert_eq!(next_event(&mut stream).await, None);
    }

    #[tokio::test]
    async fn a_failure_reaches_the_stream_as_an_error() {
        let (mut sink, mut stream) = reply_channel(&AbortSignal::new());
        let failure = EngineError::EngineFailure("decode failed".to_owned());
        let sent = failure.clone();
        std::thread::spawn(move || sink.fail(sent));
        assert_eq!(next_event(&mut stream).await, Some(Err(failure)));
    }

    #[test]
    fn emitting_to_a_dropped_stream_reports_the_sink_closed() {
        let (mut sink, stream) = reply_channel(&AbortSignal::new());
        drop(stream);
        assert_eq!(sink.emit(text("a")), Err(SinkClosed));
    }

    #[tokio::test]
    async fn a_cloned_sink_writes_into_the_same_reply_which_ends_when_every_clone_is_gone() {
        let (mut sink, mut stream) = reply_channel(&AbortSignal::new());
        let mut lent = sink.clone();
        std::thread::spawn(move || {
            lent.emit(text("lent")).unwrap();
            drop(lent);
            sink.emit(text("own")).unwrap();
        });
        assert_eq!(next_event(&mut stream).await, Some(Ok(text("lent"))));
        assert_eq!(next_event(&mut stream).await, Some(Ok(text("own"))));
        assert_eq!(next_event(&mut stream).await, None);
    }

    #[test]
    fn an_abort_wakes_an_emit_blocked_on_an_unread_reply() {
        let abort = AbortSignal::new();
        let (mut sink, _unread) = reply_channel(&abort);
        let (ended, emit_ended) = std::sync::mpsc::channel();
        let emitted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&emitted);
        std::thread::spawn(move || {
            let outcome = loop {
                match sink.emit(text("x")) {
                    Ok(()) => counter.fetch_add(1, Ordering::SeqCst),
                    Err(closed) => break closed,
                };
            };
            let _ = ended.send(outcome);
        });
        while emitted.load(Ordering::SeqCst) < EVENT_BUFFER {
            std::thread::sleep(Duration::from_millis(5));
        }

        abort.abort();

        let outcome = emit_ended.recv_timeout(Duration::from_secs(1));
        assert_eq!(outcome, Ok(SinkClosed));
    }

    #[tokio::test]
    async fn the_sink_holds_at_most_the_buffer_of_unread_events() {
        let (mut sink, mut stream) = reply_channel(&AbortSignal::new());
        let emitted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&emitted);
        std::thread::spawn(move || {
            while sink.emit(text("x")).is_ok() {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), EVENT_BUFFER);
        next_event(&mut stream).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), EVENT_BUFFER + 1);
    }
}
