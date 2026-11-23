//! GGUF headers for the context-size cases, written by the test (no committed fixture). The byte
//! layout is `turbollm-gguf`'s test builder (`crates/turbollm-gguf/tests/support/builders.rs`
//! `header`, `length_prefixed`, `typed`, `string_value`, `u32_value`), which that crate keeps private.

use std::path::{Path, PathBuf};

const GGUF_MAGIC: u32 = 0x4655_4747;
const GGUF_VERSION: u32 = 3;
const T_UINT32: u32 = 4;
const T_STRING: u32 = 8;

/// A GGUF header with no tensors: `general.architecture = qwen3`, then each `(key, value)`.
pub fn header_with_contexts(context_lengths: &[(&str, u32)]) -> Vec<u8> {
    let mut kvs = vec![("general.architecture".to_owned(), string_value("qwen3"))];
    kvs.extend(
        context_lengths
            .iter()
            .map(|(key, length)| ((*key).to_owned(), u32_value(*length))),
    );
    header(&kvs)
}

/// A model file in `dir` whose header says `qwen3.context_length = <length>`.
pub fn model_trained_at(dir: &Path, name: &str, length: u32) -> PathBuf {
    write(
        dir,
        name,
        &header_with_contexts(&[("qwen3.context_length", length)]),
    )
}

pub fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("the test folder is writable");
    path
}

fn header(kvs: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(GGUF_MAGIC.to_le_bytes());
    out.extend(GGUF_VERSION.to_le_bytes());
    out.extend(0u64.to_le_bytes());
    out.extend((kvs.len() as u64).to_le_bytes());
    for (key, value) in kvs {
        out.extend(length_prefixed(key.as_bytes()));
        out.extend(value);
    }
    out
}

fn length_prefixed(body: &[u8]) -> Vec<u8> {
    let mut out = (body.len() as u64).to_le_bytes().to_vec();
    out.extend(body);
    out
}

fn typed(value_type: u32, payload: Vec<u8>) -> Vec<u8> {
    let mut out = value_type.to_le_bytes().to_vec();
    out.extend(payload);
    out
}

fn string_value(text: &str) -> Vec<u8> {
    typed(T_STRING, length_prefixed(text.as_bytes()))
}

fn u32_value(number: u32) -> Vec<u8> {
    typed(T_UINT32, number.to_le_bytes().to_vec())
}
