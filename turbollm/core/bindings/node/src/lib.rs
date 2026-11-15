//! The Node addon over TurboLLM's core (architecture 5.1). File reads run on the libuv pool, never on the
//! JavaScript thread (B-4); a GGUF failure rejects with an `Error` whose `code` is the core's error code.

use std::any::Any;
use std::panic::{self, AssertUnwindSafe};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use turbollm_core::gguf;

/// The highest N-API version this addon may use (B-7).
const NAPI_LEVEL: u32 = 8;

/// The npm target suffix `core/scripts/build-node.mjs` builds for; a plain `cargo build` has none.
const NPM_TARGET: &str = match option_env!("TURBOLLM_NPM_TARGET") {
    Some(target) => target,
    None => "unknown",
};

#[napi(object)]
pub struct GgufMeta {
    pub arch: String,
    pub name: String,
    pub quant: String,
    pub size_label: String,
    pub native_ctx: u32,
    pub block_count: u32,
    pub embed_len: u32,
    pub head_count_kv: u32,
    pub head_dim: u32,
    pub expert_count: u32,
    pub nextn_layers: u32,
    pub has_chat_template: bool,
    pub reasoning_effort: bool,
    pub sliding_window: u32,
    pub sliding_window_pattern: Vec<bool>,
    pub head_dim_swa: u32,
    pub head_count_kv_per_layer: Vec<u32>,
    pub full_attention_interval: u32,
    pub ssm_inner_size: u32,
    pub ssm_state_size: u32,
    pub ssm_conv_kernel: u32,
    pub data_end: f64,
}

#[napi(object)]
pub struct CoreInfo {
    pub version: String,
    pub git_sha: String,
    pub target: String,
    pub napi_level: u32,
}

/// Rejects with an Error whose `code` is one of not_gguf | bad_version | truncated | bad_type | too_large | io.
/// A negative, NaN or non-integer `maxRead` rejects with code `InvalidArg`; it defaults to 256 MiB.
#[napi(ts_return_type = "Promise<GgufMeta>")]
pub fn parse_gguf(path: String, max_read: Option<f64>) -> AsyncTask<ParseGguf> {
    AsyncTask::new(ParseGguf { path, max_read })
}

/// A negative, NaN or non-integer `size` rejects with code `InvalidArg`.
#[napi(ts_return_type = "Promise<boolean>")]
pub fn gguf_cut_short(path: String, size: f64) -> AsyncTask<GgufCutShort> {
    AsyncTask::new(GgufCutShort { path, size })
}

#[napi]
pub fn quant_from_name(file_name: String) -> Option<String> {
    gguf::quant_from_name(&file_name)
}

#[napi]
pub fn core_info() -> CoreInfo {
    let core = turbollm_core::core_info();
    CoreInfo {
        version: core.version,
        git_sha: core.git_sha,
        target: NPM_TARGET.to_string(),
        napi_level: NAPI_LEVEL,
    }
}

pub struct ParseGguf {
    path: String,
    max_read: Option<f64>,
}

impl Task for ParseGguf {
    type Output = std::result::Result<gguf::GgufMeta, gguf::GgufError>;
    type JsValue = GgufMeta;

    fn compute(&mut self) -> Result<Self::Output> {
        without_panics(|| parse_header(&self.path, self.max_read))
    }

    fn resolve(&mut self, env: Env, parsed: Self::Output) -> Result<Self::JsValue> {
        parsed
            .map(GgufMeta::from)
            .map_err(|failure| rejection(&env, &failure))
    }
}

pub struct GgufCutShort {
    path: String,
    size: f64,
}

impl Task for GgufCutShort {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        without_panics(|| check_cut_short(&self.path, self.size))
    }

    fn resolve(&mut self, _env: Env, cut_short: Self::Output) -> Result<Self::JsValue> {
        Ok(cut_short)
    }
}

fn parse_header(
    path: &str,
    max_read: Option<f64>,
) -> Result<std::result::Result<gguf::GgufMeta, gguf::GgufError>> {
    let max_read = match max_read {
        Some(max_read) => whole_byte_count(max_read, "maxRead")?,
        None => gguf::MAX_HEADER_READ,
    };
    Ok(gguf::parse_file(path.as_ref(), max_read))
}

fn check_cut_short(path: &str, size: f64) -> Result<bool> {
    let size = whole_byte_count(size, "size")?;
    Ok(gguf::is_cut_short(path.as_ref(), size))
}

/// napi's `AsyncTask` does not catch a panic in `compute`; one unwinding into the libuv pool aborts the
/// daemon. Caught here, it rejects the promise instead.
fn without_panics<T>(job: impl FnOnce() -> Result<T>) -> Result<T> {
    panic::catch_unwind(AssertUnwindSafe(job)).unwrap_or_else(|payload| {
        let reason = format!(
            "the TurboLLM core panicked: {}",
            panic_text(payload.as_ref())
        );
        Err(Error::new(Status::GenericFailure, reason))
    })
}

fn panic_text(payload: &(dyn Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("no message")
}

impl From<gguf::GgufMeta> for GgufMeta {
    fn from(meta: gguf::GgufMeta) -> Self {
        GgufMeta {
            arch: meta.arch,
            name: meta.name,
            quant: meta.quant,
            size_label: meta.size_label,
            native_ctx: meta.native_ctx,
            block_count: meta.block_count,
            embed_len: meta.embed_len,
            head_count_kv: meta.head_count_kv,
            head_dim: meta.head_dim,
            expert_count: meta.expert_count,
            nextn_layers: meta.nextn_layers,
            has_chat_template: meta.has_chat_template,
            reasoning_effort: meta.reasoning_effort,
            sliding_window: meta.sliding_window,
            sliding_window_pattern: meta.sliding_window_pattern,
            head_dim_swa: meta.head_dim_swa,
            head_count_kv_per_layer: meta.head_count_kv_per_layer,
            full_attention_interval: meta.full_attention_interval,
            ssm_inner_size: meta.ssm_inner_size,
            ssm_state_size: meta.ssm_state_size,
            ssm_conv_kernel: meta.ssm_conv_kernel,
            // Exact below 2^53, the nearest double above (declared divergence D-2).
            data_end: meta.data_end as f64,
        }
    }
}

/// What a JavaScript caller sees of a GGUF failure: `err.code` and `err.message`.
#[derive(Debug, PartialEq, Eq)]
struct Rejection {
    code: &'static str,
    message: String,
}

impl From<&gguf::GgufError> for Rejection {
    fn from(failure: &gguf::GgufError) -> Self {
        Rejection {
            code: failure.code(),
            message: failure.to_string(),
        }
    }
}

/// A JS `Error` carrying the core's string code, built on the JavaScript thread so the promise rejects with
/// exactly this object (napi-rs hands a referenced error back verbatim).
fn rejection(env: &Env, failure: &gguf::GgufError) -> Error {
    let Rejection { code, message } = Rejection::from(failure);
    Error::from(JsError::from(Error::new(code, message)).into_unknown(*env))
}

/// A byte count from a JS number: a non-negative integer, else `InvalidArg`.
fn whole_byte_count(value: f64, argument: &str) -> Result<u64> {
    let is_whole = value.is_finite() && value >= 0.0 && value.fract() == 0.0;
    if !is_whole {
        let reason = format!("{argument} must be a non-negative integer, got {value}");
        return Err(Error::new(Status::InvalidArg, reason));
    }
    Ok(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_meta() -> gguf::GgufMeta {
        gguf::GgufMeta {
            arch: "gemma4".to_string(),
            name: "Gemma".to_string(),
            quant: "Q4_0".to_string(),
            size_label: "26B".to_string(),
            native_ctx: 262_144,
            block_count: 30,
            embed_len: 2816,
            head_count_kv: 8,
            head_dim: 256,
            expert_count: 128,
            nextn_layers: 1,
            has_chat_template: true,
            reasoning_effort: false,
            sliding_window: 1024,
            sliding_window_pattern: vec![true, false],
            head_dim_swa: 128,
            head_count_kv_per_layer: vec![8, 2],
            full_attention_interval: 4,
            ssm_inner_size: 4096,
            ssm_state_size: 128,
            ssm_conv_kernel: 4,
            data_end: 15_859_712,
        }
    }

    #[test]
    fn every_meta_field_reaches_javascript_unchanged() {
        let js = GgufMeta::from(core_meta());
        assert_eq!(
            (
                js.arch.as_str(),
                js.name.as_str(),
                js.quant.as_str(),
                js.size_label.as_str()
            ),
            ("gemma4", "Gemma", "Q4_0", "26B")
        );
        assert_eq!(
            [
                js.native_ctx,
                js.block_count,
                js.embed_len,
                js.head_count_kv,
                js.head_dim
            ],
            [262_144, 30, 2816, 8, 256]
        );
        assert_eq!([js.expert_count, js.nextn_layers], [128, 1]);
        assert_eq!([js.has_chat_template, js.reasoning_effort], [true, false]);
        assert_eq!([js.sliding_window, js.head_dim_swa], [1024, 128]);
        assert_eq!(js.sliding_window_pattern, vec![true, false]);
        assert_eq!(js.head_count_kv_per_layer, vec![8, 2]);
        assert_eq!(
            [
                js.full_attention_interval,
                js.ssm_inner_size,
                js.ssm_state_size,
                js.ssm_conv_kernel
            ],
            [4, 4096, 128, 4]
        );
        assert_eq!(js.data_end, 15_859_712.0);
    }

    #[test]
    fn u32_fields_keep_their_full_range() {
        let mut meta = core_meta();
        meta.native_ctx = u32::MAX;
        assert_eq!(GgufMeta::from(meta).native_ctx, u32::MAX);
    }

    #[test]
    fn data_end_above_2_pow_53_becomes_the_nearest_double() {
        let mut meta = core_meta();
        meta.data_end = 9_007_199_254_741_165;
        assert_eq!(GgufMeta::from(meta).data_end, 9_007_199_254_741_164.0);
    }

    fn assert_rejected(failure: gguf::GgufError, code: &'static str, message: &str) {
        let expected = Rejection {
            code,
            message: message.to_string(),
        };
        assert_eq!(Rejection::from(&failure), expected);
    }

    #[test]
    fn every_gguf_failure_rejects_with_its_core_code_and_message() {
        assert_rejected(gguf::GgufError::NotGguf, "not_gguf", "Not a GGUF file.");
        assert_rejected(
            gguf::GgufError::BadVersion(7),
            "bad_version",
            "Unsupported GGUF version 7.",
        );
        assert_rejected(
            gguf::GgufError::Truncated,
            "truncated",
            "Unexpected EOF in GGUF header.",
        );
        assert_rejected(
            gguf::GgufError::BadType(13),
            "bad_type",
            "Unknown GGUF value type 13.",
        );
        assert_rejected(
            gguf::GgufError::TooLarge,
            "too_large",
            "GGUF header is too large to read.",
        );
    }

    #[test]
    fn an_io_failure_rejects_with_code_io_and_the_os_message() {
        let failure = gguf::GgufError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such file",
        ));
        assert_rejected(failure, "io", "no such file");
    }

    #[test]
    fn whole_byte_counts_pass_through() {
        assert_eq!(whole_byte_count(0.0, "maxRead").unwrap(), 0);
        assert_eq!(whole_byte_count(1_048_576.0, "maxRead").unwrap(), 1_048_576);
    }

    #[test]
    fn a_negative_nan_fractional_or_infinite_byte_count_is_an_invalid_argument() {
        for invalid in [-1.0, f64::NAN, 1.5, f64::INFINITY, -0.5] {
            let failure = whole_byte_count(invalid, "maxRead").unwrap_err();
            assert_eq!(failure.status, Status::InvalidArg, "{invalid}");
            assert!(failure.reason.contains("maxRead"), "{}", failure.reason);
        }
    }

    #[test]
    fn core_info_reports_napi_level_8_and_the_workspace_version() {
        let info = core_info();
        assert_eq!(info.napi_level, 8);
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn core_info_target_is_the_npm_target_or_unknown_when_unset() {
        let expected = option_env!("TURBOLLM_NPM_TARGET").unwrap_or("unknown");
        assert_eq!(core_info().target, expected);
    }

    #[test]
    fn a_panicking_job_rejects_with_a_generic_failure() {
        let failure = without_panics(|| -> Result<()> { panic!("a core bug") }).unwrap_err();
        assert_eq!(failure.status, Status::GenericFailure);
        assert!(failure.reason.contains("a core bug"), "{}", failure.reason);
    }

    #[test]
    fn a_job_that_returns_passes_its_result_through() {
        assert_eq!(without_panics(|| Ok(7)).unwrap(), 7);
        let refused = without_panics(|| whole_byte_count(-1.0, "size")).unwrap_err();
        assert_eq!(refused.status, Status::InvalidArg);
    }
}
