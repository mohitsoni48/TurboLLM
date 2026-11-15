use std::sync::LazyLock;

use fancy_regex::{Captures, Regex, RegexBuilder};

static LLAMA_CPP_QUANT_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    compile_ascii_pattern(r"(?i)(?:^|[-_. ])(I?Q[0-9](?:_[A-Za-z0-9]+)*|BF16|F16|F32)(?=$|[-_. ])")
});

static APEX_TIER: LazyLock<Regex> = LazyLock::new(|| {
    compile_ascii_pattern(
        r"(?i)APEX(?:-[A-Za-z0-9]+){0,3}?-(I-)?(NANO|MINI|COMPACT|BALANCED|QUALITY)(?=\.|$|-)",
    )
});

const FILE_TYPE_QUANT_LABELS: [(u8, &str); 27] = [
    (0, "F32"),
    (1, "F16"),
    (2, "Q4_0"),
    (3, "Q4_1"),
    (7, "Q8_0"),
    (8, "Q5_0"),
    (9, "Q5_1"),
    (10, "Q2_K"),
    (11, "Q3_K_S"),
    (12, "Q3_K_M"),
    (13, "Q3_K_L"),
    (14, "Q4_K_S"),
    (15, "Q4_K_M"),
    (16, "Q5_K_S"),
    (17, "Q5_K_M"),
    (18, "Q6_K"),
    (19, "IQ2_XXS"),
    (20, "IQ2_XS"),
    (21, "Q2_K_S"),
    (22, "IQ3_XS"),
    (23, "IQ3_XXS"),
    (24, "IQ1_S"),
    (25, "IQ4_NL"),
    (26, "IQ3_S"),
    (27, "IQ3_M"),
    (28, "IQ4_XS"),
    (30, "BF16"),
];

const BOGUS_GENERAL_NAMES: [&str; 7] = [
    "safetensors",
    "gguf",
    "pytorch",
    "pytorch_model",
    "bin",
    "checkpoint",
    "onnx",
];

/// The quant label a file name declares, or `None` where TypeScript `quantFromName` returns `"?"`.
/// Patterns are ASCII-only on purpose: JS `/i` without `/u` never folds a non-ASCII character
/// (e.g. the Kelvin sign U+212A) onto an ASCII letter, and Unicode case folding would.
pub fn quant_from_name(file_name: &str) -> Option<String> {
    last_llama_cpp_quant_token(file_name).or_else(|| apex_tier_label(file_name))
}

/// The label `general.file_type` maps to, for a value already converted to a JS number.
pub fn ftype_quant_label(file_type: f64) -> Option<&'static str> {
    FILE_TYPE_QUANT_LABELS
        .iter()
        .find(|(code, _)| f64::from(*code) == file_type)
        .map(|(_, label)| *label)
}

/// True for a `general.name` that is a storage-format word rather than a model name (issue #165).
/// Lower-cases with full Unicode mapping like JS `toLowerCase`, so the Kelvin sign becomes `k`.
pub fn is_bogus_general_name(general_name: &str) -> bool {
    BOGUS_GENERAL_NAMES.contains(&general_name.to_lowercase().as_str())
}

fn last_llama_cpp_quant_token(file_name: &str) -> Option<String> {
    LLAMA_CPP_QUANT_TOKEN
        .captures_iter(file_name)
        .map(expect_complete_match)
        .last()
        .map(|token| token[1].to_ascii_uppercase())
}

fn apex_tier_label(file_name: &str) -> Option<String> {
    let tier = expect_complete_match(APEX_TIER.captures(file_name).transpose()?);
    let imatrix_prefix = if tier.get(1).is_some() { "I-" } else { "" };
    Some(format!(
        "APEX-{imatrix_prefix}{}",
        tier[2].to_ascii_uppercase()
    ))
}

fn expect_complete_match(result: fancy_regex::Result<Captures<'_, str>>) -> Captures<'_, str> {
    result.expect("quant patterns stay far inside the backtrack limit on any file name")
}

fn compile_ascii_pattern(pattern: &str) -> Regex {
    RegexBuilder::new(pattern)
        .unicode_mode(false)
        .build()
        .expect("quant pattern is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quant(file_name: &str) -> Option<String> {
        quant_from_name(file_name)
    }

    #[test]
    fn standard_token_before_the_extension_is_upper_cased() {
        assert_eq!(quant("model-q4_k_m.gguf").as_deref(), Some("Q4_K_M"));
    }

    #[test]
    fn last_delimited_token_wins_over_a_name_prefix() {
        assert_eq!(
            quant("Q2.5-Veltha-14B-Q4_K_M.gguf").as_deref(),
            Some("Q4_K_M")
        );
    }

    #[test]
    fn kelvin_sign_is_not_a_case_variant_of_k() {
        assert_eq!(quant("model-Q4_\u{212A}_M.gguf").as_deref(), Some("Q4"));
        assert_eq!(quant("\u{212A}x-Q4_\u{212A}.gguf").as_deref(), Some("Q4"));
    }

    #[test]
    fn non_ascii_letters_and_digits_never_match_ascii_patterns() {
        assert_eq!(quant("model-\u{131}q3_xs.gguf"), None);
        assert_eq!(quant("x-Q\u{664}.gguf"), None);
        assert_eq!(quant("model-apex-\u{17F}mall-mini.gguf"), None);
    }

    #[test]
    fn suffix_that_fails_the_delimiter_backtracks_to_the_shorter_token() {
        assert_eq!(quant("model-Q4_K_M_ab+.gguf").as_deref(), Some("Q4_K_M"));
        assert_eq!(quant("model-Q4_K_M_ab.gguf").as_deref(), Some("Q4_K_M_AB"));
    }

    #[test]
    fn apex_tier_with_and_without_imatrix() {
        assert_eq!(
            quant("Qwen3.6-35B-A3B-APEX-MTP-I-Quality.gguf").as_deref(),
            Some("APEX-I-QUALITY")
        );
        assert_eq!(quant("model-apex-mini.gguf").as_deref(), Some("APEX-MINI"));
    }

    #[test]
    fn unrecognised_name_has_no_quant() {
        assert_eq!(quant("random-model-name.gguf"), None);
    }

    #[test]
    fn file_type_codes_map_like_the_typescript_table() {
        assert_eq!(ftype_quant_label(0.0), Some("F32"));
        assert_eq!(ftype_quant_label(-0.0), Some("F32"));
        assert_eq!(ftype_quant_label(15.0), Some("Q4_K_M"));
        assert_eq!(ftype_quant_label(28.0), Some("IQ4_XS"));
        assert_eq!(ftype_quant_label(30.0), Some("BF16"));
    }

    #[test]
    fn file_type_codes_outside_the_table_have_no_label() {
        for code in [
            4.0,
            5.0,
            6.0,
            29.0,
            31.0,
            15.5,
            -1.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert_eq!(ftype_quant_label(code), None, "code {code}");
        }
    }

    #[test]
    fn storage_format_words_are_bogus_general_names() {
        for name in [
            "safetensors",
            "GGUF",
            "PyTorch",
            "pytorch_model",
            "bin",
            "checkpoint",
            "ONNX",
        ] {
            assert!(is_bogus_general_name(name), "{name}");
        }
    }

    #[test]
    fn kelvin_sign_lower_cases_into_a_bogus_name() {
        assert!(is_bogus_general_name("Chec\u{212A}point"));
    }

    #[test]
    fn real_model_names_are_not_bogus() {
        for name in ["Llama 3", "checkpoints", "gguf-model", ""] {
            assert!(!is_bogus_general_name(name), "{name}");
        }
    }
}
