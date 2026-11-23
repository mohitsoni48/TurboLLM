/* The C ABI of the llama session library (architecture 3.1). The only symbols a variant library exports.
 * No C++ exception crosses it. Every call but the two callbacks comes from the caller's (engine) thread. */
#ifndef TL_LLAMA_H
#define TL_LLAMA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TL_LLAMA_ABI 1
typedef struct tl_session tl_session;
typedef bool (*tl_abort_fn)(void * data);                 /* polled by llama.cpp; true = stop */
typedef bool (*tl_progress_fn)(float progress, void * data); /* false = abort the load */
typedef struct { const char * ptr; size_t len; } tl_str;  /* borrowed: valid until the next call on the session */
enum { TL_OK = 0, TL_FAILED = -1, TL_CONTEXT_LENGTH_EXCEEDED = -2, TL_TEMPLATE_UNSUPPORTED = -3, TL_ABORTED = -4 };
                                                          /* = session_failure, session_error.h:9-14 */
typedef struct { int32_t n_ctx; int32_t n_ctx_train; } tl_model_info;
typedef struct { int32_t prompt_n; int32_t prompt_decoded; double prompt_ms; int32_t predicted_n;
                 double predicted_ms; bool context_full; } tl_stats;

uint32_t     tl_llama_abi_version(void);
void         tl_llama_backend_init(void);                 /* idempotent (call_once inside the library) */
tl_session * tl_llama_load(const char * path, int32_t n_ctx, int32_t n_threads,
                           tl_progress_fn progress, void * progress_data, tl_abort_fn abort, void * abort_data,
                           char * error, size_t error_len); /* NULL on failure, message in error */
void         tl_llama_model_info(const tl_session *, tl_model_info * out);
int32_t      tl_llama_prepare(tl_session *, const char * request_json, size_t len); /* >=0 prompt tokens, else TL_* */
int32_t      tl_llama_start_sampling(tl_session *, float temp, float top_p, int32_t top_k, int64_t seed);
int32_t      tl_llama_next_token(tl_session *, tl_str * piece); /* 1 token, 0 end of reply, <0 TL_* */
int32_t      tl_llama_parse_delta(tl_session *, bool is_partial, tl_str * content, tl_str * reasoning);
void         tl_llama_stats(const tl_session *, tl_stats * out);
tl_str       tl_llama_last_error(const tl_session *);     /* per session, set by the last failed call */
void         tl_llama_free(tl_session *);                 /* sampler, templates, context, model, in that order */
#ifdef TURBOLLM_TEST_PROBES
int32_t      tl_llama_live_sessions(void);                /* host test builds only */
#endif

#ifdef __cplusplus
}
#endif

#endif /* TL_LLAMA_H */
