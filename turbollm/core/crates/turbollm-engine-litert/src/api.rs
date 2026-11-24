//! The LiteRT-LM C functions this core calls (architecture 3.2), resolved by hand from the library
//! `cargo xtask fetch-litert` stages as `libturbollm_core_litertlm.so`, and `LiteRtCalls`, the
//! calls as a model makes them, so tests can stand in a fake.
//!
//! The function types are written from the 0.19.0 headers in `vendor/litert_lm/c` (no bindgen):
//! every call but the stream callback and the error reporter returns a `LiteRtLmStatusCode` and
//! hands a created object back through an out pointer.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;
use std::ptr::{self, NonNull};

use libloading::Library;
use turbollm_engine::{EngineError, EngineId, EngineKind};

use crate::prompt::LiteRtPrompt;

type Raw = *mut c_void;
type Status = i32;

/// `kLiteRtLmStatusOk`.
const STATUS_OK: Status = 0;
/// `kLiteRtLmSamplerTypeTopP`: top-k, then top-p, as the Kotlin and the server both ask.
const SAMPLER_TOP_P: c_int = 2;

/// `LiteRtLmStreamCallback`: the chunk is borrowed for the call.
type StreamCallback = unsafe extern "C" fn(data: *mut c_void, chunk: *const c_void);

macro_rules! table {
    ($($name:ident: $ty:ty,)*) => {
        /// Every function of the table, by its exported name.
        pub const SYMBOLS: &[&str] = &[$(concat!("litert_lm_", stringify!($name))),*];

        struct Table {
            $($name: $ty,)*
        }

        impl Table {
            /// # Safety
            /// Each field's type must be the header's signature for its symbol.
            unsafe fn resolve(library: &Library) -> Result<Table, EngineError> {
                Ok(Table {
                    $($name: unsafe {
                        function::<$ty>(library, concat!("litert_lm_", stringify!($name)))?
                    },)*
                })
            }
        }
    };
}

table! {
    engine_settings_create: unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, *const c_char, *mut Raw) -> Status,
    engine_settings_set_max_num_tokens: unsafe extern "C" fn(Raw, c_int) -> Status,
    engine_settings_set_num_threads: unsafe extern "C" fn(Raw, c_int) -> Status,
    engine_settings_set_cache_dir: unsafe extern "C" fn(Raw, *const c_char) -> Status,
    engine_settings_enable_benchmark: unsafe extern "C" fn(Raw) -> Status,
    engine_settings_delete: unsafe extern "C" fn(Raw),
    engine_create: unsafe extern "C" fn(Raw, *mut Raw) -> Status,
    engine_delete: unsafe extern "C" fn(Raw),
    sampler_params_create: unsafe extern "C" fn(c_int, *mut Raw) -> Status,
    sampler_params_set_top_k: unsafe extern "C" fn(Raw, i32) -> Status,
    sampler_params_set_top_p: unsafe extern "C" fn(Raw, f32) -> Status,
    sampler_params_set_temperature: unsafe extern "C" fn(Raw, f32) -> Status,
    sampler_params_set_seed: unsafe extern "C" fn(Raw, i32) -> Status,
    sampler_params_delete: unsafe extern "C" fn(Raw),
    session_config_create: unsafe extern "C" fn(*mut Raw) -> Status,
    session_config_set_sampler_params: unsafe extern "C" fn(Raw, Raw) -> Status,
    session_config_delete: unsafe extern "C" fn(Raw),
    conversation_config_create: unsafe extern "C" fn(*mut Raw) -> Status,
    conversation_config_set_session_config: unsafe extern "C" fn(Raw, Raw) -> Status,
    conversation_config_set_messages: unsafe extern "C" fn(Raw, *const c_char) -> Status,
    conversation_config_set_thinking_config: unsafe extern "C" fn(Raw, Raw) -> Status,
    conversation_config_delete: unsafe extern "C" fn(Raw),
    thinking_config_create: unsafe extern "C" fn(*mut Raw) -> Status,
    thinking_config_set_enable_thinking: unsafe extern "C" fn(Raw, bool) -> Status,
    thinking_config_delete: unsafe extern "C" fn(Raw),
    conversation_optional_args_create: unsafe extern "C" fn(*mut Raw) -> Status,
    conversation_optional_args_set_max_output_tokens: unsafe extern "C" fn(Raw, c_int) -> Status,
    conversation_optional_args_delete: unsafe extern "C" fn(Raw),
    conversation_create: unsafe extern "C" fn(Raw, Raw, *mut Raw) -> Status,
    conversation_send_message_stream: unsafe extern "C" fn(Raw, *const c_char, *const c_char, Raw, Option<StreamCallback>, *mut c_void) -> Status,
    conversation_cancel_process: unsafe extern "C" fn(Raw) -> Status,
    conversation_get_benchmark_info: unsafe extern "C" fn(Raw, *mut Raw) -> Status,
    conversation_delete: unsafe extern "C" fn(Raw),
    stream_chunk_get_text: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    stream_chunk_get_error: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    stream_chunk_is_final: unsafe extern "C" fn(*const c_void, *mut bool) -> Status,
    benchmark_info_get_num_prefill_turns: unsafe extern "C" fn(*const c_void, *mut usize) -> Status,
    benchmark_info_get_prefill_token_count_at: unsafe extern "C" fn(*const c_void, usize, *mut usize) -> Status,
    benchmark_info_get_num_decode_turns: unsafe extern "C" fn(*const c_void, *mut usize) -> Status,
    benchmark_info_get_decode_token_count_at: unsafe extern "C" fn(*const c_void, usize, *mut usize) -> Status,
    benchmark_info_get_decode_tokens_per_sec_at: unsafe extern "C" fn(*const c_void, usize, *mut f64) -> Status,
    benchmark_info_get_prefill_tokens_per_sec_at: unsafe extern "C" fn(*const c_void, usize, *mut f64) -> Status,
    benchmark_info_delete: unsafe extern "C" fn(Raw),
    get_last_error_message: unsafe extern "C" fn() -> *const c_char,
    clear_last_error: unsafe extern "C" fn(),
    set_min_log_level: unsafe extern "C" fn(c_int) -> Status,
}

/// What one streamed chunk carried, read inside the stream callback.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawChunk {
    /// The chunk's text: the message JSON `chunk::parse_chunk` reads.
    pub payload: String,
    /// The error the stream ended with, if it did.
    pub error: Option<String>,
    pub is_final: bool,
}

/// Where a reply's chunks go. It runs on a LiteRT thread, so it must return quickly, must not call
/// LiteRT, and must not panic (a panic in a C callback aborts the process).
pub type ChunkSink = Box<dyn FnMut(RawChunk) + Send>;

/// `LiteRtLmLogSeverity`, the values worth setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogSeverity {
    Error = 4,
    Silent = 1000,
}

/// The engine settings a load asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineSettings {
    pub model_path: String,
    /// `"cpu"` or `"gpu"`.
    pub backend: String,
    pub max_num_tokens: i32,
    pub num_threads: Option<i32>,
    pub cache_dir: Option<String>,
    pub enable_benchmark: bool,
}

/// One prefill or decode turn of a reply's benchmark.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BenchmarkTurn {
    pub tokens: usize,
    pub tokens_per_sec: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Benchmark {
    pub prefill: Vec<BenchmarkTurn>,
    pub decode: Vec<BenchmarkTurn>,
}

/// A live `LiteRtLmEngine`. Only `LiteRtCalls::create_engine` makes one and only `delete_engine`
/// ends one, after every conversation made from it.
#[derive(Debug)]
pub struct EngineHandle(NonNull<c_void>);

// SAFETY: LiteRT handles have no thread affinity; they need only that no two calls on one handle
// overlap, which `&`/ownership of the handle and the engine thread enforce. Deliberately not `Sync`.
unsafe impl Send for EngineHandle {}

impl EngineHandle {
    /// # Safety
    /// `engine` must be what the same table's `create_engine` returned, not yet deleted; a fake
    /// table may use any value it never hands to the real one.
    pub unsafe fn from_raw(engine: NonNull<c_void>) -> EngineHandle {
        EngineHandle(engine)
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.0.as_ptr()
    }
}

/// A live `LiteRtLmConversation` and whatever its stream callback points at, which must outlive
/// the stream: the handle owns it and drops it after the conversation is deleted.
pub struct ConversationHandle {
    raw: NonNull<c_void>,
    _stream: Box<dyn Send>,
}

impl std::fmt::Debug for ConversationHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("ConversationHandle")
            .field(&self.raw)
            .finish()
    }
}

// SAFETY: as `EngineHandle`; the stream state is `Send` by construction.
unsafe impl Send for ConversationHandle {}

impl ConversationHandle {
    /// # Safety
    /// `conversation` must be what the same table's `start_reply` made, not yet deleted; `stream`
    /// must be what its callback was given (anything, for a fake).
    pub unsafe fn from_raw(
        conversation: NonNull<c_void>,
        stream: Box<dyn Send>,
    ) -> ConversationHandle {
        ConversationHandle {
            raw: conversation,
            _stream: stream,
        }
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.raw.as_ptr()
    }
}

/// LiteRT-LM as the engine thread calls it. `Err` holds the library's message.
pub trait LiteRtCalls {
    fn set_min_log_level(&self, level: LogSeverity) -> Result<(), String>;
    /// `Err` is `EngineUnavailable` when this device cannot run LiteRT-LM at all, which the caller
    /// must not retry on another backend; any other failure is an `EngineFailure`.
    fn create_engine(&self, settings: &EngineSettings) -> Result<EngineHandle, EngineError>;
    fn delete_engine(&self, engine: EngineHandle);
    /// A fresh conversation seeded with the prompt's context, then the user turn sent; the reply
    /// arrives through `sink`, whose last chunk is final or carries an error.
    fn start_reply(
        &self,
        engine: &EngineHandle,
        prompt: &LiteRtPrompt,
        sink: ChunkSink,
    ) -> Result<ConversationHandle, String>;
    /// Stops the reply; the conversation may only be deleted afterwards.
    fn cancel_reply(&self, conversation: &ConversationHandle) -> Result<(), String>;
    fn benchmark(&self, conversation: &ConversationHandle) -> Result<Benchmark, String>;
    fn delete_conversation(&self, conversation: ConversationHandle);
}

/// The table resolved from one opened library, which it keeps open as long as it lives.
pub struct LiteRtApi {
    table: Table,
    _library: Library,
}

impl LiteRtApi {
    /// Opens the library with `RTLD_NOW | RTLD_LOCAL`, because it carries and exports its own C++
    /// runtime, and resolves every function. A missing library or function is `EngineUnavailable`.
    pub fn open(path: &Path) -> Result<LiteRtApi, EngineError> {
        // SAFETY: opening runs the library's initialisers, which is what staging it is for.
        let library = unsafe { open_library(path) }.map_err(|error| unavailable(&error))?;
        LiteRtApi::resolve(library)
    }

    pub fn resolve(library: Library) -> Result<LiteRtApi, EngineError> {
        // SAFETY: `Table`'s types are the 0.19.0 headers' signatures; the pointers are used only
        // while `_library` keeps the library loaded.
        let table = unsafe { Table::resolve(&library) }?;
        Ok(LiteRtApi {
            table,
            _library: library,
        })
    }
}

#[cfg(unix)]
unsafe fn open_library(path: &Path) -> Result<Library, libloading::Error> {
    use libloading::os::unix::{Library as UnixLibrary, RTLD_LOCAL, RTLD_NOW};
    unsafe { UnixLibrary::open(Some(path), RTLD_NOW | RTLD_LOCAL) }.map(Library::from)
}

#[cfg(not(unix))]
unsafe fn open_library(path: &Path) -> Result<Library, libloading::Error> {
    unsafe { Library::new(path) }
}

fn unavailable(error: &dyn std::fmt::Display) -> EngineError {
    EngineError::EngineUnavailable {
        engine: EngineId::new(EngineId::LITERT_LM),
        kind: EngineKind::LitertLm,
        reason: format!("LiteRT-LM cannot run on this device: {error}"),
    }
}

/// # Safety
/// `F` must be the header's signature for `name`, and the pointer is used only while `library` lives.
unsafe fn function<F: Copy>(library: &Library, name: &str) -> Result<F, EngineError> {
    let symbol = unsafe { library.get::<F>(name.as_bytes()) }
        .map_err(|error| unavailable(&format!("{name}: {error}")))?;
    Ok(*symbol)
}

/// An object LiteRT made that this call must delete: settings, sampler, configs, optional args.
struct Owned {
    raw: Raw,
    delete: unsafe extern "C" fn(Raw),
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: `raw` is a live object of the kind `delete` deletes, deleted once.
        unsafe { (self.delete)(self.raw) }
    }
}

/// What the stream callback needs: the sink, and the chunk readers (the callback has no table).
struct StreamState {
    sink: ChunkSink,
    get_text: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    get_error: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    is_final: unsafe extern "C" fn(*const c_void, *mut bool) -> Status,
}

/// # Safety
/// `data` is the `StreamState` its conversation owns, and `chunk` a live chunk for this call.
unsafe extern "C" fn stream_trampoline(data: *mut c_void, chunk: *const c_void) {
    let state = unsafe { &mut *data.cast::<StreamState>() };
    let mut is_final = false;
    unsafe { (state.is_final)(chunk, &mut is_final) };
    let raw = RawChunk {
        payload: unsafe { read_string(state.get_text, chunk) }.unwrap_or_default(),
        error: unsafe { read_string(state.get_error, chunk) },
        is_final,
    };
    (state.sink)(raw);
}

/// # Safety
/// `getter` is a chunk string getter and `chunk` a live chunk.
unsafe fn read_string(
    getter: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    chunk: *const c_void,
) -> Option<String> {
    let mut text: *const c_char = ptr::null();
    let status = unsafe { getter(chunk, &mut text) };
    if status != STATUS_OK || text.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned(),
    )
}

impl LiteRtApi {
    /// The library's message for the failure that `status` reports, read on this thread.
    fn failure(&self, what: &str, status: Status) -> String {
        // SAFETY: the table holds the header's functions of a library still loaded; the message
        // is copied before the next call.
        let message = unsafe {
            let message = (self.table.get_last_error_message)();
            if message.is_null() {
                String::new()
            } else {
                CStr::from_ptr(message).to_string_lossy().into_owned()
            }
        };
        match message.is_empty() {
            true => format!("{what} (status {status})"),
            false => format!("{what}: {message}"),
        }
    }

    fn check(&self, what: &str, status: Status) -> Result<(), String> {
        match status {
            STATUS_OK => Ok(()),
            _ => Err(self.failure(what, status)),
        }
    }

    /// Calls `create(&mut out)` and owns what it made.
    fn make(
        &self,
        what: &str,
        create: unsafe extern "C" fn(*mut Raw) -> Status,
        delete: unsafe extern "C" fn(Raw),
    ) -> Result<Owned, String> {
        let mut raw: Raw = ptr::null_mut();
        // SAFETY: `create` and `delete` are a matching pair of the table; `raw` is its out pointer.
        self.check(what, unsafe { create(&mut raw) })?;
        Ok(Owned { raw, delete })
    }

    fn sampler_config(&self, prompt: &LiteRtPrompt) -> Result<Owned, String> {
        let t = &self.table;
        let mut raw: Raw = ptr::null_mut();
        // SAFETY (this function): every pointer is a live object of the table, owned by an `Owned`
        // that outlives the calls using it.
        let status = unsafe { (t.sampler_params_create)(SAMPLER_TOP_P, &mut raw) };
        self.check("could not create the sampler", status)?;
        let sampler = Owned {
            raw,
            delete: t.sampler_params_delete,
        };
        let s = prompt.sampler;
        unsafe {
            self.check("top_k", (t.sampler_params_set_top_k)(sampler.raw, s.top_k))?;
            self.check("top_p", (t.sampler_params_set_top_p)(sampler.raw, s.top_p))?;
            self.check(
                "temperature",
                (t.sampler_params_set_temperature)(sampler.raw, s.temperature),
            )?;
            self.check("seed", (t.sampler_params_set_seed)(sampler.raw, s.seed))?;
        }
        let session = self.make(
            "could not create the session config",
            t.session_config_create,
            t.session_config_delete,
        )?;
        let status = unsafe { (t.session_config_set_sampler_params)(session.raw, sampler.raw) };
        self.check("could not set the sampler", status)?;
        Ok(session)
    }

    fn conversation_config(&self, prompt: &LiteRtPrompt) -> Result<Owned, String> {
        let t = &self.table;
        let session = self.sampler_config(prompt)?;
        let config = self.make(
            "could not create the conversation config",
            t.conversation_config_create,
            t.conversation_config_delete,
        )?;
        // SAFETY (this function): as `sampler_config`.
        let status = unsafe { (t.conversation_config_set_session_config)(config.raw, session.raw) };
        self.check("could not set the session config", status)?;
        if let Some(context) = prompt.context_messages_json() {
            let context = to_c_string(&context)?;
            let status =
                unsafe { (t.conversation_config_set_messages)(config.raw, context.as_ptr()) };
            self.check("could not set the conversation's messages", status)?;
        }
        if !prompt.enable_thinking {
            let thinking = self.make(
                "could not create the thinking config",
                t.thinking_config_create,
                t.thinking_config_delete,
            )?;
            let status = unsafe { (t.thinking_config_set_enable_thinking)(thinking.raw, false) };
            self.check("could not turn thinking off", status)?;
            let status =
                unsafe { (t.conversation_config_set_thinking_config)(config.raw, thinking.raw) };
            self.check("could not set the thinking config", status)?;
        }
        Ok(config)
    }

    fn engine_settings(&self, settings: &EngineSettings) -> Result<Owned, String> {
        let t = &self.table;
        let path = to_c_string(&settings.model_path)?;
        let backend = to_c_string(&settings.backend)?;
        let mut raw: Raw = ptr::null_mut();
        // SAFETY (this function): as `sampler_config`; the strings outlive the calls, which copy them.
        let status = unsafe {
            (t.engine_settings_create)(
                path.as_ptr(),
                backend.as_ptr(),
                ptr::null(),
                ptr::null(),
                &mut raw,
            )
        };
        self.check("could not create the engine settings", status)?;
        let owned = Owned {
            raw,
            delete: t.engine_settings_delete,
        };
        let status =
            unsafe { (t.engine_settings_set_max_num_tokens)(owned.raw, settings.max_num_tokens) };
        self.check("could not set max_num_tokens", status)?;
        if let Some(threads) = settings.num_threads {
            let status = unsafe { (t.engine_settings_set_num_threads)(owned.raw, threads) };
            self.check("could not set num_threads", status)?;
        }
        if let Some(cache_dir) = &settings.cache_dir {
            let cache_dir = to_c_string(cache_dir)?;
            let status =
                unsafe { (t.engine_settings_set_cache_dir)(owned.raw, cache_dir.as_ptr()) };
            self.check("could not set the cache dir", status)?;
        }
        if settings.enable_benchmark {
            let status = unsafe { (t.engine_settings_enable_benchmark)(owned.raw) };
            self.check("could not enable the benchmark", status)?;
        }
        Ok(owned)
    }

    fn benchmark_turns(
        &self,
        info: *const c_void,
        count: unsafe extern "C" fn(*const c_void, *mut usize) -> Status,
        tokens: unsafe extern "C" fn(*const c_void, usize, *mut usize) -> Status,
        speed: unsafe extern "C" fn(*const c_void, usize, *mut f64) -> Status,
    ) -> Result<Vec<BenchmarkTurn>, String> {
        let mut turns = 0usize;
        // SAFETY (this function): `info` is a live benchmark object; each getter is the table's.
        self.check("benchmark turn count", unsafe { count(info, &mut turns) })?;
        (0..turns)
            .map(|index| {
                let mut turn = BenchmarkTurn::default();
                self.check("benchmark token count", unsafe {
                    tokens(info, index, &mut turn.tokens)
                })?;
                self.check("benchmark speed", unsafe {
                    speed(info, index, &mut turn.tokens_per_sec)
                })?;
                Ok(turn)
            })
            .collect()
    }
}

fn to_c_string(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "a LiteRT-LM argument holds a NUL byte".to_owned())
}

impl LiteRtCalls for LiteRtApi {
    fn set_min_log_level(&self, level: LogSeverity) -> Result<(), String> {
        let status = unsafe { (self.table.set_min_log_level)(level as c_int) };
        self.check("could not set the log level", status)
    }

    fn create_engine(&self, settings: &EngineSettings) -> Result<EngineHandle, EngineError> {
        self.open_engine(settings)
            .map_err(EngineError::EngineFailure)
    }

    fn delete_engine(&self, engine: EngineHandle) {
        unsafe { (self.table.engine_delete)(engine.as_ptr()) }
    }

    fn start_reply(
        &self,
        engine: &EngineHandle,
        prompt: &LiteRtPrompt,
        sink: ChunkSink,
    ) -> Result<ConversationHandle, String> {
        self.open_conversation(engine, prompt, sink)
    }

    fn cancel_reply(&self, conversation: &ConversationHandle) -> Result<(), String> {
        let status = unsafe { (self.table.conversation_cancel_process)(conversation.as_ptr()) };
        self.check("could not cancel the reply", status)
    }

    fn benchmark(&self, conversation: &ConversationHandle) -> Result<Benchmark, String> {
        self.read_benchmark(conversation)
    }

    fn delete_conversation(&self, conversation: ConversationHandle) {
        unsafe { (self.table.conversation_delete)(conversation.as_ptr()) }
        // The stream state is dropped with the handle, after the stream is gone.
    }
}

impl LiteRtApi {
    fn open_engine(&self, settings: &EngineSettings) -> Result<EngineHandle, String> {
        let settings = self.engine_settings(settings)?;
        let mut engine: Raw = ptr::null_mut();
        unsafe { (self.table.clear_last_error)() };
        let status = unsafe { (self.table.engine_create)(settings.raw, &mut engine) };
        self.check("could not create the engine", status)?;
        let engine = NonNull::new(engine).ok_or("the engine is null".to_owned())?;
        Ok(EngineHandle(engine))
    }

    fn open_conversation(
        &self,
        engine: &EngineHandle,
        prompt: &LiteRtPrompt,
        sink: ChunkSink,
    ) -> Result<ConversationHandle, String> {
        let t = &self.table;
        let config = self.conversation_config(prompt)?;
        let mut conversation: Raw = ptr::null_mut();
        // SAFETY (this function): the engine is live, the config is owned here, the state outlives
        // the stream because the returned handle owns it, and the message strings are copied.
        let status =
            unsafe { (t.conversation_create)(engine.as_ptr(), config.raw, &mut conversation) };
        self.check("could not create the conversation", status)?;
        let conversation =
            NonNull::new(conversation).ok_or("the conversation is null".to_owned())?;
        let mut state = Box::new(StreamState {
            sink,
            get_text: t.stream_chunk_get_text,
            get_error: t.stream_chunk_get_error,
            is_final: t.stream_chunk_is_final,
        });
        let data: *mut StreamState = &mut *state;
        let handle = ConversationHandle {
            raw: conversation,
            _stream: state,
        };
        let sent = self.send(&handle, prompt, data.cast());
        match sent {
            Ok(()) => Ok(handle),
            Err(message) => {
                self.delete_conversation(handle);
                Err(message)
            }
        }
    }

    fn read_benchmark(&self, conversation: &ConversationHandle) -> Result<Benchmark, String> {
        let t = &self.table;
        let mut raw: Raw = ptr::null_mut();
        let status =
            unsafe { (t.conversation_get_benchmark_info)(conversation.as_ptr(), &mut raw) };
        self.check("could not read the benchmark", status)?;
        let info = Owned {
            raw,
            delete: t.benchmark_info_delete,
        };
        Ok(Benchmark {
            prefill: self.benchmark_turns(
                info.raw,
                t.benchmark_info_get_num_prefill_turns,
                t.benchmark_info_get_prefill_token_count_at,
                t.benchmark_info_get_prefill_tokens_per_sec_at,
            )?,
            decode: self.benchmark_turns(
                info.raw,
                t.benchmark_info_get_num_decode_turns,
                t.benchmark_info_get_decode_token_count_at,
                t.benchmark_info_get_decode_tokens_per_sec_at,
            )?,
        })
    }

    /// Sends the user turn; the optional args carry the output cap.
    fn send(
        &self,
        conversation: &ConversationHandle,
        prompt: &LiteRtPrompt,
        data: *mut c_void,
    ) -> Result<(), String> {
        let t = &self.table;
        let message = to_c_string(&prompt.user_message_json())?;
        let mut optional_args: Option<Owned> = None;
        if let Some(limit) = prompt.max_output_tokens {
            let args = self.make(
                "could not create the reply options",
                t.conversation_optional_args_create,
                t.conversation_optional_args_delete,
            )?;
            let limit = c_int::try_from(limit).unwrap_or(c_int::MAX);
            let status =
                unsafe { (t.conversation_optional_args_set_max_output_tokens)(args.raw, limit) };
            self.check("could not set max_output_tokens", status)?;
            optional_args = Some(args);
        }
        unsafe { (t.clear_last_error)() };
        // SAFETY: the conversation is live; `data` is the `StreamState` it owns.
        let status = unsafe {
            (t.conversation_send_message_stream)(
                conversation.as_ptr(),
                message.as_ptr(),
                ptr::null(),
                optional_args
                    .as_ref()
                    .map_or(ptr::null_mut(), |args| args.raw),
                Some(stream_trampoline),
                data,
            )
        };
        self.check("could not start the reply", status)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// The architecture 3.2 list, which `table!` must be exactly.
    const EXPECTED_COUNT: usize = 46;

    #[test]
    fn the_table_is_the_forty_six_functions_of_architecture_3_2() {
        assert_eq!(SYMBOLS.len(), EXPECTED_COUNT);
        let mut unique = SYMBOLS.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), EXPECTED_COUNT);
    }

    #[test]
    fn every_function_of_the_table_is_declared_in_the_vendored_headers() {
        let headers = ["engine.h", "conversation.h", "error_reporter.h"]
            .iter()
            .map(|name| {
                let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("vendor")
                    .join("litert_lm")
                    .join("c")
                    .join(name);
                fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?}: {error}"))
            })
            .collect::<String>();
        let undeclared: Vec<_> = SYMBOLS
            .iter()
            .filter(|name| !headers.contains(&format!("{name}(")))
            .collect();
        assert!(undeclared.is_empty(), "not in the headers: {undeclared:?}");
    }

    #[test]
    fn a_missing_library_is_unavailable_with_the_loaders_message() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("no-such-litert-lm-library");
        match LiteRtApi::open(&path) {
            Err(EngineError::EngineUnavailable {
                engine,
                kind,
                reason,
            }) => {
                assert_eq!(engine, EngineId::new(EngineId::LITERT_LM));
                assert_eq!(kind, EngineKind::LitertLm);
                assert!(
                    reason.starts_with("LiteRT-LM cannot run on this device: "),
                    "{reason}"
                );
            }
            other => panic!("expected EngineUnavailable, got {:?}", other.err()),
        }
    }

    #[test]
    fn a_library_without_the_functions_is_unavailable_naming_the_first_missing_one() {
        let result = LiteRtApi::resolve(Library::from(this_process()));
        match result {
            Err(EngineError::EngineUnavailable { reason, .. }) => {
                assert!(reason.starts_with("LiteRT-LM cannot run on this device: "));
                assert!(
                    reason.contains("litert_lm_engine_settings_create"),
                    "{reason}"
                );
            }
            other => panic!("expected EngineUnavailable, got {:?}", other.err()),
        }
    }

    #[cfg(unix)]
    fn this_process() -> libloading::os::unix::Library {
        libloading::os::unix::Library::this()
    }

    #[cfg(windows)]
    fn this_process() -> libloading::os::windows::Library {
        libloading::os::windows::Library::this().expect("the running program")
    }

    /// A chunk as the test readers below see it.
    struct FakeChunk {
        text: Option<CString>,
        error: Option<CString>,
        is_final: bool,
    }

    unsafe fn fake_string(slot: Option<&CString>, out: *mut *const c_char) -> Status {
        unsafe { *out = slot.map_or(ptr::null(), |text| text.as_ptr()) };
        STATUS_OK
    }

    unsafe extern "C" fn fake_get_text(chunk: *const c_void, out: *mut *const c_char) -> Status {
        unsafe { fake_string((*chunk.cast::<FakeChunk>()).text.as_ref(), out) }
    }

    unsafe extern "C" fn fake_get_error(chunk: *const c_void, out: *mut *const c_char) -> Status {
        unsafe { fake_string((*chunk.cast::<FakeChunk>()).error.as_ref(), out) }
    }

    unsafe extern "C" fn fake_is_final(chunk: *const c_void, out: *mut bool) -> Status {
        unsafe { *out = (*chunk.cast::<FakeChunk>()).is_final };
        STATUS_OK
    }

    fn deliver(chunk: &FakeChunk) -> RawChunk {
        let received = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&received);
        let mut state = StreamState {
            sink: Box::new(move |raw| seen.lock().expect("sink lock").push(raw)),
            get_text: fake_get_text,
            get_error: fake_get_error,
            is_final: fake_is_final,
        };
        // SAFETY: `state` and `chunk` are live for the call, and are the types the fakes read.
        unsafe {
            stream_trampoline(
                ptr::from_mut(&mut state).cast(),
                ptr::from_ref(chunk).cast(),
            );
        }
        let mut received = received.lock().expect("sink lock");
        assert_eq!(received.len(), 1);
        received.remove(0)
    }

    #[test]
    fn the_stream_callback_hands_the_sink_the_chunks_text() {
        let chunk = FakeChunk {
            text: Some(CString::new(r#"{"content":"Hi"}"#).expect("no NUL")),
            error: None,
            is_final: false,
        };
        assert_eq!(
            deliver(&chunk),
            RawChunk {
                payload: r#"{"content":"Hi"}"#.to_owned(),
                error: None,
                is_final: false,
            }
        );
    }

    #[test]
    fn the_stream_callback_hands_the_sink_the_final_mark_and_the_error() {
        let chunk = FakeChunk {
            text: None,
            error: Some(CString::new("out of memory").expect("no NUL")),
            is_final: true,
        };
        assert_eq!(
            deliver(&chunk),
            RawChunk {
                payload: String::new(),
                error: Some("out of memory".to_owned()),
                is_final: true,
            }
        );
    }
}
