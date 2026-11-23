#include "chat_format.h"

#include "json.h"
#include "session_error.h"

#include <algorithm>
#include <utility>

namespace turbollm {

namespace {

common_chat_templates_inputs jinja_inputs(const chat_request & request) {
    common_chat_templates_inputs inputs;
    inputs.messages              = request.messages;
    inputs.add_generation_prompt = true;
    inputs.use_jinja             = true;
    inputs.reasoning_format      = COMMON_REASONING_FORMAT_DEEPSEEK;
    inputs.enable_thinking       = request.enable_thinking;
    inputs.chat_template_kwargs  = request.template_kwargs;
    return inputs;
}

// The legacy path renders the messages only: it knows nothing of thinking or template kwargs.
common_chat_templates_inputs legacy_inputs(const chat_request & request) {
    common_chat_templates_inputs inputs;
    inputs.messages              = request.messages;
    inputs.add_generation_prompt = true;
    inputs.use_jinja             = false;
    return inputs;
}

rendered_chat rendered(const common_chat_params & params) {
    common_chat_parser_params syntax(params);
    syntax.reasoning_format     = COMMON_REASONING_FORMAT_DEEPSEEK;
    syntax.reasoning_in_content = false;
    syntax.parse_tool_calls     = false;
    if (!params.parser.empty()) {
        syntax.parser.load(params.parser);
    }
    return { params.prompt, std::move(syntax), params.preserved_tokens };
}

size_t utf8_sequence_length(unsigned char lead) {
    if ((lead & 0xE0) == 0xC0) {
        return 2;
    }
    if ((lead & 0xF0) == 0xE0) {
        return 3;
    }
    if ((lead & 0xF8) == 0xF0) {
        return 4;
    }
    return 1;
}

bool is_continuation_byte(unsigned char byte) {
    return (byte & 0xC0) == 0x80;
}

}  // namespace

chat_request parse_chat_request(const std::string & request_json) {
    const common_json request = common_json::parse(request_json);
    chat_request chat;
    chat.messages        = common_chat_msgs_parse_oaicompat(request.at("messages"));
    chat.enable_thinking = request.value("enable_thinking", true);
    if (request.contains("chat_template_kwargs")) {
        for (const auto & [key, encoded_value] : request.at("chat_template_kwargs").items()) {
            chat.template_kwargs[key] = encoded_value.get<std::string>();
        }
    }
    return chat;
}

rendered_chat render_chat(const common_chat_templates * templates, const chat_request & request) {
    try {
        return rendered(common_chat_templates_apply(templates, jinja_inputs(request)));
    } catch (const std::exception & jinja_error) {
        try {
            return rendered(common_chat_templates_apply(templates, legacy_inputs(request)));
        } catch (const std::exception &) {
            throw session_error(session_failure::template_unsupported,
                                std::string("The model's chat template cannot be rendered: ") + jinja_error.what());
        }
    }
}

std::string to_json(const reply_delta & delta) {
    return common_json::object({
        { "content", delta.content },
        { "reasoning", delta.reasoning },
    }).dump_safe();
}

reply_parser::reply_parser(common_chat_parser_params syntax) : syntax_(std::move(syntax)) {}

void reply_parser::append(const std::string & piece) {
    reply_ += piece;
}

reply_delta reply_parser::next_delta(bool is_partial) {
    if (!unparseable_) {
        try {
            return parsed_delta(is_partial);
        } catch (const std::exception &) {
            unparseable_ = true;
        }
    }
    return unparsed_delta(is_partial);
}

reply_delta reply_parser::parsed_delta(bool is_partial) {
    const size_t    parseable = is_partial ? complete_utf8_length(reply_) : reply_.size();
    common_chat_msg parsed    = common_chat_parse(reply_.substr(0, parseable), is_partial, syntax_);
    reply_delta     delta;
    for (const auto & diff : common_chat_msg_diff::compute_diffs(parsed_so_far_, parsed)) {
        delta.reasoning += diff.reasoning_content_delta;
        delta.content += diff.content_delta;
    }
    parsed_so_far_ = std::move(parsed);
    handed_out_    = parseable;
    return delta;
}

reply_delta reply_parser::unparsed_delta(bool is_partial) {
    const size_t end   = is_partial ? complete_utf8_length(reply_) : reply_.size();
    const size_t start = std::min(handed_out_, end);
    handed_out_        = end;
    return { reply_.substr(start, end - start), "" };
}

size_t complete_utf8_length(const std::string & text) {
    const size_t longest_sequence = 4;
    for (size_t back = 1; back <= std::min(longest_sequence, text.size()); ++back) {
        const auto byte = static_cast<unsigned char>(text[text.size() - back]);
        if (!is_continuation_byte(byte)) {
            return utf8_sequence_length(byte) > back ? text.size() - back : text.size();
        }
    }
    return text.size();
}

}  // namespace turbollm
