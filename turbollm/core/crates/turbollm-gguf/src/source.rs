//! Positioned byte sources: the file, or bytes already in memory. Every read names its own offset, so the
//! reader never shares a cursor and a source can be read from several places (ADR-459).

use std::fs::File;
use std::io;

/// A byte source read at explicit offsets.
pub trait ReadAt {
    /// Fills `into` with the bytes at `offset`, returning how many it holds: fewer than `into.len()` only
    /// where the source ends.
    fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize>;
}

impl<R: ReadAt + ?Sized> ReadAt for &R {
    fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize> {
        (**self).read_at(offset, into)
    }
}

impl ReadAt for [u8] {
    fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize> {
        let start = usize::try_from(offset).map_or(self.len(), |start| start.min(self.len()));
        let available = &self[start..];
        let got = available.len().min(into.len());
        into[..got].copy_from_slice(&available[..got]);
        Ok(got)
    }
}

impl ReadAt for File {
    fn read_at(&self, offset: u64, into: &mut [u8]) -> io::Result<usize> {
        let mut filled = 0;
        while filled < into.len() {
            let position = offset.saturating_add(filled as u64);
            match read_once(self, position, &mut into[filled..]) {
                Ok(0) => break,
                Ok(got) => filled += got,
                Err(failure) if failure.kind() == io::ErrorKind::Interrupted => {}
                Err(failure) => return Err(failure),
            }
        }
        Ok(filled)
    }
}

#[cfg(unix)]
fn read_once(file: &File, offset: u64, into: &mut [u8]) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, into, offset)
}

#[cfg(windows)]
fn read_once(file: &File, offset: u64, into: &mut [u8]) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, into, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const BYTES: &[u8] = b"GGUF header bytes";

    fn read_slice(offset: u64, len: usize) -> Vec<u8> {
        let mut into = vec![0; len];
        let got = BYTES.read_at(offset, &mut into).unwrap();
        into.truncate(got);
        into
    }

    #[test]
    fn a_slice_returns_the_bytes_at_the_offset() {
        assert_eq!(read_slice(5, 6), b"header");
    }

    #[test]
    fn a_slice_returns_fewer_bytes_at_its_end() {
        assert_eq!(read_slice(12, 100), b"bytes");
    }

    #[test]
    fn a_slice_read_past_its_end_returns_nothing() {
        assert_eq!(read_slice(17, 4), b"");
        assert_eq!(read_slice(u64::MAX, 4), b"");
    }

    fn crafted_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("fixtures")
            .join("gguf")
            .join("crafted")
            .join("align-3.gguf")
    }

    #[test]
    fn a_file_returns_the_bytes_at_the_offset() {
        let path = crafted_fixture();
        let expected = std::fs::read(&path).unwrap();
        let file = File::open(&path).unwrap();
        let mut into = vec![0; 8];
        assert_eq!(file.read_at(4, &mut into).unwrap(), 8);
        assert_eq!(into, expected[4..12]);
    }

    #[test]
    fn a_file_fills_the_request_up_to_its_end() {
        let path = crafted_fixture();
        let expected = std::fs::read(&path).unwrap();
        let file = File::open(&path).unwrap();
        let mut into = vec![0; expected.len() + 64];
        assert_eq!(file.read_at(0, &mut into).unwrap(), expected.len());
        assert_eq!(into[..expected.len()], expected[..]);
    }

    #[test]
    fn a_file_read_past_its_end_returns_nothing() {
        let file = File::open(crafted_fixture()).unwrap();
        let mut into = vec![0; 8];
        assert_eq!(file.read_at(1 << 40, &mut into).unwrap(), 0);
    }
}
