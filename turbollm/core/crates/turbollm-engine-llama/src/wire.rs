//! The request `tl_llama_prepare` reads (`LlamaWire.kt:10-20`, parsed by `chat_format.cpp:62-73`):
//! OpenAI messages, the thinking switch and the template kwargs, each kwarg value already JSON.

use std::collections::BTreeMap;

use serde::Serialize;
use turbollm_engine::{ChatMessage, GenerateRequest, MessageContent, Role};

/// The JSON for one reply's prompt, keys in the order the Kotlin SDK wrote them.
pub fn prepare_request(request: &GenerateRequest) -> String {
    let wire = PrepareRequest {
        messages: request.messages.iter().map(WireMessage::from).collect(),
        enable_thinking: request.params.enable_thinking,
        chat_template_kwargs: &request.params.template_kwargs,
    };
    serde_json::to_string(&wire).expect("strings, a bool and a string map always serialise")
}

#[derive(Serialize)]
struct PrepareRequest<'a> {
    messages: Vec<WireMessage<'a>>,
    enable_thinking: bool,
    chat_template_kwargs: &'a BTreeMap<String, String>,
}

#[derive(Serialize)]
struct WireMessage<'a> {
    role: &'static str,
    content: WireContent<'a>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum WireContent<'a> {
    Text(&'a str),
    Parts(Vec<TextPart<'a>>),
}

#[derive(Serialize)]
struct TextPart<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    text: &'a str,
}

impl<'a> From<&'a ChatMessage> for WireMessage<'a> {
    fn from(message: &'a ChatMessage) -> WireMessage<'a> {
        WireMessage {
            role: openai_role(message.role),
            content: WireContent::from(&message.content),
        }
    }
}

impl<'a> From<&'a MessageContent> for WireContent<'a> {
    fn from(content: &'a MessageContent) -> WireContent<'a> {
        match content {
            MessageContent::Text(text) => WireContent::Text(text),
            MessageContent::Parts(parts) => {
                WireContent::Parts(parts.iter().map(|text| TextPart::text(text)).collect())
            }
        }
    }
}

impl<'a> TextPart<'a> {
    fn text(text: &'a str) -> TextPart<'a> {
        TextPart { kind: "text", text }
    }
}

fn openai_role(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use turbollm_engine::{ChatMessage, GenerationParams, MessageContent, Role};

    use super::*;

    #[test]
    fn a_text_chat_is_written_as_openai_messages_with_the_thinking_switch() {
        let request = request(
            vec![
                text(Role::System, "Be brief."),
                text(Role::User, "Hi"),
                text(Role::Assistant, "Hello."),
            ],
            params(false, &[]),
        );

        assert_eq!(
            prepare_request(&request),
            r#"{"messages":[{"role":"system","content":"Be brief."},{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello."}],"enable_thinking":false,"chat_template_kwargs":{}}"#
        );
    }

    #[test]
    fn text_parts_are_written_as_typed_text_parts() {
        let parts = ChatMessage {
            role: Role::User,
            content: MessageContent::Parts(vec!["one".to_owned(), "two".to_owned()]),
        };

        assert_eq!(
            prepare_request(&request(vec![parts], params(true, &[]))),
            r#"{"messages":[{"role":"user","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}],"enable_thinking":true,"chat_template_kwargs":{}}"#
        );
    }

    #[test]
    fn template_kwargs_keep_their_values_as_json_encoded_strings() {
        let request = request(
            vec![text(Role::User, "Hi")],
            params(
                true,
                &[("reasoning_effort", r#""high""#), ("budget", "512")],
            ),
        );

        assert_eq!(
            prepare_request(&request),
            r#"{"messages":[{"role":"user","content":"Hi"}],"enable_thinking":true,"chat_template_kwargs":{"budget":"512","reasoning_effort":"\"high\""}}"#
        );
    }

    #[test]
    fn quotes_newlines_and_non_ascii_text_are_escaped_as_json() {
        let request = request(
            vec![text(Role::User, "say \"é\"\n思😀")],
            params(false, &[]),
        );

        assert_eq!(
            prepare_request(&request),
            "{\"messages\":[{\"role\":\"user\",\"content\":\"say \\\"é\\\"\\n思😀\"}],\"enable_thinking\":false,\"chat_template_kwargs\":{}}"
        );
    }

    fn request(messages: Vec<ChatMessage>, params: GenerationParams) -> GenerateRequest {
        GenerateRequest { messages, params }
    }

    fn text(role: Role, text: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: MessageContent::Text(text.to_owned()),
        }
    }

    fn params(enable_thinking: bool, kwargs: &[(&str, &str)]) -> GenerationParams {
        GenerationParams {
            enable_thinking,
            template_kwargs: kwargs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect::<BTreeMap<_, _>>(),
            ..GenerationParams::default()
        }
    }
}
