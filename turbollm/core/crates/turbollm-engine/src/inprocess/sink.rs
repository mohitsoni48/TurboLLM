use std::pin::Pin;
use std::task::{Context, Poll};

use futures_core::Stream;
use tokio::sync::mpsc;

use crate::engine::EventStream;
use crate::error::EngineError;
use crate::event::EngineEvent;

/// Unread events a reply may hold before the engine thread waits for its consumer: a client that
/// reads slowly paces the native decode loop.
pub(crate) const EVENT_BUFFER: usize = 32;

type ReplyItem = Result<EngineEvent, EngineError>;

/// The reply's consumer went away; a backend treats this as an abort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

/// Where a native model's generate writes its events, on the engine thread.
pub struct EventSink {
    consumer: mpsc::Sender<ReplyItem>,
}

impl EventSink {
    /// Blocks while the consumer has `EVENT_BUFFER` events unread.
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

/// A bounded reply channel: the engine thread's sink and the consumer's stream.
pub(crate) fn reply_channel() -> (EventSink, EventStream) {
    let (consumer, events) = mpsc::channel(EVENT_BUFFER);
    (EventSink { consumer }, Box::pin(ReplyStream { events }))
}

struct ReplyStream {
    events: mpsc::Receiver<ReplyItem>,
}

impl Stream for ReplyStream {
    type Item = ReplyItem;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<ReplyItem>> {
        self.get_mut().events.poll_recv(cx)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Arc;
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
        let (mut sink, mut stream) = reply_channel();
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
        let (mut sink, mut stream) = reply_channel();
        let failure = EngineError::EngineFailure("decode failed".to_owned());
        let sent = failure.clone();
        std::thread::spawn(move || sink.fail(sent));
        assert_eq!(next_event(&mut stream).await, Some(Err(failure)));
    }

    #[test]
    fn emitting_to_a_dropped_stream_reports_the_sink_closed() {
        let (mut sink, stream) = reply_channel();
        drop(stream);
        assert_eq!(sink.emit(text("a")), Err(SinkClosed));
    }

    #[tokio::test]
    async fn the_sink_holds_at_most_the_buffer_of_unread_events() {
        let (mut sink, mut stream) = reply_channel();
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
