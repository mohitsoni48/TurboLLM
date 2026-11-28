//! The session library's behaviour on a real model, one session driven call by call through
//! `LlamaApi` as the engine thread drives it: prefix-cache reuse, the context boundary, an abort
//! part-way through a prefill, the chat template's thinking switch, the end of a reply. These are
//! the ports of the Kotlin `LlamaSessionTest` and `LlamaNativeTest` cases that had no Rust home.
//! Needs a host build (`cargo xtask build-llama --host`): `TURBOLLM_LLAMA_LIB_DIR` names its folder
//! and `TURBOLLM_TEST_GGUF` a Qwen3-family model, whose template honours `enable_thinking`. Without
//! them the tests skip, except on CI, where they fail.

#[path = "support/native_host.rs"]
mod native_host;

use std::ffi::{CString, c_void};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use turbollm_engine_llama::api::{
    END_OF_REPLY, LlamaApi, LlamaCalls, LoadRequest, Sampling, Session, TL_ABORTED,
    TL_CONTEXT_LENGTH_EXCEEDED, TL_OK, TOKEN_SAMPLED,
};
use turbollm_engine_llama::variant;

use native_host::{NativeTestEnv, take_turn};

const CONTEXT_SIZE: i32 = 2048;
const BOUNDARY_CONTEXT_SIZE: i32 = 512;
const THREADS: i32 = 4;
const MAX_GENERATED_TOKENS: usize = 24;
const MAX_TOKENS_TO_THE_END: usize = 1024;
const PROBE_WORDS: i32 = 50;
const BATCH_SIZE: i32 = 512;
const ABORT_AT_FRACTION: f64 = 0.55;
const FILLER: &str = "The grass is green and the sky is blue. ";
const FILLER_BEFORE_PASSWORD: usize = 60;
const FILLER_AFTER_PASSWORD: usize = 10;
const FILLER_ONLY_IN_THE_ABORTED_PROMPT: usize = 70;
const PASSWORD: &str = "ZEBRA";
const PASSWORD_SENTENCE: &str = "The secret password is ZEBRA-PLUM. ";
const PASSWORD_QUESTION: &str = "What is the secret password? Reply with the password only.";

#[test]
fn a_second_turn_decodes_only_the_prompt_after_the_shared_prefix() {
    on_the_real_session(CONTEXT_SIZE, |chat| {
        let opening = conversation(&[user("Hello there.")]);
        let reply = chat.generate_greedily(&opening);
        let follow_up = conversation(&[
            user("Hello there."),
            assistant(&reply),
            user("And how are you?"),
        ]);

        let prompt_tokens = chat.prepared(&follow_up);
        let decoded = chat.stats().prompt_decoded;

        assert!(
            (1..prompt_tokens).contains(&decoded),
            "decoded {decoded} of {prompt_tokens}"
        );
    });
}

#[test]
fn a_prompt_of_exactly_the_context_size_is_refused_while_one_token_shorter_fits() {
    on_the_real_session(BOUNDARY_CONTEXT_SIZE, |chat| {
        let context_size = chat.model_context();
        let words_one_short = chat.words_for_prompt_tokens(context_size - 1);

        let one_short = conversation(&[user(&repeated_word(words_one_short))]);
        assert_eq!(chat.prepared(&one_short), context_size - 1);
        let exactly_full = conversation(&[user(&repeated_word(words_one_short + 1))]);
        assert_eq!(chat.prepare(&exactly_full), TL_CONTEXT_LENGTH_EXCEEDED);
    });
}

/// The abort lands after the first batch and before the batch holding the password, so the
/// follow-up may reuse only what was really decoded: reusing more would leave the password out of
/// the cache.
#[test]
fn a_prompt_sharing_a_prefix_with_a_prefill_aborted_part_way_answers_as_it_would_from_a_fresh_start()
 {
    on_the_real_session(CONTEXT_SIZE, |chat| {
        let before_password = FILLER.repeat(FILLER_BEFORE_PASSWORD);
        let shared = format!(
            "{before_password}{PASSWORD_SENTENCE}{}",
            FILLER.repeat(FILLER_AFTER_PASSWORD)
        );
        let aborted = conversation(&[user(&format!(
            "{shared}{}",
            FILLER.repeat(FILLER_ONLY_IN_THE_ABORTED_PROMPT)
        ))]);
        let follow_up = without_thinking(&[user(&format!("{shared}{PASSWORD_QUESTION}"))]);
        let password_starts_after = chat.prepared(&conversation(&[user(&before_password)]))
            - chat.prepared(&conversation(&[user("")]));
        chat.forget_the_cached_prompt();
        let full_prefill = chat.prefill_duration(&aborted);
        chat.forget_the_cached_prompt();
        let expected = chat.generate_greedily(&follow_up);
        chat.forget_the_cached_prompt();

        let outcome = chat.prepare_aborted_after(&aborted, full_prefill.mul_f64(ABORT_AT_FRACTION));
        chat.clear_abort();
        let answer = chat.generate_greedily(&follow_up);

        assert_eq!(outcome, TL_ABORTED);
        assert!(
            expected.contains(PASSWORD),
            "even a fresh start did not recall the password: {expected}"
        );
        assert_eq!(expected, answer);
        let reused = chat.reused_prompt_tokens();
        assert!(
            (BATCH_SIZE..password_starts_after).contains(&reused),
            "{reused} tokens reused: the abort did not land after one batch and before the password \
             (which starts after {password_starts_after})"
        );
    });
}

#[test]
fn turning_thinking_off_renders_a_different_prompt() {
    on_the_real_session(CONTEXT_SIZE, |chat| {
        let question = [user("What is two plus two?")];

        let thinking = chat.prepared(&conversation(&question));
        let not_thinking = chat.prepared(&without_thinking(&question));

        assert_ne!(thinking, not_thinking);
    });
}

#[test]
fn next_token_after_the_end_of_the_reply_returns_the_end_again() {
    on_the_real_session(CONTEXT_SIZE, |chat| {
        chat.prepared(&without_thinking(&[user("Say OK.")]));
        assert_eq!(chat.start_greedy_sampling(), TL_OK);

        let generated = chat.sample_until_the_reply_ends();

        assert!(
            generated < MAX_TOKENS_TO_THE_END,
            "no end of reply within {MAX_TOKENS_TO_THE_END} tokens"
        );
        assert_eq!(chat.next_status(), END_OF_REPLY);
        assert_eq!(chat.last_error(), "");
    });
}

#[test]
fn a_model_that_does_not_exist_gives_no_session_and_says_why() {
    let Some(llama) = Llama::from_env() else {
        return;
    };
    let _turn = take_turn();

    let failure = llama.open_at(Path::new("no such model.gguf"), CONTEXT_SIZE);

    let message = failure.expect_err("a missing model must not load");
    assert!(message.contains("no such model.gguf"), "{message}");
    assert_eq!(llama.live_sessions(), 0);
}

#[test]
fn a_failure_message_keeps_characters_outside_the_basic_plane() {
    let Some(llama) = Llama::from_env() else {
        return;
    };
    let _turn = take_turn();
    let path = Path::new("no-such-model-\u{1F600}.gguf");

    let message = llama
        .open_at(path, CONTEXT_SIZE)
        .expect_err("a missing model must not load");

    assert!(message.contains("\u{1F600}"), "{message}");
}

/// Runs `test` on a session of the test model at `context_size`, once it is this test's turn.
fn on_the_real_session(context_size: i32, test: impl FnOnce(&mut Chat<'_>)) {
    let Some(llama) = Llama::from_env() else {
        return;
    };
    let _turn = take_turn();
    let mut chat = llama.chat(context_size);
    test(&mut chat);
}

/// The host library resolved, the model the environment names, and the probe it exports.
struct Llama {
    api: LlamaApi,
    model: PathBuf,
}

impl Llama {
    fn from_env() -> Option<Llama> {
        let NativeTestEnv { library_dir, model } = NativeTestEnv::read()?;
        let chosen = variant::load_best(Some(&library_dir)).unwrap_or_else(|e| panic!("{e}"));
        let api = LlamaApi::resolve(chosen.library).unwrap_or_else(|e| panic!("{e}"));
        api.backend_init();
        Some(Llama { api, model })
    }

    fn chat(&self, context_size: i32) -> Chat<'_> {
        Chat::open(self, context_size)
    }

    fn open_at(&self, path: &Path, context_size: i32) -> Result<OpenSession, String> {
        let path = CString::new(path.to_string_lossy().into_owned()).expect("a path without NUL");
        let abort = Arc::new(AtomicBool::new(false));
        let request = LoadRequest {
            path: &path,
            n_ctx: context_size,
            n_threads: THREADS,
            progress: None,
            progress_data: std::ptr::null_mut(),
            abort: Some(abort_requested),
            abort_data: Arc::as_ptr(&abort).cast_mut().cast::<c_void>(),
        };
        // SAFETY: no progress callback; the abort flag is kept beside the session, which frees first.
        let session = unsafe { self.api.load(&request) }?;
        Ok(OpenSession { session, abort })
    }

    /// `tl_llama_live_sessions`, the probe the host build exports through the same library.
    fn live_sessions(&self) -> i32 {
        type LiveSessionsFn = unsafe extern "C" fn() -> i32;
        let path = variant_library_path();
        // SAFETY: the library is ours and already loaded; the signature is the header's.
        unsafe {
            let library = libloading::Library::new(&path)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let live_sessions = library
                .get::<LiveSessionsFn>(b"tl_llama_live_sessions")
                .expect("the host build exports its test probe");
            live_sessions()
        }
    }
}

fn variant_library_path() -> PathBuf {
    let NativeTestEnv { library_dir, .. } = NativeTestEnv::read().expect("the env was read before");
    library_dir.join(turbollm_platform::library_file_name(
        variant::Variant::Base.library_stem(),
    ))
}

unsafe extern "C" fn abort_requested(data: *mut c_void) -> bool {
    // SAFETY: `data` is the `AtomicBool` the session's `OpenSession` keeps beside it.
    unsafe { &*data.cast::<AtomicBool>() }.load(Ordering::SeqCst)
}

#[derive(Debug)]
struct OpenSession {
    session: Session,
    abort: Arc<AtomicBool>,
}

/// One open session with the calls a chat makes on it. Freed when dropped, before its abort flag.
struct Chat<'a> {
    llama: &'a Llama,
    open: Option<OpenSession>,
}

impl<'a> Chat<'a> {
    fn open(llama: &'a Llama, context_size: i32) -> Chat<'a> {
        let open = llama
            .open_at(&llama.model, context_size)
            .unwrap_or_else(|e| panic!("the test model did not load: {e}"));
        Chat {
            llama,
            open: Some(open),
        }
    }

    fn session(&mut self) -> &mut Session {
        &mut self.open.as_mut().expect("the session is open").session
    }

    fn model_context(&self) -> i32 {
        let open = self.open.as_ref().expect("the session is open");
        self.llama.api.model_info(&open.session).n_ctx
    }

    fn prepare(&mut self, request: &str) -> i32 {
        let api = &self.llama.api;
        let open = self.open.as_mut().expect("the session is open");
        api.prepare(&mut open.session, request)
    }

    fn prepared(&mut self, request: &str) -> i32 {
        let prompt_tokens = self.prepare(request);
        assert!(
            prompt_tokens > 0,
            "prepare failed ({prompt_tokens}): {}",
            self.last_error()
        );
        prompt_tokens
    }

    fn stats(&self) -> turbollm_engine_llama::api::Stats {
        let open = self.open.as_ref().expect("the session is open");
        self.llama.api.stats(&open.session)
    }

    fn last_error(&self) -> String {
        let open = self.open.as_ref().expect("the session is open");
        self.llama.api.last_error(&open.session)
    }

    fn reused_prompt_tokens(&self) -> i32 {
        let stats = self.stats();
        stats.prompt_n - stats.prompt_decoded
    }

    fn start_greedy_sampling(&mut self) -> i32 {
        let sampling = Sampling {
            temperature: 0.0,
            top_p: 1.0,
            top_k: 0,
            seed: 0,
        };
        let api = &self.llama.api;
        api.start_sampling(self.session(), &sampling)
    }

    fn next_status(&mut self) -> i32 {
        let api = &self.llama.api;
        let token = api.next_token(self.session());
        token.status
    }

    fn sample_until_the_reply_ends(&mut self) -> usize {
        for generated in 0..MAX_TOKENS_TO_THE_END {
            if self.next_status() != TOKEN_SAMPLED {
                return generated;
            }
        }
        MAX_TOKENS_TO_THE_END
    }

    fn generate_greedily(&mut self, request: &str) -> String {
        self.prepared(request);
        assert_eq!(self.start_greedy_sampling(), TL_OK);
        let mut bytes = Vec::new();
        for _ in 0..MAX_GENERATED_TOKENS {
            let api = &self.llama.api;
            let token = api.next_token(self.session());
            if token.status != TOKEN_SAMPLED {
                break;
            }
            bytes.extend(token.piece);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// How many repeated words make a prompt of `prompt_tokens` tokens, checking each word is one token.
    fn words_for_prompt_tokens(&mut self, prompt_tokens: i32) -> i32 {
        let short = self.prepared(&conversation(&[user(&repeated_word(PROBE_WORDS))]));
        let longer = self.prepared(&conversation(&[user(&repeated_word(PROBE_WORDS * 2))]));
        assert_eq!(
            longer - short,
            PROBE_WORDS,
            "each repeated word should be one token"
        );
        prompt_tokens - (short - PROBE_WORDS)
    }

    fn prefill_duration(&mut self, request: &str) -> Duration {
        self.prepared(request);
        Duration::from_secs_f64(self.stats().prompt_ms / 1000.0)
    }

    /// Leaves only the chat template's opening in the cache, so the next prompt is prefilled from the start.
    fn forget_the_cached_prompt(&mut self) {
        self.prepared(&conversation(&[user("Hi.")]));
    }

    /// Prefills `request` while another thread raises the abort flag after `delay`.
    fn prepare_aborted_after(&mut self, request: &str, delay: Duration) -> i32 {
        let api = &self.llama.api;
        let open = self.open.as_mut().expect("the session is open");
        let flag = Arc::clone(&open.abort);
        std::thread::scope(|scope| {
            let started = Instant::now();
            scope.spawn(move || {
                std::thread::sleep(delay.saturating_sub(started.elapsed()));
                flag.store(true, Ordering::SeqCst);
            });
            api.prepare(&mut open.session, request)
        })
    }

    fn clear_abort(&mut self) {
        let open = self.open.as_ref().expect("the session is open");
        open.abort.store(false, Ordering::SeqCst);
    }
}

impl Drop for Chat<'_> {
    fn drop(&mut self) {
        if let Some(open) = self.open.take() {
            self.llama.api.free(open.session);
        }
    }
}

fn repeated_word(count: i32) -> String {
    vec!["hello"; usize::try_from(count).expect("a word count")].join(" ")
}

fn user(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

fn assistant(text: &str) -> Value {
    json!({ "role": "assistant", "content": text })
}

fn conversation(messages: &[Value]) -> String {
    json!({ "messages": messages }).to_string()
}

fn without_thinking(messages: &[Value]) -> String {
    json!({ "messages": messages, "enable_thinking": false }).to_string()
}
