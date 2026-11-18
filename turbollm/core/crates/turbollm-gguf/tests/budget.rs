//! The read-amount assertions of `gguf.test.ts` rows 31-33 (plan section 3): a huge value is skipped by seeking,
//! never read, and a header needing more than the budget stops within it. `gguf.ts:N` / `gguf.test.ts:N` point at the
//! deleted `turbollm/src/gguf/` as of commit `0ad9f454` (recover with `git show 0ad9f454:turbollm/src/gguf/gguf.ts`).

mod support;

use std::cell::Cell;
use std::fs;
use std::io;

use support::builders::generated_fixture;
use support::crafted_path;
use turbollm_gguf::{GgufError, MAX_HEADER_READ, ReadAt, parse};

const MIB: u64 = 1024 * 1024;
const SKIP_READ_LIMIT: u64 = 16 * MIB;

/// Bytes in memory that add up how many bytes each read asks for.
struct CountingBytes {
    bytes: Vec<u8>,
    requested: Cell<u64>,
}

impl CountingBytes {
    fn new(bytes: Vec<u8>) -> Self {
        CountingBytes {
            bytes,
            requested: Cell::new(0),
        }
    }
}

impl ReadAt for CountingBytes {
    fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize> {
        self.requested.set(self.requested.get() + into.len() as u64);
        self.bytes.as_slice().read_at(offset, into)
    }
}

// gguf.test.ts:608, row 31: a 40 MiB general.description is skipped by seeking.
#[test]
fn a_huge_string_value_is_skipped_without_reading_it() {
    let source = CountingBytes::new(generated_fixture("huge-description", &[40 * MIB]));
    let meta = parse(&source, MAX_HEADER_READ).expect("the header parses");
    assert_eq!(meta.block_count, 7);
    assert!(
        source.requested.get() <= SKIP_READ_LIMIT,
        "asked for {} bytes",
        source.requested.get()
    );
}

// gguf.test.ts:619, row 32: a 3 MiB general.name under a 1 MiB cap is too_large, reading at most the cap.
#[test]
fn a_header_needing_more_than_the_cap_is_too_large_within_the_cap() {
    let cap = MIB;
    let source = CountingBytes::new(generated_fixture("long-name", &[3 * MIB]));
    let outcome = parse(&source, cap);
    assert!(
        matches!(outcome, Err(GgufError::TooLarge)),
        "got {outcome:?}"
    );
    assert!(
        source.requested.get() <= cap,
        "asked for {} bytes",
        source.requested.get()
    );
}

// gguf.test.ts:632, row 33: a declared 20 GB string in a 120-byte file is truncated without asking for it.
#[test]
fn a_declared_huge_string_in_a_short_file_is_not_read() {
    let bytes = fs::read(crafted_path("declared-huge-string")).expect("crafted fixture");
    let source = CountingBytes::new(bytes);
    let outcome = parse(&source, MAX_HEADER_READ);
    assert!(
        matches!(outcome, Err(GgufError::Truncated)),
        "got {outcome:?}"
    );
    assert!(
        source.requested.get() <= SKIP_READ_LIMIT,
        "asked for {} bytes",
        source.requested.get()
    );
}
