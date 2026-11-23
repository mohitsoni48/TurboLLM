#include "llama_session.h"

#include "common.h"
#include "json.h"
#include "llama.h"
#include "session_error.h"

#include <algorithm>
#include <chrono>
#include <utility>

namespace turbollm {

namespace {

constexpr uint32_t prompt_batch_size = 512;
constexpr int32_t  decode_aborted    = 2;

using steady_clock = std::chrono::steady_clock;

double milliseconds_since(steady_clock::time_point start) {
    return std::chrono::duration<double, std::milli>(steady_clock::now() - start).count();
}

llama_model_ptr load_model(const std::string & model_path) {
    llama_model_params params = llama_model_default_params();
    params.load_mode          = LLAMA_LOAD_MODE_MMAP;
    params.n_gpu_layers       = 0;
    llama_model_ptr model(llama_model_load_from_file(model_path.c_str(), params));
    if (!model) {
        throw session_error(session_failure::failed, "The model could not be loaded from " + model_path + ".");
    }
    return model;
}

llama_context_ptr create_context(llama_model * model, int32_t context_size, int32_t threads) {
    llama_context_params params = llama_context_default_params();
    params.n_ctx                = static_cast<uint32_t>(context_size);
    params.n_batch              = prompt_batch_size;
    params.n_threads            = threads;
    params.n_threads_batch      = threads;
    llama_context_ptr context(llama_init_from_model(model, params));
    if (!context) {
        throw session_error(session_failure::failed,
                            "A context of " + std::to_string(context_size) + " tokens could not be created.");
    }
    return context;
}

void add_sampling_stages(llama_sampler * chain, const sampling_settings & settings) {
    if (settings.top_k > 0) {
        llama_sampler_chain_add(chain, llama_sampler_init_top_k(settings.top_k));
    }
    if (settings.top_p < 1.0f) {
        llama_sampler_chain_add(chain, llama_sampler_init_top_p(settings.top_p, 1));
    }
    if (settings.temperature > 0.0f) {
        const uint32_t seed = settings.seed < 0 ? LLAMA_DEFAULT_SEED : static_cast<uint32_t>(settings.seed);
        llama_sampler_chain_add(chain, llama_sampler_init_temp(settings.temperature));
        llama_sampler_chain_add(chain, llama_sampler_init_dist(seed));
    } else {
        llama_sampler_chain_add(chain, llama_sampler_init_greedy());
    }
}

size_t shared_prefix_length(const llama_tokens & cached, const llama_tokens & prompt) {
    const size_t comparable = std::min(cached.size(), prompt.size());
    const auto   first_difference =
        std::mismatch(cached.begin(), cached.begin() + comparable, prompt.begin()).first;
    return static_cast<size_t>(first_difference - cached.begin());
}

session_error decode_failure(int32_t status) {
    if (status == decode_aborted) {
        return session_error(session_failure::aborted, "The request was cancelled.");
    }
    return session_error(session_failure::failed, "llama_decode failed with status " + std::to_string(status) + ".");
}

std::string model_description(const llama_model * model) {
    char description[256];
    llama_model_desc(model, description, sizeof(description));
    return description;
}

}  // namespace

std::unique_ptr<llama_session> llama_session::load(const std::string & model_path, int32_t context_size,
                                                   int32_t threads) {
    llama_model_ptr           model     = load_model(model_path);
    llama_context_ptr         context   = create_context(model.get(), context_size, std::max(threads, 1));
    common_chat_templates_ptr templates = common_chat_templates_init(model.get(), "");
    return std::unique_ptr<llama_session>(
        new llama_session(std::move(model), std::move(context), std::move(templates)));
}

llama_session::llama_session(llama_model_ptr model, llama_context_ptr context, common_chat_templates_ptr templates) :
    model_(std::move(model)),
    context_(std::move(context)),
    templates_(std::move(templates)),
    vocab_(llama_model_get_vocab(model_.get())) {
    llama_set_abort_callback(context_.get(), &llama_session::should_abort, this);
}

bool llama_session::should_abort(void * session) {
    return static_cast<llama_session *>(session)->abort_requested_.load();
}

std::string llama_session::model_info_json() const {
    return common_json::object({
        { "n_ctx", llama_n_ctx(context_.get()) },
        { "n_ctx_train", llama_model_n_ctx_train(model_.get()) },
        { "desc", model_description(model_.get()) },
    }).dump_safe();
}

size_t llama_session::prepare(const std::string & request_json) {
    prompt_ready_            = false;
    reply_open_              = false;
    const rendered_chat chat = render_chat(templates_.get(), parse_chat_request(request_json));
    const llama_tokens prompt = tokenize(chat.prompt);
    refuse_unfit_prompt(prompt);
    prefill(prompt);
    reply_ = reply_parser(chat.reply_syntax);
    remember_rendered_specials(chat.preserved_tokens);
    prompt_ready_ = true;
    return prompt.size();
}

llama_tokens llama_session::tokenize(const std::string & prompt) const {
    return common_tokenize(vocab_, prompt, /* add_special */ true, /* parse_special */ true);
}

void llama_session::refuse_unfit_prompt(const llama_tokens & prompt) const {
    const uint32_t context_size = llama_n_ctx(context_.get());
    if (prompt.empty()) {
        throw session_error(session_failure::failed, "The chat template rendered an empty prompt.");
    }
    if (prompt.size() >= context_size) {
        throw session_error(session_failure::context_length_exceeded,
                            "The prompt is " + std::to_string(prompt.size()) + " tokens, and the context holds " +
                                std::to_string(context_size) + ".");
    }
}

void llama_session::prefill(const llama_tokens & prompt) {
    const auto   started    = steady_clock::now();
    const size_t reused     = reuse_cached_prefix(prompt);
    const size_t batch_size = llama_n_batch(context_.get());
    for (size_t next = reused; next < prompt.size(); next += batch_size) {
        decode(prompt.data() + next, std::min(batch_size, prompt.size() - next));
    }
    prompt_stats_ = { prompt.size(), prompt.size() - reused, milliseconds_since(started) };
}

// The last prompt token is always decoded again, because sampling needs its logits.
size_t llama_session::reuse_cached_prefix(const llama_tokens & prompt) {
    size_t prefix = std::min(shared_prefix_length(cached_tokens_, prompt), prompt.size() - 1);
    if (!llama_memory_seq_rm(memory(), 0, static_cast<llama_pos>(prefix), -1)) {
        llama_memory_clear(memory(), true);
        prefix = 0;
    }
    cached_tokens_.resize(prefix);
    return prefix;
}

void llama_session::decode(const llama_token * tokens, size_t count) {
    llama_batch   batch  = llama_batch_get_one(const_cast<llama_token *>(tokens), static_cast<int32_t>(count));
    const int32_t status = llama_decode(context_.get(), batch);
    if (status != 0) {
        forget_undecoded_tail();
        throw decode_failure(status);
    }
    cached_tokens_.insert(cached_tokens_.end(), tokens, tokens + count);
}

// An aborted or failed decode can leave part of its batch in the KV cache: trim it back to the
// last batch that was decoded whole, so the cache and cached_tokens_ agree again.
void llama_session::forget_undecoded_tail() {
    if (!llama_memory_seq_rm(memory(), 0, static_cast<llama_pos>(cached_tokens_.size()), -1)) {
        llama_memory_clear(memory(), true);
        cached_tokens_.clear();
    }
}

llama_memory_t llama_session::memory() const {
    return llama_get_memory(context_.get());
}

void llama_session::remember_rendered_specials(const std::vector<std::string> & preserved_tokens) {
    rendered_specials_.clear();
    for (const auto & text : preserved_tokens) {
        const llama_tokens ids = common_tokenize(vocab_, text, /* add_special */ false, /* parse_special */ true);
        if (ids.size() == 1) {
            rendered_specials_.insert(ids.front());
        }
    }
}

void llama_session::start_sampling(const sampling_settings & settings) {
    if (!prompt_ready_) {
        throw session_error(session_failure::failed, "Sampling needs a prepared prompt.");
    }
    sampler_.reset(llama_sampler_chain_init(llama_sampler_chain_default_params()));
    add_sampling_stages(sampler_.get(), settings);
    generation_stats_ = {};
    prompt_ready_     = false;
    reply_open_       = true;
}

std::optional<std::string> llama_session::next_token() {
    if (!reply_open_) {
        return std::nullopt;
    }
    const auto        started = steady_clock::now();
    const llama_token token   = llama_sampler_sample(sampler_.get(), context_.get(), -1);
    if (llama_vocab_is_eog(vocab_, token)) {
        end_reply(false);
        return std::nullopt;
    }
    std::string piece = piece_of(token);
    reply_.append(piece);
    ++generation_stats_.generated_tokens;
    if (context_has_room_for_one_more()) {
        decode_generated(token);
    } else {
        end_reply(true);
    }
    generation_stats_.generation_ms += milliseconds_since(started);
    return piece;
}

std::string llama_session::piece_of(llama_token token) const {
    return common_token_to_piece(vocab_, token, rendered_specials_.count(token) > 0);
}

bool llama_session::context_has_room_for_one_more() const {
    return cached_tokens_.size() < llama_n_ctx(context_.get());
}

void llama_session::decode_generated(llama_token token) {
    try {
        decode(&token, 1);
    } catch (const session_error &) {
        end_reply(false);
        throw;
    }
}

void llama_session::end_reply(bool context_full) {
    reply_open_                    = false;
    generation_stats_.context_full = context_full;
}

std::string llama_session::parse_delta_json(bool is_partial) {
    return to_json(reply_.next_delta(is_partial));
}

std::string llama_session::stats_json() const {
    return common_json::object({
        { "prompt_n", prompt_stats_.prompt_tokens },
        { "prompt_decoded", prompt_stats_.decoded_tokens },
        { "prompt_ms", prompt_stats_.prompt_ms },
        { "predicted_n", generation_stats_.generated_tokens },
        { "predicted_ms", generation_stats_.generation_ms },
        { "context_full", generation_stats_.context_full },
    }).dump_safe();
}

void llama_session::request_abort() noexcept {
    abort_requested_.store(true);
}

void llama_session::clear_abort() noexcept {
    abort_requested_.store(false);
}

}  // namespace turbollm
