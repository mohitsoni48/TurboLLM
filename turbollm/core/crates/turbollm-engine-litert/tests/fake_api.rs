//! The LiteRT backend's own logic over a scripted LiteRT-LM: one test per `@Test` of the Kotlin
//! SDK's `LiteRtLmEngineFakeRuntimeTest.kt`, then what the C library's shape adds: the order of the
//! calls, the stream state's single reclaim, a cancel racing the final chunk, the benchmark
//! counters (E-3) and the request's own say over thinking.

mod support;

use std::sync::Arc;

use turbollm_engine::{
    Backend, Engine, EngineError, EngineEvent, EngineId, EngineKind, FinishReason,
    GenerationParams, InProcess, InvalidReason, ModelInfo, NativeBackend, NativeModel,
    REPLY_CANCELLED, Role, StallPolicy,
};
use turbollm_engine_litert::api::EngineSettings;
use turbollm_engine_litert::prompt::LiteRtPrompt;
use turbollm_engine_litert::{ENGINE_THREAD_NAME, LiteRtModel};

use support::fake_litert::{CALLBACK_THREAD_NAME, FakeLiteRt, counters, text, thought};
use support::*;

const LOAD_FAILED: &str = "LiteRT-LM could not load the model: ";
const CONTEXT_FAILED: &str = "not a LiteRT-LM bundle";

fn open(
    fake: &Arc<FakeLiteRt>,
    spec: &turbollm_engine::LoadSpec,
) -> Result<(LiteRtModel, ModelInfo), EngineError> {
    backend(fake).open(spec, &control())
}

fn open_info(fake: &Arc<FakeLiteRt>, spec: &turbollm_engine::LoadSpec) -> ModelInfo {
    open(fake, spec).unwrap_or_else(|error| panic!("{error}")).1
}

fn opened_backends(fake: &Arc<FakeLiteRt>) -> Vec<String> {
    fake.settings()
        .into_iter()
        .map(|settings| settings.backend)
        .collect()
}

fn failure(reason: &str) -> EngineError {
    EngineError::EngineFailure(reason.to_owned())
}

fn cannot_run_here() -> EngineError {
    EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LITERT_LM),
        kind: EngineKind::LitertLm,
        reason: "LiteRT-LM cannot run on this device: no GPU runtime".to_owned(),
    }
}

fn done_of(events: &[EngineEvent]) -> &EngineEvent {
    events.last().expect("a reply ends with Done")
}

fn strings(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

const ENDED_REPLY: [&str; 4] = [
    "start_reply",
    "benchmark",
    "delete_conversation",
    "stream_dropped",
];

#[test]
fn a_cpu_load_opens_the_model_with_its_threads_context_and_cache_folder() {
    let fake = FakeLiteRt::new();

    let info = open_info(&fake, &spec(Some(2048), 3, Backend::Cpu));

    let expected = EngineSettings {
        model_path: absolute(MODEL),
        backend: "cpu".to_owned(),
        max_num_tokens: 2048,
        num_threads: Some(3),
        cache_dir: Some(absolute(CACHE)),
        enable_benchmark: true,
    };
    assert_eq!(fake.settings(), [expected]);
    let info_expected = ModelInfo {
        context_size: 2048,
        trained_context: None,
        backend: Backend::Cpu,
        notes: Vec::new(),
    };
    assert_eq!(info, info_expected);
    assert_eq!(backend(&fake).descriptor().kind, EngineKind::LitertLm);
}

#[test]
fn without_a_context_size_four_thousand_ninety_six_tokens_are_used() {
    let fake = FakeLiteRt::new();

    let info = open_info(&fake, &spec(None, 4, Backend::Cpu));

    assert_eq!(fake.settings()[0].max_num_tokens, 4096);
    assert_eq!(info.context_size, 4096);
}

#[test]
fn auto_runs_on_the_gpu_when_it_initialises() {
    let fake = FakeLiteRt::new();

    let info = open_info(&fake, &spec(Some(1024), 4, Backend::Auto));

    assert_eq!(opened_backends(&fake), ["gpu"]);
    assert_eq!(fake.settings()[0].num_threads, None);
    assert_eq!(info.backend, Backend::Gpu);
    assert_eq!(info.notes, Vec::<String>::new());
}

#[test]
fn auto_retries_on_the_cpu_with_a_note_when_the_gpu_fails() {
    let fake = FakeLiteRt::new();
    fake.script().gpu_failure = Some(failure("no OpenCL"));

    let info = open_info(&fake, &spec(Some(1024), 4, Backend::Auto));

    assert_eq!(opened_backends(&fake), ["gpu", "cpu"]);
    assert_eq!(fake.settings()[1].num_threads, Some(4));
    assert_eq!(info.backend, Backend::Cpu);
    assert_eq!(info.notes, ["GPU unavailable: no OpenCL"]);
}

#[test]
fn an_explicit_gpu_request_that_fails_retries_on_the_cpu_with_a_note() {
    let fake = FakeLiteRt::new();
    fake.script().gpu_failure = Some(failure("Engine is not initialized."));

    let info = open_info(&fake, &spec(Some(1024), 4, Backend::Gpu));

    assert_eq!(opened_backends(&fake), ["gpu", "cpu"]);
    assert_eq!(info.backend, Backend::Cpu);
    assert_eq!(info.notes, ["GPU unavailable: Engine is not initialized."]);
}

#[test]
fn a_gpu_request_the_cpu_cannot_load_either_is_a_model_load_failure_with_the_cpu_reason() {
    let fake = FakeLiteRt::new();
    fake.script().gpu_failure = Some(failure("no OpenCL"));
    fake.script().cpu_failure = Some(failure(CONTEXT_FAILED));

    let error = open(&fake, &spec(Some(1024), 4, Backend::Gpu)).err();

    assert_eq!(
        error,
        Some(EngineError::ModelLoadFailed(format!(
            "{LOAD_FAILED}{CONTEXT_FAILED}"
        )))
    );
}

#[test]
fn an_explicit_gpu_request_on_an_engine_that_cannot_run_here_is_unavailable_and_not_retried() {
    let fake = FakeLiteRt::new();
    fake.script().gpu_failure = Some(cannot_run_here());

    let error = open(&fake, &spec(Some(1024), 4, Backend::Gpu)).err();

    assert_eq!(error, Some(cannot_run_here()));
    assert_eq!(opened_backends(&fake), ["gpu"]);
}

#[test]
fn a_cpu_failure_is_a_model_load_failure_with_the_reason() {
    let fake = FakeLiteRt::new();
    fake.script().cpu_failure = Some(failure(CONTEXT_FAILED));

    let error = open(&fake, &spec(Some(1024), 4, Backend::Cpu)).err();

    assert_eq!(
        error,
        Some(EngineError::ModelLoadFailed(format!(
            "{LOAD_FAILED}{CONTEXT_FAILED}"
        )))
    );
}

#[test]
fn an_engine_that_cannot_run_on_this_device_is_unavailable_and_not_retried_on_the_cpu() {
    let fake = FakeLiteRt::new();
    fake.script().gpu_failure = Some(cannot_run_here());

    let error = open(&fake, &spec(Some(1024), 4, Backend::Auto)).err();

    assert_eq!(error, Some(cannot_run_here()));
    assert_eq!(opened_backends(&fake), ["gpu"]);
}

#[test]
fn the_backend_logs_the_library_file_it_opened_once() {
    let fake = FakeLiteRt::new();
    let log = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&log);
    let backend = backend(&fake).with_log(Arc::new(move |line| {
        sink.lock().unwrap().push(line.to_owned());
    }));

    for _ in 0..2 {
        backend
            .open(&spec(Some(1024), 4, Backend::Cpu), &control())
            .unwrap();
    }

    assert_eq!(
        *log.lock().unwrap(),
        [format!("LiteRT-LM loaded {FAKE_LIBRARY_FILE}")]
    );
}

#[test]
fn the_stall_watch_does_not_apply_to_a_load_that_reports_no_progress() {
    let fake = FakeLiteRt::new();

    assert_eq!(backend(&fake).stall_policy(), StallPolicy::Exempt);
}

#[tokio::test]
async fn a_reply_streams_each_chunk_as_text_then_done_with_the_benchmarks_counts() {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert_eq!(
        pieces(&events),
        [
            EngineEvent::Text("Hel".to_owned()),
            EngineEvent::Text("lo".to_owned())
        ]
    );
    let done = EngineEvent::Done {
        reason: FinishReason::Stop,
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_ms: 10.0,
        gen_ms: 50.0,
    };
    assert_eq!(done_of(&events), &done);
}

#[tokio::test]
async fn without_a_benchmark_the_timings_are_wall_clock_from_the_send_to_the_first_chunk_and_the_end()
 {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.benchmark = Err("no benchmark".to_owned());
        script.prefill_ms = 30;
        script.generation_ms = 70;
    }
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    let done = EngineEvent::Done {
        reason: FinishReason::Stop,
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_ms: 30.0,
        gen_ms: 70.0,
    };
    assert_eq!(done_of(&events), &done);
}

#[tokio::test]
async fn the_benchmarks_counters_and_speeds_win_over_the_wall_clock() {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.benchmark = Ok(counters(12, 400.0, 7, 100.0));
        script.prefill_ms = 5;
        script.generation_ms = 5;
    }
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    let done = EngineEvent::Done {
        reason: FinishReason::Stop,
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_ms: 30.0,
        gen_ms: 70.0,
    };
    assert_eq!(done_of(&events), &done);
}

#[tokio::test]
async fn a_benchmark_without_speeds_falls_back_to_the_wall_clock_for_the_timings_only() {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.benchmark = Ok(counters(12, 0.0, 7, 0.0));
        script.prefill_ms = 30;
        script.generation_ms = 70;
    }
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    let done = EngineEvent::Done {
        reason: FinishReason::Stop,
        prompt_tokens: 12,
        completion_tokens: 7,
        prompt_ms: 30.0,
        gen_ms: 70.0,
    };
    assert_eq!(done_of(&events), &done);
}

#[tokio::test]
async fn prefilled_carries_the_token_count_the_conversation_reported_before_the_send() {
    let fake = FakeLiteRt::new();
    fake.script().prompt_tokens = 37;
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert!(
        matches!(
            events[0],
            EngineEvent::Prefilled {
                prompt_tokens: 37,
                ..
            }
        ),
        "{:?}",
        events[0]
    );
}

#[tokio::test]
async fn without_a_benchmark_done_reports_the_counted_prompt_tokens() {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.prompt_tokens = 37;
        script.benchmark = Err("no benchmark".to_owned());
    }
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert!(
        matches!(
            done_of(&events),
            EngineEvent::Done {
                prompt_tokens: 37,
                ..
            }
        ),
        "{:?}",
        done_of(&events)
    );
}

#[tokio::test]
async fn the_benchmarks_prefill_count_still_wins_for_done_over_the_counted_one() {
    let fake = FakeLiteRt::new();
    fake.script().prompt_tokens = 37;
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert!(matches!(
        done_of(&events),
        EngineEvent::Done {
            prompt_tokens: 10,
            ..
        }
    ));
}

#[tokio::test]
async fn a_reply_whose_only_chunk_is_an_empty_final_one_emits_no_prefilled() {
    let fake = FakeLiteRt::new();
    fake.script().chunks = Vec::new();
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert!(
        matches!(events.as_slice(), [EngineEvent::Done { .. }]),
        "{events:?}"
    );
}

#[tokio::test]
async fn a_final_chunk_with_text_still_emits_prefilled_first() {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.chunks = Vec::new();
        script.final_piece = text("Hi");
    }
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert!(
        matches!(
            events.as_slice(),
            [
                EngineEvent::Prefilled { .. },
                EngineEvent::Text(_),
                EngineEvent::Done { .. }
            ]
        ),
        "{events:?}"
    );
}

#[tokio::test]
async fn the_time_to_the_first_chunk_is_reported_before_the_first_piece() {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.chunks = vec![thought("Hm."), text("Hi")];
        script.prefill_ms = 30;
    }
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    let expected = [
        EngineEvent::Prefilled {
            prompt_tokens: 0,
            prompt_ms: 30.0,
        },
        EngineEvent::Reasoning("Hm.".to_owned()),
        EngineEvent::Text("Hi".to_owned()),
    ];
    assert_eq!(events[..3], expected);
}

#[tokio::test]
async fn an_empty_chunk_is_not_emitted() {
    let fake = FakeLiteRt::new();
    fake.script().chunks = vec![text(""), text("Hi"), thought("")];
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    assert_eq!(pieces(&events), [EngineEvent::Text("Hi".to_owned())]);
}

#[tokio::test]
async fn the_models_thought_streams_as_reasoning_and_its_answer_as_text() {
    let fake = FakeLiteRt::new();
    fake.script().chunks = vec![thought("Okay,"), thought(" the user"), text("Yes.")];
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    let expected = [
        EngineEvent::Reasoning("Okay,".to_owned()),
        EngineEvent::Reasoning(" the user".to_owned()),
        EngineEvent::Text("Yes.".to_owned()),
    ];
    assert_eq!(pieces(&events), expected);
}

#[tokio::test]
async fn a_chunk_carrying_both_a_thought_and_answer_text_emits_the_reasoning_first() {
    let fake = FakeLiteRt::new();
    let mut both = text("Yes.");
    both.thought = "Done thinking.".to_owned();
    fake.script().chunks = vec![both];
    let manager = loaded(&fake).await;

    let events = reply(&manager, question()).await.unwrap();

    let expected = [
        EngineEvent::Reasoning("Done thinking.".to_owned()),
        EngineEvent::Text("Yes.".to_owned()),
    ];
    assert_eq!(pieces(&events), expected);
}

async fn finish_with_cap(max_tokens: u32) -> FinishReason {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    let request = asking(GenerationParams {
        max_tokens: Some(max_tokens),
        ..GenerationParams::default()
    });
    match reply(&manager, request).await.unwrap().last() {
        Some(EngineEvent::Done { reason, .. }) => *reason,
        other => panic!("expected Done, got {other:?}"),
    }
}

#[tokio::test]
async fn a_reply_that_uses_all_its_max_tokens_ends_with_length() {
    assert_eq!(finish_with_cap(5).await, FinishReason::Length);
}

#[tokio::test]
async fn a_reply_shorter_than_its_max_tokens_ends_with_stop() {
    assert_eq!(finish_with_cap(6).await, FinishReason::Stop);
}

#[tokio::test]
async fn each_request_gets_its_own_conversation_built_from_the_mapped_prompt_and_deleted_afterwards()
 {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    let conversation = vec![
        message(Role::System, "Be brief."),
        message(Role::User, "Say hi."),
    ];
    let capped = GenerationParams {
        max_tokens: Some(9),
        ..GenerationParams::default()
    };

    let mut first = question();
    first.messages = conversation.clone();
    first.params = capped.clone();
    reply(&manager, first).await.unwrap();
    reply(&manager, question()).await.unwrap();

    let prompts = fake.prompts();
    assert_eq!(prompts.len(), 2);
    assert_eq!(
        prompts[0],
        LiteRtPrompt::of(&conversation, &capped).unwrap()
    );
    let mut expected = strings(&["create_engine:cpu"]);
    expected.extend(strings(&ENDED_REPLY));
    expected.extend(strings(&ENDED_REPLY));
    assert_eq!(fake.names(), expected);
}

#[tokio::test]
async fn a_final_turn_not_from_the_user_is_refused_before_any_conversation_opens() {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    let mut request = question();
    request.messages.push(message(Role::Assistant, "Hi."));

    let error = reply(&manager, request).await.err();

    assert!(matches!(
        error,
        Some(EngineError::InvalidRequest {
            reason: InvalidReason::InvalidLastMessage,
            ..
        })
    ));
    assert_eq!(fake.count("start_reply"), 0);
}

async fn endless_reply_after_first_text(
    fake: &Arc<FakeLiteRt>,
) -> (turbollm_engine::EngineManager, turbollm_engine::Generation) {
    fake.script().endless = true;
    let manager = loaded(fake).await;
    let mut generation = manager.generate(question()).await.unwrap();
    while !matches!(generation.next().await, Ok(Some(EngineEvent::Text(_)))) {}
    (manager, generation)
}

#[tokio::test]
async fn a_cancelled_reply_cancels_the_process_then_deletes_the_conversation() {
    let fake = FakeLiteRt::new();
    let (_manager, mut generation) = endless_reply_after_first_text(&fake).await;

    generation.cancel();
    let ended = every_event(&mut generation).await;

    assert_eq!(
        ended,
        Err(EngineError::Cancelled(REPLY_CANCELLED.to_owned()))
    );
    eventually("the conversation to be deleted", || {
        fake.count("stream_dropped") == 1
    })
    .await;
    let expected = [
        "create_engine:cpu",
        "start_reply",
        "cancel_reply",
        "delete_conversation",
        "stream_dropped",
    ];
    assert_eq!(fake.names(), expected);
}

#[tokio::test]
async fn a_collector_that_goes_away_mid_stream_cancels_the_process_then_deletes_the_conversation() {
    let fake = FakeLiteRt::new();
    let (_manager, generation) = endless_reply_after_first_text(&fake).await;

    drop(generation);

    eventually("the conversation to be deleted", || {
        fake.count("stream_dropped") == 1
    })
    .await;
    let expected = [
        "create_engine:cpu",
        "start_reply",
        "cancel_reply",
        "delete_conversation",
        "stream_dropped",
    ];
    assert_eq!(fake.names(), expected);
}

#[tokio::test]
async fn a_cancel_lost_between_prefill_and_decode_is_sent_again() {
    let fake = FakeLiteRt::new();
    fake.script().lost_cancels = 1;
    let (_manager, mut generation) = endless_reply_after_first_text(&fake).await;

    generation.cancel();
    let ended = every_event(&mut generation).await;

    assert_eq!(
        ended,
        Err(EngineError::Cancelled(REPLY_CANCELLED.to_owned()))
    );
    eventually("the conversation to be deleted", || {
        fake.count("stream_dropped") == 1
    })
    .await;
    assert!(fake.count("cancel_reply") >= 2, "{:?}", fake.names());
}

#[tokio::test]
async fn a_departed_consumer_is_cancelled_again_until_the_final_chunk() {
    let fake = FakeLiteRt::new();
    fake.script().lost_cancels = 1;
    let (_manager, generation) = endless_reply_after_first_text(&fake).await;

    drop(generation);

    eventually("the conversation to be deleted", || {
        fake.count("stream_dropped") == 1
    })
    .await;
    assert!(fake.count("cancel_reply") >= 2, "{:?}", fake.names());
}

#[tokio::test]
async fn an_error_chunk_cancels_the_turn_before_the_conversation_is_deleted() {
    let fake = FakeLiteRt::new();
    fake.script().reply_error = Some("decode failed".to_owned());
    let manager = loaded(&fake).await;

    let _ = reply(&manager, question()).await;

    let names = fake.names();
    let position = |name: &str| names.iter().position(|seen| seen == name);
    assert!(
        position("cancel_reply")
            .is_some_and(|cancel| Some(cancel) < position("delete_conversation")),
        "{names:?}"
    );
}

#[tokio::test]
async fn an_error_the_library_raises_after_the_cancel_is_still_a_cancellation() {
    let fake = FakeLiteRt::new();
    fake.script().error_on_cancel = Some("Process cancelled".to_owned());
    let (_manager, mut generation) = endless_reply_after_first_text(&fake).await;

    generation.cancel();
    let ended = every_event(&mut generation).await;

    assert_eq!(
        ended,
        Err(EngineError::Cancelled(REPLY_CANCELLED.to_owned()))
    );
}

#[tokio::test]
async fn a_failure_of_the_cancel_itself_still_ends_the_reply_cancelled_and_the_conversation_deleted()
 {
    let fake = FakeLiteRt::new();
    {
        let mut script = fake.script();
        script.error_on_cancel = Some("Process cancelled".to_owned());
        script.cancel_failure = Some("The session is not alive".to_owned());
    }
    let (_manager, mut generation) = endless_reply_after_first_text(&fake).await;

    generation.cancel();
    let ended = every_event(&mut generation).await;

    assert_eq!(
        ended,
        Err(EngineError::Cancelled(REPLY_CANCELLED.to_owned()))
    );
    eventually("the conversation to be deleted", || {
        fake.count("stream_dropped") == 1
    })
    .await;
    assert_eq!(fake.count("delete_conversation"), 1);
}

#[tokio::test]
async fn a_failed_reply_is_an_engine_failure_and_its_conversation_is_still_deleted() {
    let fake = FakeLiteRt::new();
    fake.script().reply_error = Some("decode failed".to_owned());
    let manager = loaded(&fake).await;

    let ended = reply(&manager, question()).await;

    assert_eq!(
        ended,
        Err(EngineError::EngineFailure(
            "LiteRT-LM failed while generating: decode failed".to_owned()
        ))
    );
    let names = fake.names();
    assert_eq!(
        names[names.len() - 2..],
        ["delete_conversation", "stream_dropped"]
    );
}

#[tokio::test]
async fn a_reply_that_cannot_start_is_an_engine_failure_with_no_conversation_to_delete() {
    let fake = FakeLiteRt::new();
    fake.script().start_failure = Some("could not create the conversation".to_owned());
    let manager = loaded(&fake).await;

    let ended = reply(&manager, question()).await;

    assert_eq!(
        ended,
        Err(EngineError::EngineFailure(
            "LiteRT-LM failed while generating: could not create the conversation".to_owned()
        ))
    );
    assert_eq!(fake.count("delete_conversation"), 0);
}

#[tokio::test]
async fn every_litert_call_but_the_cancel_runs_on_the_engines_own_thread_and_the_chunks_arrive_on_another()
 {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    reply(&manager, question()).await.unwrap();
    fake.script().endless = true;
    let mut generation = manager.generate(question()).await.unwrap();
    while !matches!(generation.next().await, Ok(Some(EngineEvent::Text(_)))) {}
    generation.cancel();
    let _ = every_event(&mut generation).await;
    manager.unload().await.unwrap();

    for call in fake.history() {
        if call.name == "cancel_reply" {
            assert_ne!(call.thread, ENGINE_THREAD_NAME, "{call:?}");
        } else {
            assert_eq!(call.thread, ENGINE_THREAD_NAME, "{call:?}");
        }
    }
    let callbacks = fake.callback_threads();
    assert!(!callbacks.is_empty());
    assert!(callbacks.iter().all(|name| name == CALLBACK_THREAD_NAME));
}

#[tokio::test]
async fn unload_deletes_the_engine_once_after_the_last_conversation() {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    reply(&manager, question()).await.unwrap();

    manager.unload().await.unwrap();

    let names = fake.names();
    assert_eq!(names.last().map(String::as_str), Some("delete_engine"));
    assert_eq!(fake.count("delete_engine"), 1);
}

#[tokio::test]
async fn an_unloaded_engine_can_load_again() {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    manager.unload().await.unwrap();

    load(&manager).await;
    let events = reply(&manager, question()).await.unwrap();

    assert!(matches!(done_of(&events), EngineEvent::Done { .. }));
    assert_eq!(fake.count("create_engine:cpu"), 2);
}

#[tokio::test]
async fn a_load_abandoned_while_the_engine_opens_still_deletes_that_engine() {
    let fake = FakeLiteRt::new();
    let gate = fake.hold_open();
    let engine = InProcess::new(backend(&fake));

    let loading = engine.load(spec(Some(1024), 4, Backend::Cpu), control());
    gate.wait_until_entered();
    drop(loading);
    gate.release();

    eventually("the abandoned engine to be deleted", || {
        fake.count("delete_engine") == 1
    })
    .await;
}

#[tokio::test]
async fn a_failed_load_deletes_no_engine() {
    let fake = FakeLiteRt::new();
    fake.script().cpu_failure = Some(failure("bad file"));
    let manager = manager_over(&fake);

    let claim = manager.claim_load(target(Backend::Cpu)).unwrap();
    let loaded = claim.run().await;

    assert!(loaded.is_err());
    assert_eq!(fake.count("delete_engine"), 0);
}

#[tokio::test]
async fn the_stream_state_is_reclaimed_exactly_once_and_only_after_the_conversation_is_deleted() {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;

    reply(&manager, question()).await.unwrap();

    assert_eq!(fake.stream_states_dropped(), 1);
    let names = fake.names();
    assert_eq!(
        names[names.len() - 2..],
        ["delete_conversation", "stream_dropped"]
    );
}

#[tokio::test]
async fn the_stream_state_of_a_cancelled_reply_is_reclaimed_exactly_once() {
    let fake = FakeLiteRt::new();
    let (_manager, mut generation) = endless_reply_after_first_text(&fake).await;

    generation.cancel();
    let _ = every_event(&mut generation).await;

    eventually("the stream state to be reclaimed", || {
        fake.stream_states_dropped() >= 1
    })
    .await;
    assert_eq!(fake.stream_states_dropped(), 1);
}

#[tokio::test]
async fn the_current_conversation_is_cleared_before_it_is_deleted_so_a_late_abort_cancels_nothing()
{
    let fake = FakeLiteRt::new();
    let (_manager, mut generation) = endless_reply_after_first_text(&fake).await;
    let canceller = generation.canceller();
    fake.on_delete(move || canceller.cancel());

    generation.cancel();
    let _ = every_event(&mut generation).await;

    eventually("the conversation to be deleted", || {
        fake.count("stream_dropped") == 1
    })
    .await;
    assert_eq!(fake.count("cancel_reply"), 1);
}

#[tokio::test]
async fn a_request_turns_thinking_off_only_when_it_says_so() {
    let fake = FakeLiteRt::new();
    let manager = loaded(&fake).await;
    let thinking = |enable_thinking| {
        asking(GenerationParams {
            enable_thinking,
            ..GenerationParams::default()
        })
    };

    reply(&manager, thinking(true)).await.unwrap();
    reply(&manager, thinking(false)).await.unwrap();

    let asked: Vec<bool> = fake.prompts().iter().map(|p| p.enable_thinking).collect();
    assert_eq!(asked, [true, false]);
}

#[test]
fn the_abort_hook_of_a_model_with_no_reply_running_cancels_nothing() {
    let fake = FakeLiteRt::new();
    let (model, _) = open(&fake, &spec(Some(1024), 4, Backend::Cpu)).unwrap();

    (model.abort_hook())();

    assert_eq!(fake.count("cancel_reply"), 0);
}
