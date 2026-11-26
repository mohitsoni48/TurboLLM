//! The rule every real-native test follows (T14): `TURBOLLM_LLAMA_LIB_DIR` names a host build's
//! folder (`cargo xtask build-llama --host`) and `TURBOLLM_TEST_GGUF` a small model. Without them
//! a test skips, except on CI, where it fails, so the native tests can never pass vacuously there.
//! Included with `#[path]` so a test of the C ABI does not pull in the fake library.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

const MISSING_ENV: &str = "TURBOLLM_LLAMA_LIB_DIR and TURBOLLM_TEST_GGUF must both be set";

/// The live-session count is process-wide, so the tests that load take turns even without
/// `--test-threads=1`.
static NATIVE: Mutex<()> = Mutex::new(());

/// The host build and the model the environment names.
pub struct NativeTestEnv {
    pub library_dir: PathBuf,
    pub model: PathBuf,
}

impl NativeTestEnv {
    /// `None` when either variable is unset: the test skips, or fails on CI.
    pub fn read() -> Option<NativeTestEnv> {
        let (Some(library_dir), Some(model)) = (
            env_path("TURBOLLM_LLAMA_LIB_DIR").map(from_workspace_root),
            env_path("TURBOLLM_TEST_GGUF"),
        ) else {
            skip_unless_on_ci(std::env::var("CI").as_deref() == Ok("true"), MISSING_ENV);
            return None;
        };
        Some(NativeTestEnv { library_dir, model })
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
const SELF_CHECK: &str = "native_host self-check, no native test skipped";

#[test]
#[should_panic(expected = "native_host self-check, no native test skipped: required on CI")]
fn a_missing_environment_fails_the_test_on_ci() {
    skip_unless_on_ci(true, SELF_CHECK);
}

#[test]
fn a_missing_environment_skips_the_test_off_ci() {
    skip_unless_on_ci(false, SELF_CHECK);
}
