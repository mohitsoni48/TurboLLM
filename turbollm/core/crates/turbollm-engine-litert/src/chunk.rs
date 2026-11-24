//! One streamed chunk of a LiteRT-LM reply: the text and the thinking channel it carries
//! (`main.cc` `ParseChunk`; `AarMessageChunkTest.kt` for the cases).

use serde_json::Value;

/// What one chunk adds to the reply: each chunk is new output, not the reply so far.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiteRtChunk {
    pub text: String,
    pub thought: String,
}

/// Reads the chunk text the C API hands to the stream callback.
pub fn parse_chunk(raw: &str) -> LiteRtChunk {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(chunk)) => LiteRtChunk {
            text: chunk.get("content").map(content_text).unwrap_or_default(),
            thought: chunk
                .get("channels")
                .and_then(|channels| channels.get("thought"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        },
        // Not JSON, or JSON that is not a message: the runtime sent plain text.
        _ => LiteRtChunk {
            text: raw.to_owned(),
            thought: String::new(),
        },
    }
}

/// A string, or the text parts of a list of content parts.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(text: &str, thought: &str) -> LiteRtChunk {
        LiteRtChunk {
            text: text.to_owned(),
            thought: thought.to_owned(),
        }
    }

    #[test]
    fn a_thinking_chunk_carries_its_thought_channel_and_no_text() {
        let raw = r#"{"role":"assistant","channels":{"thought":"Okay,"}}"#;
        assert_eq!(parse_chunk(raw), chunk("", "Okay,"));
    }

    #[test]
    fn an_answer_chunk_carries_its_contents_as_text() {
        let raw = r#"{"role":"assistant","content":[{"type":"text","text":"Yes."}]}"#;
        assert_eq!(parse_chunk(raw), chunk("Yes.", ""));
    }

    #[test]
    fn a_chunk_with_both_keeps_the_thought_and_the_text() {
        let raw = r#"{"role":"assistant","content":[{"type":"text","text":"Yes."}],"channels":{"thought":"Done."}}"#;
        assert_eq!(parse_chunk(raw), chunk("Yes.", "Done."));
    }

    #[test]
    fn an_empty_chunk_adds_nothing() {
        assert_eq!(parse_chunk(""), chunk("", ""));
        assert_eq!(parse_chunk(r#"{"role":"assistant"}"#), chunk("", ""));
    }

    #[test]
    fn content_given_as_a_plain_string_is_the_text() {
        assert_eq!(parse_chunk(r#"{"content":"Hi"}"#), chunk("Hi", ""));
    }

    #[test]
    fn the_text_parts_of_the_content_are_joined_and_other_parts_dropped() {
        let raw = r#"{"content":[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]}"#;
        assert_eq!(parse_chunk(raw), chunk("ab", ""));
    }

    #[test]
    fn text_that_is_not_json_is_plain_text() {
        assert_eq!(parse_chunk("Hello"), chunk("Hello", ""));
        assert_eq!(parse_chunk("[1,2]"), chunk("[1,2]", ""));
    }
}
