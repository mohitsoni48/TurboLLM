//! ECMAScript number semantics the TypeScript engine relies on, reproduced exactly so the
//! Rust port gives byte-identical answers (ADR-465, B-10).

use std::ops::RangeInclusive;

/// ECMAScript `ToNumber` applied to a string (`Number(text)` in JavaScript).
pub fn to_number(text: &str) -> f64 {
    let literal = text.trim_matches(is_ecmascript_whitespace);
    if literal.is_empty() {
        return 0.0;
    }
    radix_integer_value(literal)
        .or_else(|| decimal_value(literal))
        .unwrap_or(f64::NAN)
}

/// ECMAScript `ToInt32` (`number | 0` in JavaScript).
pub fn to_int32(number: f64) -> i32 {
    if !number.is_finite() {
        return 0;
    }
    let wrapped = number.trunc().rem_euclid(TWO_TO_THE_32);
    if wrapped >= TWO_TO_THE_31 {
        (wrapped - TWO_TO_THE_32) as i32
    } else {
        wrapped as i32
    }
}

/// ECMAScript `Number::toString` (`String(number)` in JavaScript).
pub fn number_to_string(number: f64) -> String {
    ryu_js::Buffer::new().format(number).to_owned()
}

const TWO_TO_THE_31: f64 = 2_147_483_648.0;
const TWO_TO_THE_32: f64 = 4_294_967_296.0;
const F64_SIGNIFICAND_BITS: u32 = 53;

/// WhiteSpace and LineTerminator code points (ECMA-262 12.2, 12.3); narrower than
/// `char::is_whitespace`, which also accepts U+0085 and rejects U+FEFF.
fn is_ecmascript_whitespace(c: char) -> bool {
    ECMASCRIPT_WHITESPACE.contains(&c) || UNICODE_EN_QUAD_TO_HAIR_SPACE.contains(&c)
}

const ECMASCRIPT_WHITESPACE: [char; 14] = [
    '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}',
    '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
];
const UNICODE_EN_QUAD_TO_HAIR_SPACE: RangeInclusive<char> = '\u{2000}'..='\u{200a}';

/// `0x`/`0o`/`0b` NonDecimalIntegerLiteral; JavaScript allows no sign in front of it.
fn radix_integer_value(literal: &str) -> Option<f64> {
    let bits_per_digit = match literal.get(..2)? {
        "0x" | "0X" => 4,
        "0o" | "0O" => 3,
        "0b" | "0B" => 1,
        _ => return None,
    };
    let digits = &literal[2..];
    if digits.is_empty() {
        return None;
    }
    let radix = 1u32 << bits_per_digit;
    let digit_values: Option<Vec<u64>> = digits
        .chars()
        .map(|c| c.to_digit(radix).map(u64::from))
        .collect();
    Some(power_of_two_radix_value(&digit_values?, bits_per_digit))
}

/// Value of a base-2^k digit string, rounded to the nearest double with ties to even.
/// Digits are kept while they fit in 64 bits; later digits only scale the value and feed
/// the sticky bit, so any length rounds correctly.
fn power_of_two_radix_value(digit_values: &[u64], bits_per_digit: u32) -> f64 {
    let mut significand: u64 = 0;
    let mut dropped_bits: i32 = 0;
    let mut dropped_nonzero = false;
    for &digit in digit_values {
        if significand >> (u64::BITS - bits_per_digit) == 0 {
            significand = significand << bits_per_digit | digit;
        } else {
            dropped_bits += bits_per_digit as i32;
            dropped_nonzero |= digit != 0;
        }
    }
    let (rounded, shift) = round_to_double_precision(significand, dropped_nonzero);
    rounded as f64 * 2f64.powi(shift as i32 + dropped_bits)
}

/// Rounds `significand` to 53 significant bits (ties to even, `sticky` = nonzero bits
/// already discarded below it). Returns the rounded value and how many bits it was shifted.
fn round_to_double_precision(significand: u64, sticky: bool) -> (u64, u32) {
    let significant_bits = u64::BITS - significand.leading_zeros();
    if significant_bits <= F64_SIGNIFICAND_BITS {
        return (significand, 0);
    }
    let shift = significant_bits - F64_SIGNIFICAND_BITS;
    let kept = significand >> shift;
    let remainder = significand & ((1u64 << shift) - 1);
    let half = 1u64 << (shift - 1);
    let rounds_up = remainder > half || (remainder == half && (sticky || kept & 1 == 1));
    (kept + u64::from(rounds_up), shift)
}

/// StrDecimalLiteral: optional sign, then `Infinity` or a decimal with optional exponent.
/// The grammar is checked first because `str::parse` also accepts `inf`, `nan` and others.
fn decimal_value(literal: &str) -> Option<f64> {
    let unsigned = literal.strip_prefix(['+', '-']).unwrap_or(literal);
    if unsigned == "Infinity" {
        let infinity = if literal.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
        return Some(infinity);
    }
    if !is_unsigned_decimal_literal(unsigned) {
        return None;
    }
    literal.parse().ok()
}

fn is_unsigned_decimal_literal(text: &str) -> bool {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    is_decimal_mantissa(mantissa) && exponent.is_none_or(is_signed_digit_run)
}

fn is_decimal_mantissa(mantissa: &str) -> bool {
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let has_a_digit = !whole.is_empty() || !fraction.is_empty();
    has_a_digit && is_digit_run_or_empty(whole) && is_digit_run_or_empty(fraction)
}

fn is_signed_digit_run(text: &str) -> bool {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    !digits.is_empty() && is_digit_run_or_empty(digits)
}

fn is_digit_run_or_empty(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_same_number(text: &str, expected: f64) {
        let actual = to_number(text);
        assert!(
            actual.to_bits() == expected.to_bits() || (actual.is_nan() && expected.is_nan()),
            "to_number({text:?}) = {actual:?}, expected {expected:?}"
        );
    }

    #[test]
    fn to_number_treats_blank_text_as_zero() {
        assert_same_number("", 0.0);
        assert_same_number("   ", 0.0);
    }

    #[test]
    fn to_number_trims_the_ecmascript_whitespace_set() {
        assert_same_number("  15 ", 15.0);
        assert_same_number("\u{a0}15\u{2028}", 15.0);
        assert_same_number("\u{feff}15\u{2029}", 15.0);
        assert_same_number("\t\n\u{b}\u{c}\r 7", 7.0);
        assert_same_number(" \u{3000}\u{2000}\u{200a}\u{205f}\u{1680}\u{202f} 3", 3.0);
    }

    #[test]
    fn to_number_does_not_trim_whitespace_outside_the_ecmascript_set() {
        assert_same_number("\u{85}1", f64::NAN);
        assert_same_number("\u{180e}1", f64::NAN);
    }

    #[test]
    fn to_number_reads_radix_prefixed_integers() {
        assert_same_number("0x0F", 15.0);
        assert_same_number("0X1f", 31.0);
        assert_same_number("0o17", 15.0);
        assert_same_number("0b1111", 15.0);
    }

    #[test]
    fn to_number_rejects_malformed_or_signed_radix_literals() {
        assert_same_number("0x", f64::NAN);
        assert_same_number("+0x1", f64::NAN);
        assert_same_number("-0x1", f64::NAN);
        assert_same_number("0B2", f64::NAN);
    }

    #[test]
    fn to_number_rounds_long_hex_literals_to_nearest_even() {
        assert_same_number("0x1fffffffffffff1", 144_115_188_075_855_860.0);
        assert_same_number("0x20000000000001", 9_007_199_254_740_992.0);
        assert_same_number("0x20000000000003", 9_007_199_254_740_996.0);
        assert_same_number(
            "0x200000000000010000000000000000001",
            2f64.powi(129) + 2f64.powi(77),
        );
    }

    #[test]
    fn to_number_reads_decimal_literals() {
        assert_same_number("1.5", 1.5);
        assert_same_number("1e3", 1000.0);
        assert_same_number(".5", 0.5);
        assert_same_number("5.", 5.0);
        assert_same_number("-.5e-1", -0.05);
        assert_same_number("1e400", f64::INFINITY);
    }

    #[test]
    fn to_number_keeps_the_sign_of_negative_zero() {
        let negative_zero = to_number("-0");
        assert_eq!(negative_zero, 0.0);
        assert!(negative_zero.is_sign_negative());
    }

    #[test]
    fn to_number_reads_signed_infinity() {
        assert_same_number("Infinity", f64::INFINITY);
        assert_same_number("+Infinity", f64::INFINITY);
        assert_same_number("-Infinity", f64::NEG_INFINITY);
    }

    #[test]
    fn to_number_rejects_text_that_is_not_a_string_numeric_literal() {
        for text in [
            "15px", "inf", "nan", "NaN", "infinity", "1_000", "1e", ".", "e5", "-", "+",
        ] {
            assert_same_number(text, f64::NAN);
        }
    }

    #[test]
    fn to_int32_wraps_modulo_two_to_the_32() {
        assert_eq!(to_int32(4_294_967_296.0), 0);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
        assert_eq!(to_int32(-2_147_483_649.0), 2_147_483_647);
        assert_eq!(to_int32(12_884_901_889.5), 1);
    }

    #[test]
    fn to_int32_truncates_toward_zero() {
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(3.0), 3);
        assert_eq!(to_int32(-0.0), 0);
    }

    #[test]
    fn to_int32_maps_non_finite_numbers_to_zero() {
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
        assert_eq!(to_int32(f64::NEG_INFINITY), 0);
    }

    #[test]
    fn number_to_string_matches_ecmascript_output() {
        let cases: [(f64, &str); 12] = [
            (0.1, "0.1"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (f64::NAN, "NaN"),
            (4096.0, "4096"),
            (f64::NEG_INFINITY, "-Infinity"),
            (1e-6, "0.000001"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (-1.5, "-1.5"),
        ];
        for (number, expected) in cases {
            assert_eq!(
                number_to_string(number),
                expected,
                "number_to_string({number:?})"
            );
        }
    }
}
