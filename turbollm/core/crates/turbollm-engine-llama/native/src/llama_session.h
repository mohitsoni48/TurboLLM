#pragma once

#include "chat.h"
#include "chat_format.h"
#include "llama-cpp.h"

#ifdef TURBOLLM_TEST_PROBES
#    include "test_probes.h"
#endif

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_set>

namespace turbollm {

struct sampling_settings {
    float   temperature;
    float   top_p;
    int32_t top_k;
    int64_t seed;  // negative: a random seed
};

struct prompt_stats {
    size_t prompt_tokens  = 0;
    size_t decoded_tokens = 0;  // the part after the prefix already in the KV cache
    double prompt_ms      = 0;
};

struct generation_stats {
    size_t generated_tokens = 0;
    double generation_ms    = 0;
    bool   context_full     = false;
};

// The caller's hooks into a load and into every decode afterwards. The abort flag lives with the caller,
// which raises and lowers it; llama.cpp polls the abort hook from its compute threads.
struct session_hooks {
    llama_progress_callback progress      = nullptr;  // false stops the load
    void *                  progress_data = nullptr;
    ggml_abort_callback     abort         = nullptr;  // true stops the decode in flight
    void *                  abort_data    = nullptr;
};

// One loaded model, its context and its chat templates. Not thread-safe: every call comes from the engine
// thread. Failures are thrown as session_error.
class llama_session {
public:
    static std::unique_ptr<llama_session> load(const std::string & model_path, int32_t context_size, int32_t threads,
                                               const session_hooks & hooks);

    uint32_t context_length() const noexcept;
    int32_t  trained_context_length() const noexcept;
    size_t   prepare(const std::string & request_json);
    void     start_sampling(const sampling_settings & settings);

    // nullopt once the reply has ended: an end-of-generation token, or a full context.
    // An empty piece is a control token.
    std::optional<std::string> next_token();

    reply_delta      parse_delta(bool is_partial);
    prompt_stats     last_prompt_stats() const noexcept;
    generation_stats last_generation_stats() const noexcept;

private:
    llama_session(llama_model_ptr model, llama_context_ptr context, common_chat_templates_ptr templates,
                  const session_hooks & hooks);

    llama_tokens tokenize(const std::string & prompt) const;
    void         refuse_unfit_prompt(const llama_tokens & prompt) const;
    void         prefill(const llama_tokens & prompt);
    size_t       reuse_cached_prefix(const llama_tokens & prompt);
    void         decode(const llama_token * tokens, size_t count);
    void         decode_generated(llama_token token);
    void         forget_undecoded_tail();
    llama_memory_t memory() const;
    void         remember_rendered_specials(const std::vector<std::string> & preserved_tokens);
    std::string  piece_of(llama_token token) const;
    bool         context_has_room_for_one_more() const;
    void         end_reply(bool context_full);

#ifdef TURBOLLM_TEST_PROBES
    live_session_count live_count_;  // first, so it is destroyed last: after the model is freed
#endif

    // Declared in reverse order of release: the sampler goes first, the model last.
    llama_model_ptr           model_;
    llama_context_ptr         context_;
    common_chat_templates_ptr templates_;
    llama_sampler_ptr         sampler_;

    const llama_vocab *             vocab_;
    llama_tokens                    cached_tokens_;
    std::unordered_set<llama_token> rendered_specials_;
    reply_parser                    reply_;
    prompt_stats                    prompt_stats_;
    generation_stats                generation_stats_;
    bool                            prompt_ready_ = false;
    bool                            reply_open_   = false;
};

}  // namespace turbollm
