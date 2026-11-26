// The C edge of the llama session library (architecture 3.1). Every call that can fail is wrapped in
// guarded(): no C++ exception ever crosses it. A failure is kept on its session for tl_llama_last_error
// (a failed load writes it into the caller's buffer instead) and the call returns its TL_* code.
// Everything else is built hidden; the header's declarations are what the library exports (on Windows the
// generated .def file of CMakeLists.txt names them instead).
#if !defined(_WIN32)
#    pragma GCC visibility push(default)
#endif
#include "tl_llama.h"
#if !defined(_WIN32)
#    pragma GCC visibility pop
#endif

#include "llama.h"
#include "llama_session.h"
#include "session_error.h"

#include <algorithm>
#include <cstring>
#include <exception>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <utility>

using turbollm::session_failure;

// tl_llama_next_token statuses, not TL_* codes (api.rs TOKEN_SAMPLED / END_OF_REPLY).
constexpr int32_t token_sampled = 1;
constexpr int32_t end_of_reply  = 0;

struct tl_session {
    std::unique_ptr<turbollm::llama_session> session;
    std::string                              piece;
    turbollm::reply_delta                    delta;
    mutable std::string                      last_error;  // a const call can fail too
};

namespace {

constexpr tl_str no_text{ "", 0 };

void remember(std::string & error_slot, const char * message) noexcept {
    try {
        error_slot = message;
    } catch (const std::bad_alloc &) {
        // Out of memory: the message is lost, but throwing here would cross the C ABI.
    }
}

template <typename Call, typename OnFailure>
auto guarded(std::string & error_slot, Call call, OnFailure on_failure) noexcept -> decltype(call()) {
    try {
        return call();
    } catch (const turbollm::session_error & error) {
        remember(error_slot, error.what());
        return on_failure(error.failure());
    } catch (const std::exception & error) {
        remember(error_slot, error.what());
        return on_failure(session_failure::failed);
    } catch (...) {
        remember(error_slot, "An unknown native failure occurred.");
        return on_failure(session_failure::failed);
    }
}

void nothing_more(session_failure) {}

int32_t failure_code(session_failure failure) {
    return static_cast<int32_t>(failure);
}

tl_session * no_session(session_failure) {
    return nullptr;
}

tl_str borrowed(const std::string & text) noexcept {
    return { text.data(), text.size() };
}

const char * required_path(const char * path) {
    if (path == nullptr) {
        throw turbollm::session_error(session_failure::failed, "No model path was given.");
    }
    return path;
}

// NUL-terminated and cut to fit; a buffer of no size gets nothing.
void copy_message(const std::string & message, char * buffer, size_t capacity) noexcept {
    if (buffer == nullptr || capacity == 0) {
        return;
    }
    const size_t length = std::min(message.size(), capacity - 1);
    std::memcpy(buffer, message.data(), length);
    buffer[length] = '\0';
}

tl_stats stats_of(const turbollm::llama_session & session) noexcept {
    const turbollm::prompt_stats     prompt     = session.last_prompt_stats();
    const turbollm::generation_stats generation = session.last_generation_stats();
    return {
        static_cast<int32_t>(prompt.prompt_tokens),        static_cast<int32_t>(prompt.decoded_tokens),
        prompt.prompt_ms,                                  static_cast<int32_t>(generation.generated_tokens),
        generation.generation_ms,                          generation.context_full,
    };
}

}  // namespace

uint32_t tl_llama_abi_version(void) {
    return TL_LLAMA_ABI;
}

void tl_llama_backend_init(void) {
    static std::once_flag backend_ready;
    std::string           unreported;
    guarded(unreported, [] { std::call_once(backend_ready, llama_backend_init); }, nothing_more);
}

tl_session * tl_llama_load(const char * path, int32_t n_ctx, int32_t n_threads, tl_progress_fn progress,
                                     void * progress_data, tl_abort_fn abort, void * abort_data, char * error,
                                     size_t error_len) {
    std::string  failure;
    tl_session * loaded = guarded(
        failure,
        [&] {
            const turbollm::session_hooks hooks{ progress, progress_data, abort, abort_data };
            return new tl_session{ turbollm::llama_session::load(required_path(path), n_ctx, n_threads, hooks) };
        },
        no_session);
    copy_message(failure, error, error_len);
    return loaded;
}

void tl_llama_model_info(const tl_session * session, tl_model_info * out) {
    guarded(
        session->last_error,
        [&] {
            *out = { static_cast<int32_t>(session->session->context_length()),
                     session->session->trained_context_length() };
        },
        nothing_more);
}

int32_t tl_llama_prepare(tl_session * session, const char * request_json, size_t len) {
    return guarded(
        session->last_error,
        [&] { return static_cast<int32_t>(session->session->prepare(std::string(request_json, len))); },
        failure_code);
}

int32_t tl_llama_start_sampling(tl_session * session, float temp, float top_p, int32_t top_k,
                                          int64_t seed) {
    return guarded(
        session->last_error,
        [&] {
            session->session->start_sampling({ temp, top_p, top_k, seed });
            return int32_t{ TL_OK };
        },
        failure_code);
}

int32_t tl_llama_next_token(tl_session * session, tl_str * piece) {
    *piece = no_text;
    return guarded(
        session->last_error,
        [&] {
            std::optional<std::string> next = session->session->next_token();
            if (!next) {
                return end_of_reply;
            }
            session->piece = std::move(*next);
            *piece         = borrowed(session->piece);
            return token_sampled;
        },
        failure_code);
}

int32_t tl_llama_parse_delta(tl_session * session, bool is_partial, tl_str * content, tl_str * reasoning) {
    return guarded(
        session->last_error,
        [&] {
            session->delta = session->session->parse_delta(is_partial);
            *content       = borrowed(session->delta.content);
            *reasoning     = borrowed(session->delta.reasoning);
            return int32_t{ TL_OK };
        },
        failure_code);
}

void tl_llama_stats(const tl_session * session, tl_stats * out) {
    guarded(session->last_error, [&] { *out = stats_of(*session->session); }, nothing_more);
}

tl_str tl_llama_last_error(const tl_session * session) {
    return borrowed(session->last_error);
}

void tl_llama_free(tl_session * session) {
    std::string unreported;
    guarded(unreported, [&] { delete session; }, nothing_more);
}

#ifdef TURBOLLM_TEST_PROBES
int32_t tl_llama_live_sessions(void) {
    return turbollm::live_session_count::current();
}
#endif
