/// The GGUF header parser, as every binding reaches it.
pub mod gguf {
    pub use turbollm_gguf::*;
}

/// The engine layer: one tokio runtime and one `EngineManager` per handle (feature `engines`).
#[cfg(feature = "engines")]
pub mod engines;

#[cfg(feature = "llama")]
mod platform_log;

const VERSION_MARKER_PREFIX: &str = "TURBOLLM_CORE_VERSION=";

/// The release version as searchable bytes, so the publish job can check every target's binary
/// on one runner without loading it (plan P-11). NUL-terminated so 1.15.1 never matches 1.15.10.
#[used]
pub static VERSION_MARKER: &str =
    concat!("TURBOLLM_CORE_VERSION=", env!("CARGO_PKG_VERSION"), "\0");

pub struct CoreInfo {
    pub version: String,
    pub git_sha: String,
    pub target: String,
}

pub fn core_info() -> CoreInfo {
    CoreInfo {
        version: release_version().to_string(),
        git_sha: env!("TURBOLLM_GIT_SHA").to_string(),
        target: env!("TURBOLLM_TARGET").to_string(),
    }
}

/// Read from the marker, so any binary that reports a version also carries the marker bytes.
fn release_version() -> &'static str {
    VERSION_MARKER
        .trim_start_matches(VERSION_MARKER_PREFIX)
        .trim_end_matches('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gguf_module_is_reachable_through_the_core() {
        assert_eq!(gguf::MAX_HEADER_READ, 268_435_456);
        assert_eq!(
            gguf::quant_from_name("model-Q4_K_M.gguf").as_deref(),
            Some("Q4_K_M")
        );
    }

    #[test]
    fn version_is_the_workspace_version() {
        assert_eq!(core_info().version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn version_marker_is_the_nul_terminated_release_version() {
        let expected = format!("TURBOLLM_CORE_VERSION={}\0", env!("CARGO_PKG_VERSION"));
        assert_eq!(VERSION_MARKER, expected);
    }

    #[test]
    fn git_sha_is_unknown_or_a_short_hex_sha() {
        let git_sha = core_info().git_sha;
        let is_short_sha = git_sha.len() >= 7 && git_sha.chars().all(|c| c.is_ascii_hexdigit());
        assert!(
            git_sha == "unknown" || is_short_sha,
            "unexpected git sha {git_sha:?}"
        );
    }

    #[test]
    #[cfg(all(target_arch = "x86_64", target_os = "windows", target_env = "msvc"))]
    fn target_is_the_build_target_triple() {
        assert_eq!(core_info().target, "x86_64-pc-windows-msvc");
    }
}
