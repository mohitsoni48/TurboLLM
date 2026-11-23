//! Port of `Utf8StreamDecoder.kt`: token bytes become text without splitting a character across tokens.

/// Holds back the bytes of a character a token left unfinished. An invalid byte becomes U+FFFD.
/// One per reply, used on the engine thread.
#[derive(Debug, Default)]
pub struct Utf8Completion {
    held_back: Vec<u8>,
}

impl Utf8Completion {
    /// Whether these bytes completed at least one character, so the reply is worth a parse
    /// (`LlamaReply.kt:86-90`).
    pub fn push(&mut self, bytes: &[u8]) -> bool {
        !self.decode(bytes).is_empty()
    }

    /// Text for every complete character so far; a trailing partial character is kept for later.
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        self.held_back.extend_from_slice(bytes);
        let pending = std::mem::take(&mut self.held_back);
        let (text, unfinished) = decode_complete_characters(&pending);
        self.held_back = unfinished.to_vec();
        text
    }

    /// Ends the stream: a held-back partial character becomes U+FFFD, and the decoder starts clean.
    pub fn flush(&mut self) -> String {
        let unfinished = std::mem::take(&mut self.held_back);
        String::from_utf8_lossy(&unfinished).into_owned()
    }
}

const REPLACEMENT: char = '\u{FFFD}';

/// The text of every complete character in `bytes`, and the bytes of an unfinished last one.
fn decode_complete_characters(mut bytes: &[u8]) -> (String, &[u8]) {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(bytes) {
            Ok(complete) => {
                text.push_str(complete);
                return (text, &[]);
            }
            Err(error) => {
                let (valid, rest) = bytes.split_at(error.valid_up_to());
                text.push_str(&String::from_utf8_lossy(valid));
                let Some(invalid_len) = error.error_len() else {
                    return (text, rest);
                };
                text.push(REPLACEMENT);
                bytes = &rest[invalid_len..];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passes_straight_through() {
        assert_eq!(Utf8Completion::default().decode(b"hello"), "hello");
    }

    #[test]
    fn a_two_byte_character_split_at_every_boundary_reassembles_exactly() {
        assert_every_split_reassembles("aé");
    }

    #[test]
    fn a_three_byte_character_split_at_every_boundary_reassembles_exactly() {
        assert_every_split_reassembles("a€b");
    }

    #[test]
    fn a_four_byte_character_split_at_every_boundary_reassembles_exactly() {
        assert_every_split_reassembles("x😀y");
    }

    #[test]
    fn a_character_fed_one_byte_at_a_time_appears_only_when_complete() {
        let mut decoder = Utf8Completion::default();

        let pieces: Vec<String> = "😀".bytes().map(|byte| decoder.decode(&[byte])).collect();

        assert_eq!(pieces, ["", "", "", "😀"]);
    }

    #[test]
    fn an_invalid_byte_becomes_a_replacement_character() {
        assert_eq!(
            Utf8Completion::default().decode(&[b'a', 0xFF, b'b']),
            "a\u{FFFD}b"
        );
    }

    #[test]
    fn a_lead_byte_followed_by_ascii_becomes_a_replacement_character_and_keeps_the_ascii() {
        assert_eq!(Utf8Completion::default().decode(&[0xE2, b'A']), "\u{FFFD}A");
    }

    #[test]
    fn an_incomplete_sequence_left_at_the_end_is_flushed_as_a_replacement_character() {
        let mut decoder = Utf8Completion::default();

        decoder.decode(&"€".as_bytes()[..2]);

        assert_eq!(decoder.flush(), "\u{FFFD}");
    }

    #[test]
    fn flushing_after_complete_text_gives_nothing_and_the_decoder_starts_clean() {
        let mut decoder = Utf8Completion::default();
        decoder.decode(&[0xF0]);
        decoder.flush();

        assert_eq!(decoder.flush(), "");
        assert_eq!(decoder.decode(b"ok"), "ok");
    }

    #[test]
    fn a_token_completes_a_character_only_when_its_last_byte_arrives() {
        let mut decoder = Utf8Completion::default();
        let emoji = "😀".as_bytes();

        assert!(!decoder.push(&emoji[..2]));
        assert!(decoder.push(&emoji[2..]));
    }

    #[test]
    fn an_invalid_byte_counts_as_a_completed_character() {
        assert!(Utf8Completion::default().push(&[0xFF]));
    }

    #[test]
    fn split_emoji_and_cjk_pieces_concatenate_to_the_input_without_replacement_characters() {
        let text = "思😀考";
        let bytes = text.as_bytes();
        let mut decoder = Utf8Completion::default();

        let joined: String = bytes.chunks(2).map(|piece| decoder.decode(piece)).collect();

        assert_eq!(joined + &decoder.flush(), text);
    }

    fn assert_every_split_reassembles(text: &str) {
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut decoder = Utf8Completion::default();

            let joined = decoder.decode(&bytes[..cut]) + &decoder.decode(&bytes[cut..]);

            assert_eq!(joined + &decoder.flush(), text, "split at byte {cut}");
        }
    }
}
