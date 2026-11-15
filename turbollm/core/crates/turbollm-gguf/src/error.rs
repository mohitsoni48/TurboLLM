//! The header parser's failures, with the exact codes and messages of the TypeScript `GgufError`
//! (`gguf.ts:7-15`) so every binding reports what the TypeScript engine reported.

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum GgufError {
    #[error("Not a GGUF file.")]
    NotGguf,
    #[error("Unsupported GGUF version {0}.")]
    BadVersion(u32),
    #[error("Unexpected EOF in GGUF header.")]
    Truncated,
    #[error("Unknown GGUF value type {0}.")]
    BadType(u32),
    #[error("GGUF header is too large to read.")]
    TooLarge,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl GgufError {
    /// The stable code every binding reports (the TypeScript `GgufError.code`).
    pub fn code(&self) -> &'static str {
        match self {
            GgufError::NotGguf => "not_gguf",
            GgufError::BadVersion(_) => "bad_version",
            GgufError::Truncated => "truncated",
            GgufError::BadType(_) => "bad_type",
            GgufError::TooLarge => "too_large",
            GgufError::Io(_) => "io",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_reported(error: GgufError, code: &str, message: &str) {
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), message);
    }

    #[test]
    fn not_gguf_matches_the_typescript_text() {
        assert_reported(GgufError::NotGguf, "not_gguf", "Not a GGUF file.");
    }

    #[test]
    fn bad_version_names_the_version() {
        assert_reported(
            GgufError::BadVersion(7),
            "bad_version",
            "Unsupported GGUF version 7.",
        );
    }

    #[test]
    fn truncated_matches_the_typescript_text() {
        assert_reported(
            GgufError::Truncated,
            "truncated",
            "Unexpected EOF in GGUF header.",
        );
    }

    #[test]
    fn bad_type_names_the_type() {
        assert_reported(
            GgufError::BadType(13),
            "bad_type",
            "Unknown GGUF value type 13.",
        );
    }

    #[test]
    fn too_large_matches_the_typescript_text() {
        assert_reported(
            GgufError::TooLarge,
            "too_large",
            "GGUF header is too large to read.",
        );
    }

    #[test]
    fn io_reports_the_io_error_text() {
        let failure = io::Error::other("disk unplugged");
        assert_reported(GgufError::Io(failure), "io", "disk unplugged");
    }

    #[test]
    fn an_io_error_converts_into_the_io_variant() {
        let error: GgufError = io::Error::other("disk unplugged").into();
        assert_eq!(error.code(), "io");
    }
}
