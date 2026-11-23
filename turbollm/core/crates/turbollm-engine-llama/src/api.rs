//! The session library's C function table (`native/include/tl_llama.h`, architecture 3.1), resolved
//! once per backend instance from the variant library that opened. `LlamaCalls` is the table as the
//! reply loop sees it, so tests can stand in a fake.

use std::ffi::{CStr, c_char, c_void};
use std::ptr::NonNull;

use libloading::Library;
use turbollm_engine::EngineError;

/// `TL_LLAMA_ABI`: the only header version this core speaks.
pub const ABI_VERSION: u32 = 1;

/// The `TL_*` outcomes of the table's calls (`session_error.h:9-14`).
pub const TL_OK: i32 = 0;
pub const TL_FAILED: i32 = -1;
pub const TL_CONTEXT_LENGTH_EXCEEDED: i32 = -2;
pub const TL_TEMPLATE_UNSUPPORTED: i32 = -3;
pub const TL_ABORTED: i32 = -4;

/// `tl_progress_fn`: false aborts the load.
pub type ProgressFn = unsafe extern "C" fn(progress: f32, data: *mut c_void) -> bool;
/// `tl_abort_fn`: polled by llama.cpp; true stops the running decode.
pub type AbortFn = unsafe extern "C" fn(data: *mut c_void) -> bool;

/// `tl_model_info`.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelInfo {
    pub n_ctx: i32,
    pub n_ctx_train: i32,
}

/// `tl_stats` of the current reply.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub prompt_n: i32,
    pub prompt_decoded: i32,
    pub prompt_ms: f64,
    pub predicted_n: i32,
    pub predicted_ms: f64,
    pub context_full: bool,
}

/// A live `tl_session`. Only `LlamaCalls::load` makes one and only `LlamaCalls::free` ends one.
#[derive(Debug)]
pub struct Session(NonNull<c_void>);

// SAFETY: a `tl_session` has no thread affinity; the library needs only that no two calls on it run
// at once, which `&mut Session` and ownership enforce. `Session` is deliberately not `Sync`.
unsafe impl Send for Session {}

impl Session {
    /// # Safety
    /// `session` must be what the same table's `load` returned, not yet freed.
    pub unsafe fn from_raw(session: NonNull<c_void>) -> Session {
        Session(session)
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.0.as_ptr()
    }
}

/// What `tl_llama_load` takes. The callbacks' data pointers belong to the caller.
#[derive(Debug, Clone, Copy)]
pub struct LoadRequest<'a> {
    pub path: &'a CStr,
    pub n_ctx: i32,
    pub n_threads: i32,
    pub progress: Option<ProgressFn>,
    pub progress_data: *mut c_void,
    pub abort: Option<AbortFn>,
    pub abort_data: *mut c_void,
}

/// The sampler settings `tl_llama_start_sampling` takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sampling {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: i32,
    pub seed: i64,
}

/// `tl_llama_next_token`: status 1 with the token's bytes, 0 at the end of the reply, else `TL_*`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub status: i32,
    pub piece: Vec<u8>,
}

/// `tl_llama_parse_delta`: what the reply added since the previous parse, or a `TL_*` status.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Delta {
    pub status: i32,
    pub content: String,
    pub reasoning: String,
}

/// The session library's calls as the engine makes them, all on the engine thread.
pub trait LlamaCalls {
    fn backend_init(&self);
    /// `Err` holds the library's message.
    ///
    /// # Safety
    /// The progress data must stay valid until `load` returns, the abort data until the session is
    /// freed, and each callback must accept its data pointer.
    unsafe fn load(&self, request: &LoadRequest<'_>) -> Result<Session, String>;
    fn model_info(&self, session: &Session) -> ModelInfo;
    fn prepare(&self, session: &mut Session, request_json: &str) -> i32;
    fn start_sampling(&self, session: &mut Session, sampling: &Sampling) -> i32;
    fn next_token(&self, session: &mut Session) -> Token;
    fn parse_delta(&self, session: &mut Session, is_partial: bool) -> Delta;
    fn stats(&self, session: &Session) -> Stats;
    fn last_error(&self, session: &Session) -> String;
    fn free(&self, session: Session);
}

/// The table resolved from one opened variant library, which it keeps open as long as it lives.
pub struct LlamaApi {
    table: Table,
    _library: Library,
}

impl LlamaApi {
    /// Resolves every function the header declares; a library of another ABI version, or one that
    /// lacks a function, is `EngineUnavailable`.
    pub fn resolve(library: Library) -> Result<LlamaApi, EngineError> {
        // SAFETY: each type below is the header's signature for the symbol it is read with, and
        // the pointers are used only while `_library` keeps the library loaded.
        unsafe {
            let abi_version: AbiVersionFn = function(&library, "tl_llama_abi_version")?;
            require_abi(abi_version())?;
            let table = Table {
                backend_init: function(&library, "tl_llama_backend_init")?,
                load: function(&library, "tl_llama_load")?,
                model_info: function(&library, "tl_llama_model_info")?,
                prepare: function(&library, "tl_llama_prepare")?,
                start_sampling: function(&library, "tl_llama_start_sampling")?,
                next_token: function(&library, "tl_llama_next_token")?,
                parse_delta: function(&library, "tl_llama_parse_delta")?,
                stats: function(&library, "tl_llama_stats")?,
                last_error: function(&library, "tl_llama_last_error")?,
                free: function(&library, "tl_llama_free")?,
            };
            Ok(LlamaApi {
                table,
                _library: library,
            })
        }
    }
}

/// Bytes a failed `tl_llama_load` may write its message into, NUL included.
const LOAD_ERROR_CAPACITY: usize = 1024;

// SAFETY (every call below): the table holds the header's functions of a library still loaded, and
// a `Session` is always a live session of this table. Borrowed `tl_str`s are copied before the next
// call on the session.
impl LlamaCalls for LlamaApi {
    fn backend_init(&self) {
        unsafe { (self.table.backend_init)() }
    }

    unsafe fn load(&self, request: &LoadRequest<'_>) -> Result<Session, String> {
        let mut error = [0 as c_char; LOAD_ERROR_CAPACITY];
        let session = unsafe {
            (self.table.load)(
                request.path.as_ptr(),
                request.n_ctx,
                request.n_threads,
                request.progress,
                request.progress_data,
                request.abort,
                request.abort_data,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        match NonNull::new(session) {
            Some(session) => Ok(Session(session)),
            None => Err(unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned()),
        }
    }

    fn model_info(&self, session: &Session) -> ModelInfo {
        let mut info = ModelInfo::default();
        unsafe { (self.table.model_info)(session.as_ptr(), &mut info) };
        info
    }

    fn prepare(&self, session: &mut Session, request_json: &str) -> i32 {
        let json = request_json.as_ptr().cast::<c_char>();
        unsafe { (self.table.prepare)(session.as_ptr(), json, request_json.len()) }
    }

    fn start_sampling(&self, session: &mut Session, sampling: &Sampling) -> i32 {
        unsafe {
            (self.table.start_sampling)(
                session.as_ptr(),
                sampling.temperature,
                sampling.top_p,
                sampling.top_k,
                sampling.seed,
            )
        }
    }

    fn next_token(&self, session: &mut Session) -> Token {
        let mut piece = TlStr::EMPTY;
        let status = unsafe { (self.table.next_token)(session.as_ptr(), &mut piece) };
        Token {
            status,
            piece: unsafe { piece.bytes() }.to_vec(),
        }
    }

    fn parse_delta(&self, session: &mut Session, is_partial: bool) -> Delta {
        let (mut content, mut reasoning) = (TlStr::EMPTY, TlStr::EMPTY);
        let status = unsafe {
            (self.table.parse_delta)(session.as_ptr(), is_partial, &mut content, &mut reasoning)
        };
        Delta {
            status,
            content: unsafe { content.text() },
            reasoning: unsafe { reasoning.text() },
        }
    }

    fn stats(&self, session: &Session) -> Stats {
        let mut stats = Stats::default();
        unsafe { (self.table.stats)(session.as_ptr(), &mut stats) };
        stats
    }

    fn last_error(&self, session: &Session) -> String {
        unsafe { (self.table.last_error)(session.as_ptr()).text() }
    }

    fn free(&self, session: Session) {
        unsafe { (self.table.free)(session.as_ptr()) }
    }
}

fn require_abi(version: u32) -> Result<(), EngineError> {
    if version == ABI_VERSION {
        return Ok(());
    }
    Err(crate::llama_unavailable(format!(
        "The llama.cpp library speaks C ABI {version}; this core needs {ABI_VERSION}."
    )))
}

/// # Safety
/// `F` must be the header's signature for `name`, and the pointer is used only while `library` lives.
unsafe fn function<F: Copy>(library: &Library, name: &str) -> Result<F, EngineError> {
    let symbol = unsafe { library.get::<F>(name.as_bytes()) }.map_err(|error| {
        crate::llama_unavailable(format!("The llama.cpp library has no {name}: {error}"))
    })?;
    Ok(*symbol)
}

/// `tl_str`: borrowed from the session until its next call.
#[repr(C)]
struct TlStr {
    ptr: *const c_char,
    len: usize,
}

impl TlStr {
    const EMPTY: TlStr = TlStr {
        ptr: std::ptr::null(),
        len: 0,
    };

    /// # Safety
    /// The session that filled it has had no call since.
    unsafe fn bytes(&self) -> &[u8] {
        if self.ptr.is_null() {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(self.ptr.cast::<u8>(), self.len) }
    }

    /// # Safety
    /// As `bytes`.
    unsafe fn text(&self) -> String {
        String::from_utf8_lossy(unsafe { self.bytes() }).into_owned()
    }
}

type RawSession = *mut c_void;
type AbiVersionFn = unsafe extern "C" fn() -> u32;

struct Table {
    backend_init: unsafe extern "C" fn(),
    load: unsafe extern "C" fn(
        *const c_char,
        i32,
        i32,
        Option<ProgressFn>,
        *mut c_void,
        Option<AbortFn>,
        *mut c_void,
        *mut c_char,
        usize,
    ) -> RawSession,
    model_info: unsafe extern "C" fn(RawSession, *mut ModelInfo),
    prepare: unsafe extern "C" fn(RawSession, *const c_char, usize) -> i32,
    start_sampling: unsafe extern "C" fn(RawSession, f32, f32, i32, i64) -> i32,
    next_token: unsafe extern "C" fn(RawSession, *mut TlStr) -> i32,
    parse_delta: unsafe extern "C" fn(RawSession, bool, *mut TlStr, *mut TlStr) -> i32,
    stats: unsafe extern "C" fn(RawSession, *mut Stats),
    last_error: unsafe extern "C" fn(RawSession) -> TlStr,
    free: unsafe extern "C" fn(RawSession),
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::path::{Path, PathBuf};
    use std::ptr;

    use turbollm_engine::{EngineId, EngineKind};
    use turbollm_platform::library_file_name;

    use super::*;
    use crate::variant::{Variant, load_best};

    #[test]
    fn abi_version_one_is_spoken() {
        assert_eq!(require_abi(ABI_VERSION), Ok(()));
    }

    #[test]
    fn a_library_of_another_abi_version_is_unavailable() {
        assert_eq!(
            require_abi(2),
            Err(unavailable(
                "The llama.cpp library speaks C ABI 2; this core needs 1."
            ))
        );
    }

    #[test]
    fn a_library_without_the_session_functions_is_unavailable_and_names_the_first_missing() {
        let error = LlamaApi::resolve(this_program()).err().expect("must fail");

        let EngineError::EngineUnavailable { kind, reason, .. } = error else {
            panic!("expected EngineUnavailable, got {error:?}");
        };
        assert_eq!(kind, EngineKind::LlamaCpp);
        assert!(
            reason.starts_with("The llama.cpp library has no tl_llama_abi_version: "),
            "{reason}"
        );
    }

    /// Needs the host build (`cargo xtask build-llama --host`) named by `TURBOLLM_LLAMA_LIB_DIR`.
    #[test]
    fn the_host_library_resolves_and_reports_a_failed_load_with_its_message() {
        let Some(dir) = host_library_dir() else {
            return;
        };
        let chosen = load_best(Some(&dir)).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(chosen.variant, Variant::Base);
        assert_eq!(
            chosen.file,
            dir.join(library_file_name(Variant::Base.library_stem()))
        );
        let api = LlamaApi::resolve(chosen.library).unwrap_or_else(|e| panic!("{e}"));
        let missing = CString::new("no such model.gguf").unwrap();

        api.backend_init();
        // SAFETY: no callbacks, so no data pointers to keep alive.
        let outcome = unsafe { api.load(&load_request(&missing)) };

        let message = outcome.expect_err("a missing model must not load");
        assert!(!message.is_empty());
    }

    fn load_request(path: &CStr) -> LoadRequest<'_> {
        LoadRequest {
            path,
            n_ctx: 512,
            n_threads: 1,
            progress: None,
            progress_data: ptr::null_mut(),
            abort: None,
            abort_data: ptr::null_mut(),
        }
    }

    fn unavailable(reason: &str) -> EngineError {
        EngineError::EngineUnavailable {
            engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
            kind: EngineKind::LlamaCpp,
            reason: reason.to_owned(),
        }
    }

    #[cfg(unix)]
    fn this_program() -> Library {
        libloading::os::unix::Library::this().into()
    }

    #[cfg(windows)]
    fn this_program() -> Library {
        libloading::os::windows::Library::this()
            .expect("the test program is loaded")
            .into()
    }

    /// The T14 env rule: without the variable the test skips, except on CI, where it fails.
    fn host_library_dir() -> Option<PathBuf> {
        let Some(dir) = std::env::var_os("TURBOLLM_LLAMA_LIB_DIR").filter(|dir| !dir.is_empty())
        else {
            assert!(
                std::env::var("CI").as_deref() != Ok("true"),
                "TURBOLLM_LLAMA_LIB_DIR must be set on CI"
            );
            println!("skipped: TURBOLLM_LLAMA_LIB_DIR is not set");
            return None;
        };
        Some(from_workspace_root(Path::new(&dir)))
    }

    /// Cargo runs tests from the crate folder; a relative path is meant from `core/`.
    fn from_workspace_root(path: &Path) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(path)
    }
}
