//! The llama session library's C ABI (architecture 3.1), reached through dlopen as the engine reaches it.
//! Needs a host build (`cargo xtask build-llama --host`): `TURBOLLM_LLAMA_LIB_DIR` names its folder and
//! `TURBOLLM_TEST_GGUF` a small model. Without them the tests skip, except on CI, where they fail.

#[path = "support/native_host.rs"]
mod native_host;

use std::ffi::{CStr, CString, c_char, c_void};
use std::ptr;

use libloading::Library;
use turbollm_platform::library_file_name;

use native_host::{NativeTestEnv, take_turn};

const LIBRARY_STEM: &str = "turbollm_core_llama_base";
const TEST_CONTEXT: i32 = 512;
const TEST_THREADS: i32 = 2;
const ERROR_CAPACITY: usize = 512;

type TlSession = c_void;
type ProgressFn = extern "C" fn(f32, *mut c_void) -> bool;
type AbortFn = extern "C" fn(*mut c_void) -> bool;
type AbiVersionFn = unsafe extern "C" fn() -> u32;
type BackendInitFn = unsafe extern "C" fn();
type LiveSessionsFn = unsafe extern "C" fn() -> i32;
type FreeFn = unsafe extern "C" fn(*mut TlSession);
type LoadFn = unsafe extern "C" fn(
    *const c_char,
    i32,
    i32,
    Option<ProgressFn>,
    *mut c_void,
    Option<AbortFn>,
    *mut c_void,
    *mut c_char,
    usize,
) -> *mut TlSession;

#[test]
fn the_library_speaks_abi_version_one() {
    let Some(llama) = Llama::open() else { return };

    assert_eq!(llama.abi_version(), 1);
}

#[test]
fn a_loaded_session_counts_as_live_until_it_is_freed() {
    let Some(llama) = Llama::open() else { return };
    let _turn = take_turn();

    let session = llama
        .load(None)
        .unwrap_or_else(|error| panic!("load failed: {error}"));
    assert_eq!(llama.live_sessions(), 1);

    llama.free(session);
    assert_eq!(llama.live_sessions(), 0);
}

#[test]
fn a_progress_callback_that_returns_false_fails_the_load_with_a_message() {
    let Some(llama) = Llama::open() else { return };
    let _turn = take_turn();

    let error = llama
        .load(Some(refuse_progress))
        .expect_err("a load whose progress callback said stop must fail");

    assert!(!error.is_empty(), "the failed load left no message");
    assert_eq!(llama.live_sessions(), 0);
}

extern "C" fn refuse_progress(_progress: f32, _data: *mut c_void) -> bool {
    false
}

struct Llama {
    library: Library,
    model: CString,
}

impl Llama {
    fn open() -> Option<Llama> {
        let NativeTestEnv { library_dir, model } = NativeTestEnv::read()?;
        let library_path = library_dir.join(library_file_name(LIBRARY_STEM));
        // SAFETY: the library is ours; its initialisers only set up llama.cpp's static state.
        let library = unsafe { Library::new(&library_path) }
            .unwrap_or_else(|e| panic!("{}: {e}", library_path.display()));
        let model =
            CString::new(model.to_string_lossy().into_owned()).expect("model path holds a NUL");
        Some(Llama { library, model })
    }

    fn abi_version(&self) -> u32 {
        // SAFETY: the signature is the header's `uint32_t tl_llama_abi_version(void)`.
        unsafe { self.function::<AbiVersionFn>("tl_llama_abi_version")() }
    }

    fn live_sessions(&self) -> i32 {
        // SAFETY: the signature is the header's `int32_t tl_llama_live_sessions(void)`.
        unsafe { self.function::<LiveSessionsFn>("tl_llama_live_sessions")() }
    }

    fn load(&self, progress: Option<ProgressFn>) -> Result<*mut TlSession, String> {
        let mut error = [0 as c_char; ERROR_CAPACITY];
        // SAFETY: signatures as in the header; the model path and the error buffer outlive the calls.
        let session = unsafe {
            self.function::<BackendInitFn>("tl_llama_backend_init")();
            self.function::<LoadFn>("tl_llama_load")(
                self.model.as_ptr(),
                TEST_CONTEXT,
                TEST_THREADS,
                progress,
                ptr::null_mut(),
                None,
                ptr::null_mut(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if session.is_null() {
            // SAFETY: the library writes a NUL-terminated message that fits the buffer.
            let message = unsafe { CStr::from_ptr(error.as_ptr()) };
            return Err(message.to_string_lossy().into_owned());
        }
        Ok(session)
    }

    fn free(&self, session: *mut TlSession) {
        // SAFETY: `session` came from `tl_llama_load` and is freed once.
        unsafe { self.function::<FreeFn>("tl_llama_free")(session) }
    }

    /// # Safety
    /// `F` must be the C signature the header declares for `name`.
    unsafe fn function<F: Copy>(&self, name: &str) -> F {
        // SAFETY: the caller vouches for the signature.
        let symbol = unsafe { self.library.get::<F>(name.as_bytes()) };
        *symbol.unwrap_or_else(|e| panic!("{name}: {e}"))
    }
}
