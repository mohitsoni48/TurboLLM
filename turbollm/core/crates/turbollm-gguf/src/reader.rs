//! The buffered forward reader, a port of `BufReader` (`gguf.ts:206-268`) with the read budget of the async
//! window path (`gguf.ts:374-400`), so one reader makes the request sequence of both TypeScript paths.

use crate::error::GgufError;
use crate::source::ReadAt;
use std::io;

/// Bytes asked of the source per fill when the parse needs fewer (the TypeScript `chunk`, 4 MB).
const CHUNK: u64 = 4 * 1024 * 1024;

/// `Number.MAX_SAFE_INTEGER`: Node's file reads refuse a position above it, so the TypeScript engine fails there
/// (declared divergence D-5: same failure class, different text).
const LARGEST_EXACT_POSITION: u64 = (1 << 53) - 1;

fn position_out_of_range() -> GgufError {
    GgufError::Io(io::Error::new(
        io::ErrorKind::InvalidInput,
        "position out of range",
    ))
}

pub(crate) struct Reader<R> {
    source: R,
    buffer: Vec<u8>,
    position: usize,
    buffer_offset: u64,
    budget_left: u64,
    known_end: Option<u64>,
    answers_from_known_end: bool,
}

impl<R: ReadAt> Reader<R> {
    pub(crate) fn new(source: R, max_read: u64) -> Self {
        Reader {
            source,
            buffer: Vec::new(),
            position: 0,
            buffer_offset: 0,
            budget_left: max_read,
            known_end: None,
            answers_from_known_end: true,
        }
    }

    /// A reader with the request sequence of the synchronous `fdSource` path (`gguf.ts:165-170`), which
    /// `ggufCutShort` uses: a need at the known end of the source asks the source again, under the budget, where
    /// the async windows answer `truncated` from the window that reached the end.
    pub(crate) fn rereading_at_end(source: R, max_read: u64) -> Self {
        Reader {
            answers_from_known_end: false,
            ..Self::new(source, max_read)
        }
    }

    pub(crate) fn bytes(&mut self, n: u64) -> Result<&[u8], GgufError> {
        self.fill(n)?;
        let start = self.position;
        self.position += n as usize;
        Ok(&self.buffer[start..self.position])
    }

    pub(crate) fn u32(&mut self) -> Result<u32, GgufError> {
        let mut word = [0; 4];
        word.copy_from_slice(self.bytes(4)?);
        Ok(u32::from_le_bytes(word))
    }

    pub(crate) fn u64(&mut self) -> Result<u64, GgufError> {
        let mut word = [0; 8];
        word.copy_from_slice(self.bytes(8)?);
        Ok(u64::from_le_bytes(word))
    }

    /// Moves past `n` bytes. Past the buffer it drops the buffer and reads nothing: the bytes skipped are
    /// never asked of the source.
    pub(crate) fn skip(&mut self, n: u64) {
        if n <= self.buffered() {
            self.position += n as usize;
            return;
        }
        self.buffer_offset = self.offset().saturating_add(n);
        self.buffer.clear();
        self.position = 0;
    }

    /// Moves past `count` length-prefixed strings (an array's elements) without decoding them.
    pub(crate) fn skip_strings(&mut self, count: u64) -> Result<(), GgufError> {
        for _ in 0..count {
            let len = self.u64()?;
            self.skip(len);
        }
        Ok(())
    }

    /// The file offset of the next byte to read.
    pub(crate) fn offset(&self) -> u64 {
        self.buffer_offset.saturating_add(self.position as u64)
    }

    fn buffered(&self) -> u64 {
        (self.buffer.len() - self.position) as u64
    }

    fn fill(&mut self, need: u64) -> Result<(), GgufError> {
        if self.buffered() >= need {
            return Ok(());
        }
        let missing = need - self.buffered();
        let read_offset = self.buffer_offset.saturating_add(self.buffer.len() as u64);
        self.drop_consumed();
        if !self.answered_from_known_end(read_offset) {
            self.read_window(read_offset, missing)?;
        }
        if self.buffered() < need {
            return Err(GgufError::Truncated);
        }
        Ok(())
    }

    fn answered_from_known_end(&self, read_offset: u64) -> bool {
        self.answers_from_known_end && self.known_end == Some(read_offset)
    }

    fn drop_consumed(&mut self) {
        self.buffer.drain(..self.position);
        self.buffer_offset = self.buffer_offset.saturating_add(self.position as u64);
        self.position = 0;
    }

    /// Reads up to a chunk (at least `missing` bytes) at `read_offset` onto the buffer, within the budget.
    fn read_window(&mut self, read_offset: u64, missing: u64) -> Result<(), GgufError> {
        if missing > self.budget_left {
            return Err(GgufError::TooLarge);
        }
        if read_offset > LARGEST_EXACT_POSITION {
            return Err(position_out_of_range());
        }
        let want = missing.max(CHUNK).min(self.budget_left);
        let want = usize::try_from(want).map_err(|_| GgufError::TooLarge)?;
        let start = self.buffer.len();
        self.buffer.resize(start + want, 0);
        let got = self.source.read_at(read_offset, &mut self.buffer[start..]);
        let got = got.inspect_err(|_| self.buffer.truncate(start))?;
        self.buffer.truncate(start + got);
        self.budget_left -= got as u64;
        if got < want {
            self.known_end = Some(read_offset.saturating_add(got as u64));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io;

    const MIB: u64 = 1024 * 1024;
    const CHUNK: usize = super::CHUNK as usize;
    const BUDGET: u64 = 256 * MIB;

    /// A source of `len` patterned bytes that records every `(offset, len)` it is asked for.
    struct CountingSource {
        len: u64,
        requests: RefCell<Vec<(u64, usize)>>,
    }

    impl CountingSource {
        fn new(len: u64) -> Self {
            CountingSource {
                len,
                requests: RefCell::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<(u64, usize)> {
            self.requests.borrow().clone()
        }

        fn total_requested(&self) -> u64 {
            self.requests
                .borrow()
                .iter()
                .map(|&(_, len)| len as u64)
                .sum()
        }
    }

    fn pattern_byte(offset: u64) -> u8 {
        (offset % 251) as u8
    }

    fn pattern_at(offset: u64) -> [u8; 4] {
        [0, 1, 2, 3].map(|i| pattern_byte(offset + i))
    }

    impl ReadAt for CountingSource {
        fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize> {
            self.requests.borrow_mut().push((offset, into.len()));
            let available = self.len.saturating_sub(offset).min(into.len() as u64) as usize;
            for (i, byte) in into[..available].iter_mut().enumerate() {
                *byte = pattern_byte(offset + i as u64);
            }
            Ok(available)
        }
    }

    // Mirrors the first read of both TS paths: fdSource gets (0, 4 MB); the async path's first NeedMore is
    // (off 0, n 4 MB) and reads min(n, budget).
    #[test]
    fn the_first_fill_requests_one_chunk_at_offset_zero() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, BUDGET);
        assert_eq!(reader.u32().unwrap(), u32::from_le_bytes(pattern_at(0)));
        assert_eq!(source.requests(), vec![(0, CHUNK)]);
    }

    // Mirrors BufReader.skip beyond the buffer (gguf.ts:258-267): no read, only the offset moves.
    #[test]
    fn a_skip_past_the_buffer_requests_nothing() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, BUDGET);
        reader.u32().unwrap();
        reader.skip(8 * MIB);
        assert_eq!(source.requests().len(), 1);
        assert_eq!(reader.offset(), 4 + 8 * MIB);
    }

    // Mirrors the fill after that skip: fdSource / NeedMore at fileOff + buf.length = the skipped-to offset.
    #[test]
    fn the_fill_after_a_skip_requests_from_the_new_offset() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, BUDGET);
        reader.u32().unwrap();
        reader.skip(8 * MIB);
        assert_eq!(
            reader.u32().unwrap(),
            u32::from_le_bytes(pattern_at(4 + 8 * MIB))
        );
        assert_eq!(source.requests(), vec![(0, CHUNK), (4 + 8 * MIB, CHUNK)]);
    }

    // Mirrors BufReader.skip within the buffer (gguf.ts:260-263).
    #[test]
    fn a_skip_within_the_buffer_requests_nothing() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, BUDGET);
        reader.u32().unwrap();
        reader.skip(1000);
        assert_eq!(reader.u32().unwrap(), u32::from_le_bytes(pattern_at(1004)));
        assert_eq!(source.requests().len(), 1);
    }

    // Mirrors fill (gguf.ts:216-224): the next read starts at fileOff + buf.length and keeps what remained.
    #[test]
    fn a_fill_across_the_buffer_end_keeps_the_remaining_bytes() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, BUDGET);
        reader.bytes(CHUNK as u64 - 2).unwrap();
        assert_eq!(
            reader.u32().unwrap(),
            u32::from_le_bytes(pattern_at(CHUNK as u64 - 2))
        );
        assert_eq!(source.requests(), vec![(0, CHUNK), (CHUNK as u64, CHUNK)]);
        assert_eq!(reader.offset(), CHUNK as u64 + 2);
    }

    // Mirrors toRead = max(chunk, need - remaining) (gguf.ts:218).
    #[test]
    fn a_need_above_the_chunk_requests_the_need() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, BUDGET);
        assert_eq!(reader.bytes(5 * MIB).unwrap().len(), 5 * MIB as usize);
        assert_eq!(source.requests(), vec![(0, 5 * MIB as usize)]);
    }

    // Mirrors `if (e.need > budget) throw too_large` (gguf.ts:384), before any read.
    #[test]
    fn a_need_above_the_budget_is_too_large_without_a_request() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, MIB);
        assert!(matches!(reader.bytes(MIB + 1), Err(GgufError::TooLarge)));
        assert!(source.requests().is_empty());
    }

    // Mirrors want = min(e.n, budget) (gguf.ts:385).
    #[test]
    fn a_fill_reads_no_more_than_the_budget_left() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, MIB);
        reader.u32().unwrap();
        assert_eq!(source.requests(), vec![(0, MIB as usize)]);
    }

    // Mirrors budget -= have (gguf.ts:393), then the next NeedMore against what is left.
    #[test]
    fn a_need_after_the_budget_is_spent_is_too_large() {
        let source = CountingSource::new(10_000_000);
        let mut reader = Reader::new(&source, MIB);
        reader.bytes(MIB).unwrap();
        assert!(matches!(reader.u32(), Err(GgufError::TooLarge)));
        assert_eq!(source.requests().len(), 1);
    }

    // Mirrors `if (this.buf.length < need) throw truncated` (gguf.ts:223) on a short file.
    #[test]
    fn a_short_source_is_truncated() {
        let source = CountingSource::new(2);
        let mut reader = Reader::new(&source, BUDGET);
        assert!(matches!(reader.u32(), Err(GgufError::Truncated)));
        assert_eq!(source.requests(), vec![(0, CHUNK)]);
    }

    // Mirrors windowSource's eof window (gguf.ts:194-198): a need at the end of a window that reached the end of
    // the file is answered from that window, so it is truncated however large, with no read and no budget check.
    #[test]
    fn a_need_at_the_known_end_is_truncated_without_a_request() {
        let source = CountingSource::new(16);
        let mut reader = Reader::new(&source, MIB);
        reader.bytes(16).unwrap();
        assert!(matches!(reader.bytes(20 << 30), Err(GgufError::Truncated)));
        assert_eq!(source.requests().len(), 1);
    }

    // Mirrors fdSource (gguf.ts:165-170), the path ggufCutShort uses: it asks the file again at its end, so a need
    // there above the budget is too_large (D-3), where the async eof window would answer truncated.
    #[test]
    fn a_rereading_reader_checks_the_budget_at_the_known_end() {
        let source = CountingSource::new(16);
        let mut reader = Reader::rereading_at_end(&source, MIB);
        reader.bytes(16).unwrap();
        assert!(matches!(reader.bytes(20 << 30), Err(GgufError::TooLarge)));
        assert_eq!(source.requests().len(), 1);
    }

    #[test]
    fn a_rereading_reader_reads_again_at_the_known_end_and_is_truncated() {
        let source = CountingSource::new(16);
        let mut reader = Reader::rereading_at_end(&source, MIB);
        reader.bytes(16).unwrap();
        assert!(matches!(reader.u32(), Err(GgufError::Truncated)));
        assert_eq!(
            source.requests(),
            vec![(0, MIB as usize), (16, MIB as usize - 16)]
        );
    }

    // Mirrors NeedMore past every window (gguf.ts:199): beyond the known end the budget applies again.
    #[test]
    fn a_need_past_the_known_end_is_checked_against_the_budget() {
        let source = CountingSource::new(16);
        let mut reader = Reader::new(&source, MIB);
        reader.u32().unwrap();
        reader.skip(100);
        assert!(matches!(reader.bytes(2 * MIB), Err(GgufError::TooLarge)));
        assert_eq!(source.requests().len(), 1);
    }

    // Mirrors the same NeedMore within budget: it reads at the offset past the end, gets nothing, truncated.
    #[test]
    fn a_need_past_the_known_end_reads_there_and_is_truncated() {
        let source = CountingSource::new(16);
        let mut reader = Reader::new(&source, MIB);
        reader.u32().unwrap();
        reader.skip(100);
        assert!(matches!(reader.u32(), Err(GgufError::Truncated)));
        assert_eq!(
            source.requests(),
            vec![(0, MIB as usize), (104, MIB as usize - 16)]
        );
    }

    // Mirrors the async path's running budget (gguf.ts:378-393) over many windows.
    #[test]
    fn the_bytes_requested_never_exceed_the_budget() {
        let source = CountingSource::new(1 << 40);
        let max_read = 10 * MIB;
        let mut reader = Reader::new(&source, max_read);
        let outcome = loop {
            reader.skip(5 * MIB);
            if let Err(error) = reader.u32() {
                break error;
            }
        };
        assert!(matches!(outcome, GgufError::TooLarge));
        assert!(source.total_requested() <= max_read);
    }

    #[test]
    fn a_huge_skip_saturates_instead_of_overflowing() {
        let source = CountingSource::new(16);
        let mut reader = Reader::new(&source, MIB);
        reader.u32().unwrap();
        reader.skip(u64::MAX);
        assert_eq!(reader.offset(), u64::MAX);
        assert_eq!(reader.u32().unwrap_err().code(), "io");
    }

    /// The outcome of reading a u32 at file position `position` of a 16-byte source, and the requests made there.
    fn read_u32_at(position: u64) -> (Result<u32, GgufError>, Vec<(u64, usize)>) {
        let source = CountingSource::new(16);
        let mut reader = Reader::new(&source, MIB);
        reader.u32().unwrap();
        reader.skip(position - 4);
        let outcome = reader.u32();
        let requests_there = source
            .requests()
            .into_iter()
            .filter(|&(at, _)| at == position);
        (outcome, requests_there.collect())
    }

    // Mirrors Node's file reads, which refuse a position above Number.MAX_SAFE_INTEGER (D-5).
    #[test]
    fn a_read_above_the_largest_exact_double_position_is_out_of_range() {
        for position in [1 << 53, (1 << 53) + 1, 1 << 63, u64::MAX] {
            let (outcome, requests) = read_u32_at(position);
            let error = outcome.unwrap_err();
            assert_eq!(
                (error.code(), error.to_string()),
                ("io", "position out of range".to_string()),
                "at {position}"
            );
            assert!(requests.is_empty(), "the source was asked at {position}");
        }
    }

    #[test]
    fn a_read_at_the_largest_exact_double_position_is_still_made() {
        let (outcome, requests) = read_u32_at(LARGEST_EXACT_POSITION);
        assert!(matches!(outcome, Err(GgufError::Truncated)));
        assert_eq!(requests.len(), 1);
    }

    // The budget is checked before the position, as gguf.ts:381 does before its read.
    #[test]
    fn a_need_above_the_budget_is_too_large_even_out_of_range() {
        let source = CountingSource::new(16);
        let mut reader = Reader::new(&source, MIB);
        reader.u32().unwrap();
        reader.skip(1 << 60);
        assert!(matches!(reader.bytes(2 * MIB), Err(GgufError::TooLarge)));
    }

    #[test]
    fn integers_are_little_endian() {
        let bytes: &[u8] = &[1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1];
        let mut reader = Reader::new(bytes, BUDGET);
        assert_eq!(reader.u32().unwrap(), 1);
        assert_eq!(reader.u64().unwrap(), 2 + (1 << 56));
    }

    // Mirrors skipStrings (gguf.ts:245-253): each element is a u64 length then that many bytes, never read.
    #[test]
    fn skip_strings_steps_over_length_prefixed_strings() {
        let mut bytes = Vec::new();
        for text in ["ab", "", "xyz"] {
            bytes.extend_from_slice(&(text.len() as u64).to_le_bytes());
            bytes.extend_from_slice(text.as_bytes());
        }
        bytes.extend_from_slice(&7u32.to_le_bytes());
        let mut reader = Reader::new(bytes.as_slice(), BUDGET);
        reader.skip_strings(3).unwrap();
        assert_eq!(reader.offset(), 29);
        assert_eq!(reader.u32().unwrap(), 7);
    }

    #[test]
    fn skip_strings_on_a_cut_length_is_truncated() {
        let bytes: &[u8] = &[2, 0, 0, 0];
        let mut reader = Reader::new(bytes, BUDGET);
        assert!(matches!(reader.skip_strings(1), Err(GgufError::Truncated)));
    }

    #[test]
    fn a_source_failure_is_an_io_error() {
        struct FailingSource;
        impl ReadAt for FailingSource {
            fn read_at(&self, _offset: u64, _into: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("disk unplugged"))
            }
        }
        let mut reader = Reader::new(FailingSource, BUDGET);
        let error = reader.u32().unwrap_err();
        assert_eq!(
            (error.code(), error.to_string()),
            ("io", "disk unplugged".to_string())
        );
    }
}
