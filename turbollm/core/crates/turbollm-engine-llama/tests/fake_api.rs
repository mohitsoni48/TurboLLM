//! The llama backend's own logic over a scripted session library: one test per `@Test` of the
//! Kotlin SDK's `LlamaCppEngineFakeNativeTest.kt` (35), then the GGUF-header context cases (QA E-1,
//! E-2, PG-9), the load control, the contract strings of arch 3.7 and a panicking reply.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use tempfile::TempDir;
use turbollm_engine::{
    AbortSignal, Backend, Engine, EngineError, EngineEvent, EngineKind, FinishReason,
    GenerationParams, InProcess, LoadControl, MODEL_NOT_LOADED, ModelInfo, NativeBackend,
    NativeModel, REPLY_CANCELLED, StallPolicy,
};
use turbollm_engine_llama::api::{
    Sampling, TL_CONTEXT_LENGTH_EXCEEDED, TL_FAILED, TL_TEMPLATE_UNSUPPORTED,
};
use turbollm_engine_llama::{ENGINE_THREAD_NAME, GPU_UNAVAILABLE_NOTE, LlamaModel};
use turbollm_platform::{HostFacts, default_thread_count};

use support::fake_llama::{FAKE_LIBRARY_FILE, FakeLlama, LOAD_ABORTED, Opened, delta};
use support::gguf::{header_with_contexts, model_trained_at, write};
use support::*;

const HEADER_DISAGREED: &str =
    "context from the GGUF header (32768) disagreed with llama.cpp (2048); reopened at 2048";

fn open(
    fake: &Arc<FakeLlama>,
    spec: &turbollm_engine::LoadSpec,
) -> Result<(LlamaModel, ModelInfo), EngineError> {
    backend(fake).open(spec, &control())
}

fn open_info(fake: &Arc<FakeLlama>, spec: &turbollm_engine::LoadSpec) -> ModelInfo {
    open(fake, spec).unwrap_or_else(|e| panic!("{e}")).1
}

fn tiny() -> &'static Path {
    Path::new(MODEL)
}

#[test]
fn a_load_opens_the_model_at_the_requested_context_and_threads_on_cpu() {
    let fake = FakeLlama::new();

    let info = open_info(&fake, &spec(tiny(), Some(2048), 3, Backend::Auto));

    let opened = Opened {
        path: absolute(MODEL),
        context_size: 2048,
        threads: 3,
    };
    assert_eq!(fake.seen().opened, [opened]);
    let expected = ModelInfo {
        context_size: 2048,
        trained_context: Some(32_768),
        backend: Backend::Cpu,
        notes: Vec::new(),
    };
    assert_eq!(info, expected);
    assert_eq!(backend(&fake).descriptor().kind, EngineKind::LlamaCpp);
}

#[test]
fn without_a_context_size_the_context_is_4096_tokens() {
    let fake = FakeLlama::new();

    let info = open_info(&fake, &default_spec(tiny()));

    assert_eq!(fake.opened_contexts(), [4096]);
    assert_eq!(info.context_size, 4096);
}

#[test]
fn a_model_trained_on_fewer_tokens_is_reopened_at_its_trained_context() {
    let fake = FakeLlama::new();
    fake.script().trained_context = 2048;

    let (_model, info) = open(&fake, &default_spec(tiny())).unwrap();

    assert_eq!(fake.opened_contexts(), [4096, 2048]);
    assert_eq!(fake.seen().freed, [1]);
    assert_eq!(info.context_size, 2048);
    assert_eq!(info.trained_context, Some(2048));
}

#[test]
fn an_explicit_context_size_is_kept_even_above_the_trained_context() {
    let fake = FakeLlama::new();
    fake.script().trained_context = 2048;

    let info = open_info(&fake, &spec(tiny(), Some(8192), 4, Backend::Auto));

    assert_eq!(fake.opened_contexts(), [8192]);
    assert_eq!(info.context_size, 8192);
}

/// The default comes from the manager, which fills `LoadSpec.threads` (`manager/load.rs`).
#[tokio::test]
async fn without_a_thread_count_the_devices_default_is_used() {
    let fake = FakeLlama::new();

    loaded(&fake).await;

    let threads: Vec<i32> = fake.seen().opened.iter().map(|open| open.threads).collect();
    let device_default = i32::try_from(default_thread_count()).unwrap();
    assert_eq!(threads, [device_default]);
}

#[test]
fn a_gpu_request_runs_on_cpu_with_a_note() {
    let fake = FakeLlama::new();

    let info = open_info(&fake, &spec(tiny(), None, 4, Backend::Gpu));

    assert_eq!(info.backend, Backend::Cpu);
    assert_eq!(
        info.notes,
        ["GPU is not available for llama.cpp in M1; ran on CPU"]
    );
    assert_eq!(
        GPU_UNAVAILABLE_NOTE,
        "GPU is not available for llama.cpp in M1; ran on CPU"
    );
}

#[test]
fn a_model_the_native_layer_cannot_open_fails_as_model_load_failed_with_its_reason() {
    let fake = FakeLlama::new();
    fake.script().open_failure = Some("unknown model architecture: 'mamba9'".to_owned());

    let failure = open(&fake, &default_spec(tiny())).err();

    assert_eq!(
        failure,
        Some(EngineError::ModelLoadFailed(
            "llama.cpp could not load the model: unknown model architecture: 'mamba9'".to_owned()
        ))
    );
}

#[test]
fn an_engine_whose_library_cannot_load_is_unavailable_and_opens_nothing() {
    let fake = FakeLlama::new();
    let unavailable = EngineError::EngineUnavailable {
        engine: turbollm_engine::EngineId::new(turbollm_engine::EngineId::LLAMA_CPP_CPU),
        kind: EngineKind::LlamaCpp,
        reason: "No llama.cpp library in this build runs on this CPU.".to_owned(),
    };
    fake.script().library_failure = Some(unavailable.clone());

    let failure = open(&fake, &default_spec(tiny())).err();

    assert_eq!(failure, Some(unavailable));
    assert!(fake.seen().opened.is_empty());
}

#[test]
fn the_library_is_loaded_before_the_model_is_opened() {
    let fake = FakeLlama::new();

    open_info(&fake, &default_spec(tiny()));

    assert_eq!(
        fake.call_names()[..3],
        ["load library", "backend_init", "load"]
    );
}

#[tokio::test]
async fn every_native_call_runs_on_the_engines_own_thread() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(&[("Hi", delta("Hi", ""))], delta("", ""));
    reply(&manager, question()).await.unwrap();
    manager.unload().await.unwrap();

    let threads: Vec<String> = fake.seen().calls.iter().map(|c| c.thread.clone()).collect();
    assert!(!threads.is_empty());
    assert!(
        threads.iter().all(|thread| thread == ENGINE_THREAD_NAME),
        "{threads:?}"
    );
    assert_eq!(ENGINE_THREAD_NAME, "turbollm-llama");
    assert_ne!(std::thread::current().name(), Some(ENGINE_THREAD_NAME));
}

#[tokio::test]
async fn a_reply_reports_its_prefilled_prompt_then_streams_reasoning_and_text_then_done_with_the_native_stats()
 {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(
        &[
            ("<think>", delta("", "")),
            ("hmm", delta("", "hmm")),
            ("</think>", delta("", "")),
            ("Hi", delta("Hi", "")),
        ],
        delta("!", ""),
    );

    let events = reply(&manager, question()).await.unwrap();

    let expected = [
        EngineEvent::Prefilled {
            prompt_tokens: 12,
            prompt_ms: 30.5,
        },
        EngineEvent::Reasoning("hmm".to_owned()),
        EngineEvent::Text("Hi".to_owned()),
        EngineEvent::Text("!".to_owned()),
        EngineEvent::Done {
            reason: FinishReason::Stop,
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_ms: 30.5,
            gen_ms: 40.0,
        },
    ];
    assert_eq!(events, expected);
}

#[tokio::test]
async fn a_delta_with_both_parts_emits_the_reasoning_first() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(&[("x", delta("answer", "thought"))], delta("", ""));

    let events = reply(&manager, question()).await.unwrap();

    let expected = [
        EngineEvent::Reasoning("thought".to_owned()),
        EngineEvent::Text("answer".to_owned()),
    ];
    assert_eq!(pieces(&events), expected);
}

#[tokio::test]
async fn the_prompt_carries_the_messages_the_thinking_switch_and_the_template_kwargs() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    let params = GenerationParams {
        enable_thinking: false,
        template_kwargs: [("custom".to_owned(), "\"value\"".to_owned())].into(),
        ..GenerationParams::default()
    };

    reply(&manager, asking(params)).await.unwrap();

    let requests = fake.seen().requests.clone();
    let request: serde_json::Value = serde_json::from_str(&requests[0]).unwrap();
    assert_eq!(requests.len(), 1);
    let message = &request["messages"][0];
    assert_eq!(request["messages"].as_array().unwrap().len(), 1);
    assert_eq!(message["role"], "user");
    assert_eq!(message["content"], "Hello?");
    assert_eq!(request["enable_thinking"], false);
    assert_eq!(request["chat_template_kwargs"]["custom"], "\"value\"");
}

#[tokio::test]
async fn unset_sampling_parameters_use_the_defaults_and_a_random_seed() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;

    reply(&manager, question()).await.unwrap();

    let defaults = Sampling {
        temperature: 0.8,
        top_p: 0.95,
        top_k: 40,
        seed: -1,
    };
    assert_eq!(fake.seen().samplings, [defaults]);
}

#[tokio::test]
async fn given_sampling_parameters_reach_the_sampler() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    let params = GenerationParams {
        temperature: Some(0.0),
        top_p: Some(0.5),
        top_k: Some(7),
        seed: Some(42),
        ..GenerationParams::default()
    };

    reply(&manager, asking(params)).await.unwrap();

    let given = Sampling {
        temperature: 0.0,
        top_p: 0.5,
        top_k: 7,
        seed: 42,
    };
    assert_eq!(fake.seen().samplings, [given]);
}

#[tokio::test]
async fn a_reply_that_fills_the_context_ends_with_length() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(&[("a", delta("a", ""))], delta("", ""));
    fake.script().context_full = true;

    let events = reply(&manager, question()).await.unwrap();

    assert_eq!(finish_reason(&events), FinishReason::Length);
}

#[tokio::test]
async fn the_reply_ends_with_length_once_max_tokens_tokens_are_sampled() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().endless_reply = true;
    let params = GenerationParams {
        max_tokens: Some(5),
        ..GenerationParams::default()
    };

    let events = reply(&manager, asking(params)).await.unwrap();

    let Some(EngineEvent::Done {
        reason,
        completion_tokens,
        ..
    }) = events.last()
    else {
        panic!("no Done in {events:?}");
    };
    assert_eq!((*reason, *completion_tokens), (FinishReason::Length, 5));
    let sampled = fake
        .call_names()
        .iter()
        .filter(|name| *name == "next_token")
        .count();
    assert_eq!(sampled, 5);
}

#[tokio::test]
async fn a_token_that_only_begins_a_character_is_parsed_once_the_character_is_complete() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    let smile = "😀".as_bytes();
    fake.reply_bytes(&smile[..2], None);
    fake.reply_bytes(&smile[2..], Some(delta("😀", "")));
    fake.reply_bytes(b"!", Some(delta("!", "")));

    let events = reply(&manager, question()).await.unwrap();

    assert_eq!(fake.seen().partial_parses, 2);
    let expected = [
        EngineEvent::Text("😀".to_owned()),
        EngineEvent::Text("!".to_owned()),
    ];
    assert_eq!(pieces(&events), expected);
}

#[tokio::test]
async fn a_prompt_that_does_not_fit_is_context_length_exceeded() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().prepare_sentinel = Some(TL_CONTEXT_LENGTH_EXCEEDED);
    fake.script().prepare_failure =
        "The prompt is 5000 tokens, and the context holds 4096.".to_owned();

    let failure = reply(&manager, question()).await.err();

    assert_eq!(
        failure,
        Some(EngineError::ContextLengthExceeded(
            "The prompt is 5000 tokens, and the context holds 4096.".to_owned()
        ))
    );
}

/// An empty detail: the bridge answers with Kotlin's default text (`TurboLLMException.kt:47`).
#[tokio::test]
async fn a_template_that_cannot_render_is_template_unsupported() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().prepare_sentinel = Some(TL_TEMPLATE_UNSUPPORTED);

    let failure = reply(&manager, question()).await.err();

    assert_eq!(
        failure,
        Some(EngineError::TemplateUnsupported(String::new()))
    );
}

#[tokio::test]
async fn a_failed_prefill_is_an_engine_failure_with_the_native_reason() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().prepare_sentinel = Some(TL_FAILED);
    fake.script().prepare_failure = "llama_decode returned 1".to_owned();

    let failure = reply(&manager, question()).await.err();

    assert_eq!(
        failure,
        Some(EngineError::EngineFailure(
            "llama.cpp could not process the prompt: llama_decode returned 1".to_owned()
        ))
    );
}

#[tokio::test]
async fn a_failed_token_is_an_engine_failure_with_the_native_reason() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(&[("a", delta("a", ""))], delta("", ""));
    fake.script().token_failure = "llama_decode returned -3".to_owned();

    let failure = reply(&manager, question()).await.err();

    assert_eq!(
        failure,
        Some(EngineError::EngineFailure(
            "llama.cpp failed while generating: llama_decode returned -3".to_owned()
        ))
    );
}

/// Kotlin cleared the native flag before each prompt; here the flag is Rust's, lowered by every
/// generate, so a reply cancelled mid-prefill leaves the next prompt free to run.
#[tokio::test]
async fn the_abort_flag_is_cleared_before_every_prompt() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    cancel_a_prefill_that_only_an_abort_ends(&fake, &manager).await;

    reply(&manager, question()).await.unwrap();
    reply(&manager, question()).await.unwrap();

    assert_eq!(fake.seen().abort_at_prepare, [false, false, false]);
}

#[tokio::test]
async fn cancelling_during_prefill_aborts_the_native_decode_and_completes_promptly() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().prefill_waits_for_abort = true;
    let mut generation = manager.generate(question()).await.unwrap();
    eventually("the prefill to start", || fake.seen().prefill_started).await;

    generation.cancel();
    let ended = tokio::time::timeout(PROMPT_LIMIT, every_event(&mut generation)).await;

    assert_eq!(
        ended.ok(),
        Some(Err(EngineError::Cancelled(REPLY_CANCELLED.to_owned())))
    );
    eventually("the native prefill to see the abort", || {
        fake.seen().lifecycle == ["abort seen", "prefill ended"]
    })
    .await;
    assert_eq!(REPLY_CANCELLED, "The reply was cancelled.");
}

#[tokio::test]
async fn a_reply_cancelled_during_prefill_leaves_the_engine_ready_for_the_next() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    cancel_a_prefill_that_only_an_abort_ends(&fake, &manager).await;

    let events = tokio::time::timeout(PROMPT_LIMIT, reply(&manager, question())).await;

    assert_eq!(finish_reason(&events.unwrap().unwrap()), FinishReason::Stop);
}

#[tokio::test]
async fn a_collector_that_stops_after_the_first_token_aborts_and_the_next_reply_works() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().endless_reply = true;
    let mut generation = manager.generate(question()).await.unwrap();
    while !matches!(generation.next().await, Ok(Some(EngineEvent::Text(_)))) {}

    drop(generation);
    eventually("the endless reply to stop", || !busy(&manager)).await;
    fake.script().endless_reply = false;
    let next = tokio::time::timeout(PROMPT_LIMIT, reply(&manager, question())).await;

    assert_eq!(finish_reason(&next.unwrap().unwrap()), FinishReason::Stop);
    assert_eq!(fake.seen().abort_at_prepare, [false, false]);
}

#[tokio::test]
async fn a_reply_that_ends_normally_never_requests_an_abort() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(&[("Hi", delta("Hi", ""))], delta("", ""));

    reply(&manager, question()).await.unwrap();

    assert!(!fake.native_abort_raised());
}

#[tokio::test]
async fn unload_frees_the_session_and_stops_the_engine_thread() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;

    manager.unload().await.unwrap();

    assert_eq!(fake.seen().freed, [1]);
    assert_eq!(fake.seen().engine_threads_exited, 1);
}

#[tokio::test]
async fn unloading_during_a_prefill_aborts_it_and_returns_only_once_the_prefill_has_ended_and_the_session_is_free()
 {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    let _generation = start_a_prefill_that_only_an_abort_ends(&fake, &manager).await;

    tokio::time::timeout(PROMPT_LIMIT, manager.unload())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        fake.seen().lifecycle,
        ["abort seen", "prefill ended", "free"]
    );
}

#[tokio::test]
async fn a_reply_ended_by_an_unload_does_not_abort_its_freed_session_again() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    let mut generation = start_a_prefill_that_only_an_abort_ends(&fake, &manager).await;

    manager.unload().await.unwrap();
    let ended = tokio::time::timeout(PROMPT_LIMIT, every_event(&mut generation)).await;
    drop(generation);

    assert!(ended.unwrap().is_err());
    assert_eq!(
        fake.seen().lifecycle,
        ["abort seen", "prefill ended", "free"]
    );
}

/// Kotlin's fire-and-forget `close`; the manager's is `shutdown`.
#[tokio::test]
async fn closing_during_a_prefill_aborts_it_and_frees_the_session_only_once_the_prefill_has_ended()
{
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    let _generation = start_a_prefill_that_only_an_abort_ends(&fake, &manager).await;

    tokio::time::timeout(PROMPT_LIMIT, manager.shutdown())
        .await
        .unwrap();

    assert_eq!(
        fake.seen().lifecycle,
        ["abort seen", "prefill ended", "free"]
    );
    assert_eq!(fake.seen().engine_threads_exited, 1);
}

#[tokio::test]
async fn a_model_can_be_loaded_again_after_unload() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    manager.unload().await.unwrap();

    load(&manager).await;
    let events = reply(&manager, question()).await.unwrap();

    assert_eq!(fake.seen().opened.len(), 2);
    assert_eq!(finish_reason(&events), FinishReason::Stop);
}

#[tokio::test]
async fn closing_after_a_failed_load_stops_the_engine_thread() {
    let fake = FakeLlama::new();
    fake.script().open_failure = Some("out of memory".to_owned());
    let engine = InProcess::new(backend(&fake));

    let loaded = engine.load(default_spec(tiny()), control()).await;

    assert!(matches!(loaded, Err(EngineError::ModelLoadFailed(_))));
    eventually("the engine thread to exit", || {
        fake.seen().engine_threads_exited == 1
    })
    .await;
}

#[tokio::test]
async fn closing_a_loaded_engine_frees_its_session() {
    let fake = FakeLlama::new();
    let engine = InProcess::new(backend(&fake));
    let model = engine.load(default_spec(tiny()), control()).await.unwrap();

    drop(model);

    eventually("the engine thread to exit", || {
        fake.seen().engine_threads_exited == 1
    })
    .await;
    assert_eq!(fake.seen().freed, [1]);
}

#[tokio::test]
async fn generating_with_nothing_loaded_is_model_not_loaded() {
    let fake = FakeLlama::new();
    let manager = manager_over(&fake);

    let refused = manager.generate(question()).await.err();

    assert_eq!(
        refused,
        Some(EngineError::ModelNotLoaded(MODEL_NOT_LOADED.to_owned()))
    );
}

#[test]
fn e1_a_header_of_2048_opens_once_at_2048() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let model = model_trained_at(dir.path(), "small.gguf", 2048);

    let info = open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [2048]);
    assert_eq!(
        (info.context_size, info.trained_context),
        (2048, Some(2048))
    );
}

#[test]
fn e2_a_header_of_32768_opens_once_at_4096() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    let model = model_trained_at(dir.path(), "long.gguf", 32_768);

    open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [4096]);
}

#[test]
fn e2_a_header_of_4096_opens_once_at_4096() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 4096;
    let model = model_trained_at(dir.path(), "exact.gguf", 4096);

    open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [4096]);
}

#[test]
fn e2_a_header_without_a_context_length_keeps_the_old_reopen_rule() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let model = write(dir.path(), "silent.gguf", &header_with_contexts(&[]));

    open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [4096, 2048]);
}

#[test]
fn e2_a_header_of_0_keeps_the_old_reopen_rule() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let model = model_trained_at(dir.path(), "zero.gguf", 0);

    open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [4096, 2048]);
}

#[test]
fn e2_a_file_that_is_not_a_gguf_keeps_the_old_two_step() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let model = write(dir.path(), "notes.gguf", b"not a model at all");

    open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [4096, 2048]);
}

#[test]
fn e2_an_explicit_1024_with_a_header_of_32768_opens_once_at_1024() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    let model = model_trained_at(dir.path(), "long.gguf", 32_768);

    open_info(&fake, &spec(&model, Some(1024), 4, Backend::Auto));

    assert_eq!(fake.opened_contexts(), [1024]);
}

#[test]
fn e2_an_explicit_8192_with_a_header_of_2048_opens_once_at_8192() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let model = model_trained_at(dir.path(), "small.gguf", 2048);

    open_info(&fake, &spec(&model, Some(8192), 4, Backend::Auto));

    assert_eq!(fake.opened_contexts(), [8192]);
}

#[test]
fn e2_a_split_gguf_is_sized_from_its_first_shard() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let first = model_trained_at(dir.path(), "m-00001-of-00002.gguf", 2048);
    model_trained_at(dir.path(), "m-00002-of-00002.gguf", 32_768);

    open_info(&fake, &default_spec(&first));

    assert_eq!(fake.opened_contexts(), [2048]);
}

#[test]
fn pg9_a_header_llama_cpp_disagrees_with_is_reopened_at_llama_cpps_context_and_logged_once() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let header = header_with_contexts(&[
        ("qwen3.context_length", 2048),
        ("foo.context_length", 32_768),
    ]);
    let model = write(dir.path(), "two-keys.gguf", &header);
    let (backend, log) = logged_backend(&fake);

    let (_model, info) = backend.open(&default_spec(&model), &control()).unwrap();

    assert_eq!(fake.opened_contexts(), [4096, 2048]);
    assert_eq!(fake.seen().freed.len(), 1);
    assert_eq!(info.context_size, 2048);
    assert_eq!(header_disagreements(&log), [HEADER_DISAGREED]);
}

#[test]
fn pg9_a_header_below_the_trained_context_reopens_at_the_kotlin_context() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 40_960;
    let header = header_with_contexts(&[
        ("qwen3.context_length", 40_960),
        ("foo.context_length", 1024),
    ]);
    let model = write(dir.path(), "late-small-key.gguf", &header);
    let (backend, log) = logged_backend(&fake);

    let (_model, info) = backend.open(&default_spec(&model), &control()).unwrap();

    assert_eq!(fake.opened_contexts(), [1024, 4096]);
    assert_eq!(fake.seen().freed.len(), 1);
    assert_eq!(info.context_size, 4096);
    assert_eq!(
        header_disagreements(&log),
        ["context from the GGUF header (1024) disagreed with llama.cpp (40960); reopened at 4096"]
    );
}

#[test]
fn pg9_a_header_below_a_small_trained_context_reopens_at_the_trained_context() {
    let (dir, fake) = (TempDir::new().unwrap(), FakeLlama::new());
    fake.script().trained_context = 2048;
    let model = model_trained_at(dir.path(), "understated.gguf", 1024);

    let info = open_info(&fake, &default_spec(&model));

    assert_eq!(fake.opened_contexts(), [1024, 2048]);
    assert_eq!(info.context_size, 2048);
}

fn header_disagreements(log: &std::sync::Mutex<Vec<String>>) -> Vec<String> {
    log.lock()
        .unwrap()
        .iter()
        .filter(|line| line.contains("GGUF header"))
        .cloned()
        .collect()
}

#[test]
fn the_old_reopen_rule_logs_no_header_disagreement() {
    let fake = FakeLlama::new();
    fake.script().trained_context = 2048;
    let (backend, log) = logged_backend(&fake);

    backend.open(&default_spec(tiny()), &control()).unwrap();

    assert!(
        log.lock()
            .unwrap()
            .iter()
            .all(|line| !line.contains("GGUF header"))
    );
}

#[test]
fn the_library_opens_once_per_backend_and_its_file_is_logged_once() {
    let fake = FakeLlama::new();
    let (backend, log) = logged_backend(&fake);

    for _ in 0..2 {
        backend.open(&default_spec(tiny()), &control()).unwrap();
    }

    let library_loads = fake
        .call_names()
        .iter()
        .filter(|n| *n == "load library")
        .count();
    assert_eq!(library_loads, 1);
    let loaded = format!(
        "llama.cpp loaded {}",
        Path::new(FAKE_LIBRARY_FILE).display()
    );
    assert_eq!(*log.lock().unwrap(), [loaded]);
}

#[test]
fn load_progress_reaches_the_load_control() {
    let fake = FakeLlama::new();
    fake.script().load_progress = vec![0.25, 1.0];
    let reported = Arc::new(AtomicU32::new(0));
    let seen = Arc::clone(&reported);
    let ctl = LoadControl {
        progress: Arc::new(move |progress| seen.store(progress.to_bits(), Ordering::SeqCst)),
        abort: AbortSignal::new(),
    };

    backend(&fake).open(&default_spec(tiny()), &ctl).unwrap();

    assert_eq!(f32::from_bits(reported.load(Ordering::SeqCst)), 1.0);
    assert_eq!(fake.seen().progress_answers, [true, true]);
}

#[test]
fn an_aborted_load_is_stopped_by_its_progress_callback() {
    let fake = FakeLlama::new();
    fake.script().load_progress = vec![0.25];
    let ctl = control();
    ctl.abort.abort();

    let failure = backend(&fake).open(&default_spec(tiny()), &ctl).err();

    assert_eq!(fake.seen().progress_answers, [false]);
    let expected = format!("llama.cpp could not load the model: {LOAD_ABORTED}");
    assert_eq!(failure, Some(EngineError::ModelLoadFailed(expected)));
}

#[test]
fn the_backend_is_watched_for_stalls_runs_on_the_llama_thread_and_runs_on_this_cpu() {
    let backend = backend(&FakeLlama::new());

    assert_eq!(backend.stall_policy(), StallPolicy::Watch);
    assert_eq!(backend.thread_name(), "turbollm-llama");
    assert_eq!(backend.probe(&HostFacts::detect()), None);
}

#[tokio::test]
async fn a_sampler_that_cannot_start_is_an_engine_failure_with_the_native_reason() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().sampling_failure = Some("no sampler".to_owned());

    let failure = reply(&manager, question()).await.err();

    let expected = "llama.cpp could not start sampling: no sampler".to_owned();
    assert_eq!(failure, Some(EngineError::EngineFailure(expected)));
}

#[tokio::test]
async fn a_reply_the_parser_cannot_read_is_an_engine_failure_with_the_native_reason() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.script().parse_failure = Some("bad delta".to_owned());

    let failure = reply(&manager, question()).await.err();

    let expected = "llama.cpp could not read the reply: bad delta".to_owned();
    assert_eq!(failure, Some(EngineError::EngineFailure(expected)));
}

#[tokio::test]
async fn a_reply_that_panics_ends_as_an_engine_failure_and_the_model_still_serves_and_frees() {
    let fake = FakeLlama::new();
    let manager = loaded(&fake).await;
    fake.reply(&[("a", delta("a", ""))], delta("", ""));
    fake.script().panic_on_next_token = Some("the fake sampler broke");

    let failure = reply(&manager, question()).await.err();
    fake.script().panic_on_next_token = None;
    let next = reply(&manager, question()).await.unwrap();
    manager.unload().await.unwrap();

    let broke = EngineError::EngineFailure("the fake sampler broke".to_owned());
    assert_eq!(failure, Some(broke));
    assert_eq!(finish_reason(&next), FinishReason::Stop);
    assert_eq!(fake.seen().freed, [1]);
}

#[test]
fn an_abort_hook_raised_off_the_engine_thread_reaches_the_native_flag() {
    let fake = FakeLlama::new();
    let (model, _info) = open(&fake, &default_spec(tiny())).unwrap();
    let hook = model.abort_hook();

    std::thread::spawn(move || hook()).join().unwrap();

    assert!(fake.native_abort_raised());
    model.close();
    assert_eq!(fake.seen().freed, [1]);
}

/// True while a native generate runs: the engine thread holds the gate's permit until it returns.
fn busy(manager: &turbollm_engine::EngineManager) -> bool {
    matches!(
        manager.snapshot().state,
        turbollm_engine::EngineState::Ready { busy: true, .. }
    )
}

fn finish_reason(events: &[EngineEvent]) -> FinishReason {
    match events.last() {
        Some(EngineEvent::Done { reason, .. }) => *reason,
        other => panic!("the reply ended without Done: {other:?}"),
    }
}

/// A reply whose prefill, like a long real one, returns only once the native abort flag is set.
async fn start_a_prefill_that_only_an_abort_ends(
    fake: &Arc<FakeLlama>,
    manager: &turbollm_engine::EngineManager,
) -> turbollm_engine::Generation {
    fake.script().prefill_waits_for_abort = true;
    let generation = manager.generate(question()).await.unwrap();
    eventually("the prefill to start", || fake.seen().prefill_started).await;
    generation
}

async fn cancel_a_prefill_that_only_an_abort_ends(
    fake: &Arc<FakeLlama>,
    manager: &turbollm_engine::EngineManager,
) {
    let mut generation = start_a_prefill_that_only_an_abort_ends(fake, manager).await;
    generation.cancel();
    let ended = tokio::time::timeout(PROMPT_LIMIT, every_event(&mut generation)).await;
    assert!(ended.unwrap().is_err());
    fake.script().prefill_waits_for_abort = false;
}
