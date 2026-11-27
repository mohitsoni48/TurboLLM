//! Where the core's engines write what a device log should keep. On Android that is logcat, under
//! the tag `TurboLLM`, so a shipped build shows which llama.cpp library it loaded (QA E-38, Z-2,
//! Z-4); desktop hosts list no llama row and keep no log.

#[cfg(any(target_os = "android", test))]
use std::ffi::CString;
use std::sync::Arc;

/// A line sink; the llama and LiteRT backends each name this same shape, so neither crate owns it here.
pub(crate) type PlatformLog = Arc<dyn Fn(&str) + Send + Sync>;

/// The log the llama and LiteRT backends write to on this platform (their log types are the same shape).
#[cfg(target_os = "android")]
pub(crate) fn platform_log() -> PlatformLog {
    Arc::new(logcat::write)
}

/// The log the llama and LiteRT backends write to on this platform (their log types are the same shape).
#[cfg(not(target_os = "android"))]
pub(crate) fn platform_log() -> PlatformLog {
    Arc::new(|_| {})
}

/// The line as logcat takes it: a C string, so a NUL inside the line must not drop it.
#[cfg(any(target_os = "android", test))]
fn logcat_text(line: &str) -> CString {
    CString::new(line.replace('\0', "\u{FFFD}")).expect("no NUL is left in the line")
}

/// liblog, which every Android process has; no crate and no binding surface is added for it.
#[cfg(target_os = "android")]
mod logcat {
    use std::ffi::{CStr, c_char, c_int};

    const TAG: &CStr = c"TurboLLM";
    const ANDROID_LOG_INFO: c_int = 4;

    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    pub(super) fn write(line: &str) {
        let text = super::logcat_text(line);
        // SAFETY: both pointers are NUL-terminated strings that outlive the call.
        unsafe { __android_log_write(ANDROID_LOG_INFO, TAG.as_ptr(), text.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_reaches_logcat_unchanged() {
        let line = "llama.cpp loaded /data/app/lib/arm64/libturbollm_core_llama_dotprod.so";

        assert_eq!(logcat_text(line).to_str(), Ok(line));
    }

    #[test]
    fn a_nul_inside_a_line_is_replaced_and_the_rest_is_kept() {
        assert_eq!(
            logcat_text("before\0after").to_str(),
            Ok("before\u{FFFD}after")
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn a_desktop_core_accepts_a_line_and_writes_it_nowhere() {
        platform_log()("llama.cpp loaded turbollm_core_llama_base.dll");
    }
}
