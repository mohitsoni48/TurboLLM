//! One request as LiteRT-LM takes it (`LiteRtMessages.kt`): a fresh conversation seeded with the
//! system instruction and the history, to which the last user turn is then sent.

use serde_json::{Value, json};
use turbollm_engine::{
    ChatMessage, EngineError, GenerationParams, InvalidReason, MessageContent, Role,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiteRtRole {
    User,
    Model,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiteRtTurn {
    pub role: LiteRtRole,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LiteRtSampler {
    pub top_k: i32,
    pub top_p: f32,
    pub temperature: f32,
    pub seed: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LiteRtPrompt {
    pub system_instruction: Option<String>,
    pub history: Vec<LiteRtTurn>,
    pub user_turn: String,
    pub sampler: LiteRtSampler,
    pub max_output_tokens: Option<u32>,
    pub enable_thinking: bool,
}

const SYSTEM_SEPARATOR: &str = "

";
const DEFAULT_SAMPLER: LiteRtSampler = LiteRtSampler {
    top_k: 40,
    top_p: 0.95,
    temperature: 0.8,
    seed: 0,
};

impl LiteRtPrompt {
    /// `InvalidRequest` unless the final message is the user's: that is the turn LiteRT answers.
    pub fn of(
        messages: &[ChatMessage],
        params: &GenerationParams,
    ) -> Result<LiteRtPrompt, EngineError> {
        let (last, earlier) = match messages.split_last() {
            Some((last, earlier)) if last.role == Role::User => (last, earlier),
            _ => return Err(last_turn_not_from_user()),
        };
        Ok(LiteRtPrompt {
            system_instruction: system_instruction_of(earlier),
            history: earlier.iter().filter_map(turn_of).collect(),
            user_turn: text_of(last),
            sampler: sampler_of(params),
            max_output_tokens: params.max_tokens,
            enable_thinking: params.enable_thinking,
        })
    }

    /// The messages the conversation is created with (system first, then the history), as the
    /// JSON array the C API takes, or `None` when there are none.
    pub fn context_messages_json(&self) -> Option<String> {
        let system = self
            .system_instruction
            .iter()
            .map(|text| message_json("system", text));
        let history = self.history.iter().map(|turn| {
            let role = match turn.role {
                LiteRtRole::User => "user",
                LiteRtRole::Model => "assistant",
            };
            message_json(role, &turn.text)
        });
        let messages: Vec<Value> = system.chain(history).collect();
        (!messages.is_empty()).then(|| Value::Array(messages).to_string())
    }

    /// The final user turn as the message JSON the C API sends.
    pub fn user_message_json(&self) -> String {
        message_json("user", &self.user_turn).to_string()
    }
}

fn last_turn_not_from_user() -> EngineError {
    EngineError::InvalidRequest {
        param: Some("messages".to_owned()),
        reason: InvalidReason::InvalidLastMessage,
        message: "The last message must come from the user for a LiteRT-LM model.".to_owned(),
    }
}

fn system_instruction_of(messages: &[ChatMessage]) -> Option<String> {
    let instruction = messages
        .iter()
        .filter(|message| message.role == Role::System)
        .map(text_of)
        .collect::<Vec<_>>()
        .join(SYSTEM_SEPARATOR);
    (!instruction.is_empty()).then_some(instruction)
}

fn turn_of(message: &ChatMessage) -> Option<LiteRtTurn> {
    let role = match message.role {
        Role::System => return None,
        Role::User => LiteRtRole::User,
        Role::Assistant => LiteRtRole::Model,
    };
    Some(LiteRtTurn {
        role,
        text: text_of(message),
    })
}

fn sampler_of(params: &GenerationParams) -> LiteRtSampler {
    LiteRtSampler {
        top_k: params.top_k.unwrap_or(DEFAULT_SAMPLER.top_k),
        top_p: params.top_p.unwrap_or(DEFAULT_SAMPLER.top_p),
        temperature: params.temperature.unwrap_or(DEFAULT_SAMPLER.temperature),
        // `Long.toInt()` in the Kotlin: the low 32 bits.
        seed: params.seed.map_or(DEFAULT_SAMPLER.seed, |seed| seed as i32),
    }
}

/// The chat layer has already refused every non-text part, so only text remains to join.
fn text_of(message: &ChatMessage) -> String {
    match &message.content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Parts(parts) => parts.concat(),
    }
}

fn message_json(role: &str, text: &str) -> Value {
    json!({"role": role, "content": text})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: Role, text: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: MessageContent::Text(text.to_owned()),
        }
    }
    fn system(text: &str) -> ChatMessage {
        message(Role::System, text)
    }
    fn user(text: &str) -> ChatMessage {
        message(Role::User, text)
    }
    fn assistant(text: &str) -> ChatMessage {
        message(Role::Assistant, text)
    }

    fn unset() -> GenerationParams {
        GenerationParams {
            enable_thinking: true,
            ..GenerationParams::default()
        }
    }

    fn prompt(messages: &[ChatMessage]) -> LiteRtPrompt {
        LiteRtPrompt::of(messages, &unset()).expect("a prompt")
    }

    fn turn(role: LiteRtRole, text: &str) -> LiteRtTurn {
        LiteRtTurn {
            role,
            text: text.to_owned(),
        }
    }

    #[test]
    fn every_system_message_is_joined_into_the_system_instruction() {
        let prompt = prompt(&[
            system("Be brief."),
            user("Hi"),
            system("Answer in French."),
            user("Name a colour."),
        ]);
        assert_eq!(
            prompt.system_instruction.as_deref(),
            Some("Be brief.\n\nAnswer in French.")
        );
    }

    #[test]
    fn a_conversation_without_a_system_message_has_no_system_instruction() {
        assert_eq!(prompt(&[user("Hi")]).system_instruction, None);
    }

    #[test]
    fn every_turn_before_the_final_user_turn_is_its_history_in_order() {
        let prompt = prompt(&[
            system("Be brief."),
            user("First?"),
            assistant("One."),
            user("Second?"),
        ]);
        assert_eq!(
            prompt.history,
            vec![
                turn(LiteRtRole::User, "First?"),
                turn(LiteRtRole::Model, "One.")
            ]
        );
        assert_eq!(prompt.user_turn, "Second?");
    }

    #[test]
    fn the_text_parts_of_a_message_are_joined() {
        let parts = ChatMessage {
            role: Role::User,
            content: MessageContent::Parts(vec!["Hello, ".to_owned(), "world".to_owned()]),
        };
        assert_eq!(prompt(&[parts]).user_turn, "Hello, world");
    }

    #[test]
    fn a_final_turn_from_the_assistant_is_refused_as_an_invalid_last_message() {
        let failure =
            LiteRtPrompt::of(&[user("Hi"), assistant("Hello")], &unset()).expect_err("refused");
        assert_eq!(
            failure,
            EngineError::InvalidRequest {
                param: Some("messages".to_owned()),
                reason: InvalidReason::InvalidLastMessage,
                message: "The last message must come from the user for a LiteRT-LM model."
                    .to_owned(),
            }
        );
    }

    #[test]
    fn a_final_system_turn_is_refused_as_an_invalid_last_message() {
        let failure =
            LiteRtPrompt::of(&[user("Hi"), system("Be brief.")], &unset()).expect_err("refused");
        assert!(matches!(
            failure,
            EngineError::InvalidRequest {
                reason: InvalidReason::InvalidLastMessage,
                ..
            }
        ));
    }

    #[test]
    fn no_messages_are_refused_as_an_invalid_last_message() {
        assert!(LiteRtPrompt::of(&[], &unset()).is_err());
    }

    #[test]
    fn unset_sampling_parameters_use_the_litert_defaults() {
        assert_eq!(
            prompt(&[user("Hi")]).sampler,
            LiteRtSampler {
                top_k: 40,
                top_p: 0.95,
                temperature: 0.8,
                seed: 0
            }
        );
    }

    #[test]
    fn set_sampling_parameters_are_passed_through() {
        let params = GenerationParams {
            temperature: Some(0.25),
            top_p: Some(0.5),
            top_k: Some(5),
            seed: Some(7),
            ..unset()
        };
        let prompt = LiteRtPrompt::of(&[user("Hi")], &params).expect("a prompt");
        assert_eq!(
            prompt.sampler,
            LiteRtSampler {
                top_k: 5,
                top_p: 0.5,
                temperature: 0.25,
                seed: 7
            }
        );
    }

    #[test]
    fn the_max_tokens_become_the_max_output_tokens() {
        let capped = GenerationParams {
            max_tokens: Some(16),
            ..unset()
        };
        assert_eq!(
            LiteRtPrompt::of(&[user("Hi")], &capped)
                .expect("a prompt")
                .max_output_tokens,
            Some(16)
        );
        assert_eq!(prompt(&[user("Hi")]).max_output_tokens, None);
    }

    #[test]
    fn a_request_that_turns_thinking_off_asks_litert_for_no_thinking() {
        let off = GenerationParams {
            enable_thinking: false,
            ..unset()
        };
        let prompt = LiteRtPrompt::of(&[user("Hi")], &off).expect("a prompt");
        assert!(!prompt.enable_thinking);
    }

    #[test]
    fn thinking_stays_on_unless_the_request_turns_it_off() {
        assert!(prompt(&[user("Hi")]).enable_thinking);
    }

    fn parsed(json: &str) -> Value {
        serde_json::from_str(json).expect("valid JSON")
    }

    #[test]
    fn the_context_is_the_system_message_then_the_history_as_openai_messages() {
        let prompt = prompt(&[
            system("Be brief."),
            user("First?"),
            assistant("One."),
            user("Second?"),
        ]);
        assert_eq!(
            parsed(&prompt.context_messages_json().expect("a context")),
            json!([
                {"role": "system", "content": "Be brief."},
                {"role": "user", "content": "First?"},
                {"role": "assistant", "content": "One."}
            ])
        );
    }

    #[test]
    fn a_single_user_turn_has_no_context() {
        assert_eq!(prompt(&[user("Hi")]).context_messages_json(), None);
    }

    #[test]
    fn the_user_turn_is_sent_as_one_user_message() {
        assert_eq!(
            parsed(&prompt(&[user("Hi \"there\"\n")]).user_message_json()),
            json!({"role": "user", "content": "Hi \"there\"\n"})
        );
    }
}
