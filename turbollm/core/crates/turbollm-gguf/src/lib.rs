//! The `gguf.ts:N` / `gguf.test.ts:N` references in this crate point at the TypeScript parser in `turbollm/src/gguf/`
//! as of commit `0ad9f454`, deleted by ADR-465 (recover it with `git show 0ad9f454:turbollm/src/gguf/gguf.ts`).

mod error;
mod jsnum;
mod meta;
mod parse;
mod quant;
mod reader;
mod source;
mod tensors;
mod value;

use std::fs::File;
use std::path::Path;

use reader::Reader;

pub use error::GgufError;
pub use meta::GgufMeta;
pub use quant::quant_from_name;
pub use source::ReadAt;

pub const MAX_HEADER_READ: u64 = 256 * 1024 * 1024;

/// Parses the GGUF header from `src`, reading at most `max_read` bytes of it.
pub fn parse<R: ReadAt>(src: R, max_read: u64) -> Result<GgufMeta, GgufError> {
    parse::parse_header(&mut Reader::new(src, max_read))
}

/// Parses the header of the GGUF at `path`, reading at most `max_read` bytes of it.
pub fn parse_file(path: &Path, max_read: u64) -> Result<GgufMeta, GgufError> {
    parse(File::open(path)?, max_read)
}

/// True when the GGUF at `path`, `size` bytes long, is cut short: its header ends before its tensor infos do,
/// or its tensors reach past `size` (`ggufCutShort`, `gguf.ts:514-520`). Any other failure is no verdict.
pub fn is_cut_short(path: &Path, size: u64) -> bool {
    match cut_short_parse(path) {
        Ok(meta) => meta.data_end > size,
        Err(error) => matches!(error, GgufError::Truncated),
    }
}

fn cut_short_parse(path: &Path) -> Result<GgufMeta, GgufError> {
    let file = File::open(path)?;
    parse::parse_header(&mut Reader::rereading_at_end(file, MAX_HEADER_READ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_read_budget_is_256_mib() {
        assert_eq!(MAX_HEADER_READ, 268_435_456);
    }
}
