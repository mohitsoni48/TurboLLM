//! The load stall watch (ADR-460): a load whose engine reports progress, and that reports none for
//! the stall window, is aborted. Engines that cannot be interrupted mid-open are exempt, a zero
//! window turns the watch off, and there is no overall cap on how long a progressing load may take.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::engine::{AbortSignal, StallPolicy};
use crate::error::EngineError;

/// Watches one load from `start` until it is dropped. Progress only wakes the watch; the watch
/// itself measures the silence on the runtime's clock, so progress may come from any thread.
pub struct StallWatch {
    progress: Arc<Notify>,
    stalled: Arc<AtomicBool>,
    window: Duration,
    watcher: Option<JoinHandle<()>>,
}

/// What a load calls each time it makes progress.
pub type ProgressListener = Arc<dyn Fn(f32) + Send + Sync>;

impl StallWatch {
    /// Starts the watch on the current tokio runtime; a stall raises `abort` once.
    pub fn start(policy: StallPolicy, window: Duration, abort: AbortSignal) -> StallWatch {
        let mut watch = StallWatch {
            progress: Arc::new(Notify::new()),
            stalled: Arc::new(AtomicBool::new(false)),
            window,
            watcher: None,
        };
        if is_watched(policy, window) {
            watch.watcher = Some(tokio::spawn(watch.abort_after_silence(abort)));
        }
        watch
    }

    pub fn progress_listener(&self) -> ProgressListener {
        let progress = Arc::clone(&self.progress);
        Arc::new(move |_fraction| progress.notify_one())
    }

    /// The failure the load ends with once the watch has aborted it; `None` while it has not.
    pub fn stall_failure(&self) -> Option<EngineError> {
        self.stalled
            .load(Ordering::SeqCst)
            .then(|| EngineError::ModelLoadFailed(stall_text(self.window)))
    }

    fn abort_after_silence(&self, abort: AbortSignal) -> impl Future<Output = ()> + use<> {
        let progress = Arc::clone(&self.progress);
        let stalled = Arc::clone(&self.stalled);
        let window = self.window;
        async move {
            while tokio::time::timeout(window, progress.notified())
                .await
                .is_ok()
            {}
            stalled.store(true, Ordering::SeqCst);
            abort.abort();
        }
    }
}

impl Drop for StallWatch {
    fn drop(&mut self) {
        if let Some(watcher) = &self.watcher {
            watcher.abort();
        }
    }
}

fn is_watched(policy: StallPolicy, window: Duration) -> bool {
    policy == StallPolicy::Watch && !window.is_zero()
}

fn stall_text(window: Duration) -> String {
    format!(
        "llama.cpp could not load the model: no load progress for {} s",
        window.as_secs()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeClock;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const WINDOW: Duration = Duration::from_secs(120);
    const TEN_MINUTES: Duration = Duration::from_secs(600);
    /// tokio rounds a timer's deadline up to its next millisecond tick.
    const TIMER_TICK: Duration = Duration::from_millis(1);

    struct WatchedLoad {
        watch: StallWatch,
        aborts: Arc<AtomicUsize>,
        clock: FakeClock,
    }

    impl WatchedLoad {
        async fn start(policy: StallPolicy, window: Duration) -> WatchedLoad {
            let clock = FakeClock::paused();
            let abort = AbortSignal::new();
            let aborts = Arc::new(AtomicUsize::new(0));
            let counter = Arc::clone(&aborts);
            abort.add_hook(Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }));
            let watch = StallWatch::start(policy, window, abort);
            clock.settle().await;
            WatchedLoad {
                watch,
                aborts,
                clock,
            }
        }

        async fn report_progress(&self) {
            (self.watch.progress_listener())(0.5);
            self.clock.settle().await;
        }

        async fn wait(&self, silence: Duration) {
            self.clock.advance(silence).await;
        }

        fn aborts(&self) -> usize {
            self.aborts.load(Ordering::SeqCst)
        }
    }

    #[tokio::test]
    async fn progress_every_fifty_seconds_keeps_a_120_second_window_alive() {
        let load = WatchedLoad::start(StallPolicy::Watch, WINDOW).await;
        for _ in 0..12 {
            load.report_progress().await;
            load.wait(Duration::from_secs(50)).await;
        }
        assert_eq!(load.aborts(), 0);
        assert_eq!(load.watch.stall_failure(), None);
    }

    #[tokio::test]
    async fn the_abort_fires_at_the_end_of_the_window_and_not_before() {
        let load = WatchedLoad::start(StallPolicy::Watch, WINDOW).await;
        load.report_progress().await;

        load.wait(Duration::from_secs(119)).await;
        assert_eq!(load.aborts(), 0);

        load.wait(Duration::from_secs(1) + TIMER_TICK).await;
        assert_eq!(load.aborts(), 1);
    }

    #[tokio::test]
    async fn silence_past_the_window_fires_the_abort_once() {
        let load = WatchedLoad::start(StallPolicy::Watch, WINDOW).await;
        load.report_progress().await;

        load.wait(Duration::from_secs(121)).await;
        load.wait(TEN_MINUTES).await;

        assert_eq!(load.aborts(), 1);
    }

    #[tokio::test]
    async fn a_load_that_never_reports_progress_stalls_after_the_window() {
        let load = WatchedLoad::start(StallPolicy::Watch, WINDOW).await;
        load.wait(Duration::from_secs(121)).await;
        assert_eq!(load.aborts(), 1);
    }

    #[tokio::test]
    async fn a_stalled_load_fails_with_the_stall_text() {
        let load = WatchedLoad::start(StallPolicy::Watch, WINDOW).await;
        load.wait(Duration::from_secs(121)).await;
        assert_eq!(
            load.watch.stall_failure(),
            Some(EngineError::ModelLoadFailed(
                "llama.cpp could not load the model: no load progress for 120 s".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn the_stall_text_names_the_window_in_seconds() {
        let load = WatchedLoad::start(StallPolicy::Watch, Duration::from_secs(5)).await;
        load.wait(Duration::from_secs(6)).await;
        assert_eq!(
            load.watch.stall_failure(),
            Some(EngineError::ModelLoadFailed(
                "llama.cpp could not load the model: no load progress for 5 s".to_string()
            ))
        );
    }

    #[tokio::test]
    async fn an_exempt_engine_is_never_aborted() {
        let load = WatchedLoad::start(StallPolicy::Exempt, WINDOW).await;
        load.wait(TEN_MINUTES).await;
        assert_eq!(load.aborts(), 0);
        assert_eq!(load.watch.stall_failure(), None);
    }

    #[tokio::test]
    async fn a_zero_window_turns_the_watch_off() {
        let load = WatchedLoad::start(StallPolicy::Watch, Duration::ZERO).await;
        load.wait(TEN_MINUTES).await;
        assert_eq!(load.aborts(), 0);
        assert_eq!(load.watch.stall_failure(), None);
    }

    #[tokio::test]
    async fn progress_reported_without_a_watch_is_ignored() {
        let load = WatchedLoad::start(StallPolicy::Exempt, WINDOW).await;
        load.report_progress().await;
        assert_eq!(load.aborts(), 0);
    }

    #[tokio::test]
    async fn a_dropped_watch_never_fires() {
        let load = WatchedLoad::start(StallPolicy::Watch, WINDOW).await;
        let WatchedLoad {
            watch,
            aborts,
            clock,
        } = load;

        drop(watch);
        clock.advance(TEN_MINUTES).await;

        assert_eq!(aborts.load(Ordering::SeqCst), 0);
    }
}
