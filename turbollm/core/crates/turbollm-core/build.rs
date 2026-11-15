use std::env;
use std::process::Command;

const SHORT_SHA_LEN: usize = 7;
const UNKNOWN_SHA: &str = "unknown";
// core-build.yml sets this from the commit it checked out (`inputs.ref`); GITHUB_SHA is the caller's commit, which
// differs for a dispatched release build.
const BUILT_COMMIT_VARS: [&str; 2] = ["TURBOLLM_GIT_SHA", "GITHUB_SHA"];

fn main() {
    for var in BUILT_COMMIT_VARS {
        println!("cargo:rerun-if-env-changed={var}");
    }
    println!("cargo:rustc-env=TURBOLLM_GIT_SHA={}", git_sha());
    println!("cargo:rustc-env=TURBOLLM_TARGET={}", build_target());
}

fn git_sha() -> String {
    ci_commit_sha()
        .or_else(local_checkout_sha)
        .unwrap_or_else(|| UNKNOWN_SHA.to_string())
}

fn ci_commit_sha() -> Option<String> {
    BUILT_COMMIT_VARS.into_iter().find_map(short_sha_from_env)
}

fn short_sha_from_env(var: &str) -> Option<String> {
    let sha = env::var(var).ok()?;
    let short: String = sha.trim().chars().take(SHORT_SHA_LEN).collect();
    (!short.is_empty()).then_some(short)
}

fn local_checkout_sha() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

fn build_target() -> String {
    env::var("TARGET").expect("cargo sets TARGET for build scripts")
}
