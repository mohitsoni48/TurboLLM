//! Properties over random mutations of the crafted fixtures (plan T8): the parser never panics, never reads more
//! than its budget, and a budget too small to finish the parse shows only as `too_large`.

mod support;

use std::cell::Cell;
use std::fs;
use std::io;
use std::sync::LazyLock;

use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};
use support::{fixtures_dir, parse_text};
use turbollm_gguf::{GgufError, MAX_HEADER_READ, ReadAt, parse};

const CASES: u32 = 2_000;
const SEED: u64 = 0x7475_7262_6f6c_6c6d;
const SMALL_BUDGET_LIMIT: u64 = 128 * 1024;

static CRAFTED_FILES: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| {
    let crafted_dir = fixtures_dir().join("crafted");
    let mut paths: Vec<_> = fs::read_dir(crafted_dir)
        .expect("read the crafted folder")
        .map(|entry| entry.expect("crafted entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "gguf")
        })
        .collect();
    paths.sort();
    paths
        .iter()
        .map(|path| fs::read(path).expect("crafted fixture"))
        .collect()
});

#[derive(Debug, Clone)]
enum Mutation {
    FlipByte { at: usize, mask: u8 },
    CutAt { length: usize },
    OverwriteU64 { at: usize, value: u64 },
}

fn mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        (any::<usize>(), 1..=u8::MAX).prop_map(|(at, mask)| Mutation::FlipByte { at, mask }),
        any::<usize>().prop_map(|length| Mutation::CutAt { length }),
        (any::<usize>(), any::<u64>()).prop_map(|(at, value)| Mutation::OverwriteU64 { at, value }),
    ]
}

fn mutated_crafted_file() -> impl Strategy<Value = Vec<u8>> {
    let file = 0..CRAFTED_FILES.len();
    (file, prop::collection::vec(mutation(), 1..4)).prop_map(|(index, mutations)| {
        let mut bytes = CRAFTED_FILES[index].clone();
        for mutation in mutations {
            apply(&mut bytes, mutation);
        }
        bytes
    })
}

fn apply(bytes: &mut Vec<u8>, mutation: Mutation) {
    if bytes.is_empty() {
        return;
    }
    let len = bytes.len();
    match mutation {
        Mutation::FlipByte { at, mask } => bytes[at % len] ^= mask,
        Mutation::CutAt { length } => bytes.truncate(length % len),
        Mutation::OverwriteU64 { at, value } => {
            let at = at % len;
            let end = (at + 8).min(len);
            bytes[at..end].copy_from_slice(&value.to_le_bytes()[..end - at]);
        }
    }
}

fn budget() -> impl Strategy<Value = u64> {
    prop_oneof![0..=SMALL_BUDGET_LIMIT, Just(MAX_HEADER_READ)]
}

fn config() -> Config {
    Config {
        cases: CASES,
        rng_seed: RngSeed::Fixed(SEED),
        failure_persistence: None,
        ..Config::default()
    }
}

/// Bytes in memory that add up how many bytes they hand out.
struct CountingBytes<'a> {
    bytes: &'a [u8],
    delivered: Cell<u64>,
}

impl ReadAt for CountingBytes<'_> {
    fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize> {
        let got = self.bytes.read_at(offset, into)?;
        self.delivered.set(self.delivered.get() + got as u64);
        Ok(got)
    }
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn a_mutated_header_never_panics(bytes in mutated_crafted_file(), max_read in budget()) {
        let _ = parse(bytes.as_slice(), max_read);
    }

    #[test]
    fn the_bytes_read_never_exceed_the_budget(bytes in mutated_crafted_file(), max_read in budget()) {
        let source = CountingBytes { bytes: &bytes, delivered: Cell::new(0) };
        let _ = parse(&source, max_read);
        prop_assert!(source.delivered.get() <= max_read);
    }

    #[test]
    fn a_budget_too_small_for_the_parse_is_too_large(bytes in mutated_crafted_file(), max_read in budget()) {
        let budgeted = parse(bytes.as_slice(), max_read);
        let unhindered = parse(bytes.as_slice(), MAX_HEADER_READ);
        if !matches!(budgeted, Err(GgufError::TooLarge)) {
            prop_assert_eq!(parse_text(&budgeted), parse_text(&unhindered));
        }
    }
}
