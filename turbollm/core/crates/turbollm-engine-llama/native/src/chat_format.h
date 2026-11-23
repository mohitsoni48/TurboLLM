#pragma once

#include "chat.h"

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace turbollm {

// What LlamaNative.prepare receives:
// {"messages":[...],"enable_thinking":<bool>,"chat_template_kwargs":{"<k>":"<json-encoded value>"}}
struct chat_request {
    std::vector<common_chat_msg>       messages;
    bool                               enable_thinking = true;
    std::map<std::string, std::string> template_kwargs;
};

chat_request parse_chat_request(const std::string & request_json);

struct rendered_chat {
    std::string               prompt;
    common_chat_parser_params reply_syntax;
    std::vector<std::string>  preserved_tokens;
};

// Jinja first; the legacy llama_chat_apply_template path if Jinja throws. Throws template_unsupported if both fail.
rendered_chat render_chat(const common_chat_templates * templates, const chat_request & request);

struct reply_delta {
    std::string content;
    std::string reasoning;
};

std::string to_json(const reply_delta & delta);

// Splits the reply generated so far into reasoning and content, and hands out only what is new each time.
// If the reply cannot be parsed, the rest of it is handed out as content: output degrades, it is never lost.
class reply_parser {
public:
    reply_parser() = default;
    explicit reply_parser(common_chat_parser_params syntax);

    void        append(const std::string & piece);
    reply_delta next_delta(bool is_partial);

private:
    reply_delta parsed_delta(bool is_partial);
    reply_delta unparsed_delta(bool is_partial);

    common_chat_parser_params syntax_;
    std::string               reply_;
    common_chat_msg           parsed_so_far_;
    size_t                    handed_out_   = 0;
    bool                      unparseable_ = false;
};

// The length of the longest prefix of text that does not end inside a UTF-8 sequence.
size_t complete_utf8_length(const std::string & text);

}  // namespace turbollm
