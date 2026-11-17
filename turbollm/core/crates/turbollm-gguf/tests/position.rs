//! File positions above Number.MAX_SAFE_INTEGER (declared divergence D-5): the TypeScript engine's file reads
//! throw there, so the core reports an I/O failure, and the cut-short check gives no verdict.

use std::fs;
use std::path::PathBuf;

use turbollm_gguf::{MAX_HEADER_READ, is_cut_short, parse_file};

const GGUF_MAGIC: &[u8] = b"GGUF";
const STRING_TYPE: u32 = 8;
const LARGEST_EXACT_POSITION: u64 = (1 << 53) - 1;

/// A GGUF with two KV pairs whose first string value claims a length that moves the parse to `position`.
fn header_skipping_to(position: u64) -> Vec<u8> {
    let mut bytes = GGUF_MAGIC.to_vec();
    bytes.extend_from_slice(&3u32.to_le_bytes());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(&2u64.to_le_bytes());
    bytes.extend_from_slice(&1u64.to_le_bytes());
    bytes.push(b'a');
    bytes.extend_from_slice(&STRING_TYPE.to_le_bytes());
    let value_start = bytes.len() as u64 + 8;
    bytes.extend_from_slice(&(position - value_start).to_le_bytes());
    bytes
}

fn written(name: &str, position: u64) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("position-{name}.gguf"));
    fs::write(&path, header_skipping_to(position)).unwrap();
    path
}

#[test]
fn a_header_reaching_past_the_largest_exact_position_is_an_io_failure() {
    for (name, position) in [
        ("2p53", 1 << 53),
        ("2p53-plus-1", (1 << 53) + 1),
        ("2p63", 1 << 63),
    ] {
        let path = written(name, position);
        let error = parse_file(&path, MAX_HEADER_READ).unwrap_err();
        let cut_short = is_cut_short(&path, 41);
        fs::remove_file(&path).unwrap();
        assert_eq!(
            (error.code(), error.to_string().as_str()),
            ("io", "position out of range"),
            "{name}"
        );
        assert!(!cut_short, "{name} gave a cut-short verdict");
    }
}

#[test]
fn a_header_reaching_exactly_the_largest_exact_position_is_cut_short() {
    let path = written("2p53-minus-1", LARGEST_EXACT_POSITION);
    let error = parse_file(&path, MAX_HEADER_READ).unwrap_err();
    let cut_short = is_cut_short(&path, 41);
    fs::remove_file(&path).unwrap();
    assert_eq!(error.code(), "truncated");
    assert!(cut_short);
}
