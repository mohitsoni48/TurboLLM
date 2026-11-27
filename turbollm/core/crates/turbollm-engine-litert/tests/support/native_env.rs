//! The rule every real-native test follows (T14, as `native_host.rs` of the llama tests):
//! `TURBOLLM_LITERT_LIB` names the host LiteRT-LM library (`cargo xtask fetch-litert --host`) and
//! `TURBOLLM_TEST_LITERTLM` a small `.litertlm` model. Without them a test skips, except on CI,
//! where it fails, so the native tests can never pass vacuously there.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

const MISSING_ENV: &str = "TURBOLLM_LITERT_LIB and TURBOLLM_TEST_LITERTLM must both be set";

/// One LiteRT engine at a time on the host (the single-inference rule), even without
/// `--test-threads=1`.
static NATIVE: Mutex<()> = Mutex::new(());

/// The host library and the model the environment names.
pub struct NativeTestEnv {
    pub library: PathBuf,
    pub model: PathBuf,
}

impl NativeTestEnv {
    /// `None` when either variable is unset: the test skips, or fails on CI.
    pub fn read() -> Option<NativeTestEnv> {
        let (Some(library), Some(model)) = (
            env_path("TURBOLLM_LITERT_LIB").map(from_workspace_root),
            env_path("TURBOLLM_TEST_LITERTLM"),
        ) else {
            skip_unless_on_ci(std::env::var("CI").as_deref() == Ok("true"), MISSING_ENV);
            return None;
        };
        Some(NativeTestEnv { library, model })
    }
}

pub fn take_turn() -> MutexGuard<'static, ()> {
    NATIVE.lock().unwrap_or_else(PoisonError::into_inner)
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Cargo runs tests from the crate folder; a relative path is meant from `core/`, where cargo is invoked.
fn from_workspace_root(path: PathBuf) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(path)
}

fn skip_unless_on_ci(on_ci: bool, reason: &str) {
    assert!(!on_ci, "{reason}: required on CI");
    println!("skipped: {reason}");
}

/// The rule's own check; its reason says so, so a CI log never reads it as a skipped native test.
const SELF_CHECK: &str = "native_env self-check, no native test skipped";

#[test]
#[should_panic(expected = "native_env self-check, no native test skipped: required on CI")]
fn a_missing_environment_fails_the_test_on_ci() {
    skip_unless_on_ci(true, SELF_CHECK);
}

#[test]
fn a_missing_environment_skips_the_test_off_ci() {
    skip_unless_on_ci(false, SELF_CHECK);
}
