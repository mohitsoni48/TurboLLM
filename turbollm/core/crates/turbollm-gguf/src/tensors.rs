//! The tensor infos and the length the file needs to hold their data (`gguf.ts:128-143`, `465-483`, `507`).
//! The arithmetic is exact (declared divergence D-2: TypeScript rounds above 2^53).

use crate::error::GgufError;
use crate::jsnum;
use crate::reader::Reader;
use crate::source::ReadAt;

/// GGUF_DEFAULT_ALIGNMENT, used when the file declares no `general.alignment`.
pub(crate) const DEFAULT_ALIGNMENT: f64 = 32.0;
/// GGML_MAX_DIMS: a tensor info claiming more is not one llama.cpp would read either.
const MAX_DIMS: u32 = 4;

/// Reads the tensor infos and returns `dataEnd`: the header's end for no tensors, the aligned data start plus
/// the furthest tensor end when every tensor is understood, 0 otherwise.
pub(crate) fn read_data_end<R: ReadAt>(
    reader: &mut Reader<R>,
    tensor_count: u64,
    alignment: f64,
) -> Result<u64, GgufError> {
    let tensors_end = read_tensors_end(reader, tensor_count)?;
    let header_end = reader.offset();
    if tensor_count == 0 {
        return Ok(header_end);
    }
    let data_end = match (tensors_end, valid_alignment(alignment)) {
        (Some(tensors_end), Some(alignment)) => {
            aligned(header_end, alignment).saturating_add(tensors_end)
        }
        _ => 0,
    };
    Ok(u64::try_from(data_end).unwrap_or(u64::MAX))
}

/// The furthest end of any tensor's data, relative to the data section; `None` when a tensor has more than
/// [`MAX_DIMS`] dimensions (the read stops there), an unknown type or a partial block.
fn read_tensors_end<R: ReadAt>(
    reader: &mut Reader<R>,
    tensor_count: u64,
) -> Result<Option<u128>, GgufError> {
    let mut tensors_end = Some(0u128);
    for _ in 0..tensor_count {
        let name_len = reader.u64()?;
        reader.skip(name_len);
        let dims = reader.u32()?;
        if dims > MAX_DIMS {
            return Ok(None);
        }
        let tensor_end = read_tensor_end(reader, dims)?;
        tensors_end = tensors_end
            .zip(tensor_end)
            .map(|(furthest, end)| furthest.max(end));
    }
    Ok(tensors_end)
}

/// One tensor info after its name and dimension count: the dimensions, the type, the offset.
fn read_tensor_end<R: ReadAt>(
    reader: &mut Reader<R>,
    dims: u32,
) -> Result<Option<u128>, GgufError> {
    let dims = (0..dims)
        .map(|_| reader.u64())
        .collect::<Result<Vec<u64>, GgufError>>()?;
    let block = block_size(reader.u32()?);
    let offset = u128::from(reader.u64()?);
    let bytes = block.and_then(|(elements_per_block, bytes_per_block)| {
        whole_blocks_bytes(&dims, elements_per_block, bytes_per_block)
    });
    Ok(bytes.map(|bytes| offset.saturating_add(bytes)))
}

/// The bytes of a tensor that is a whole number of blocks, `None` for a partial block. Whether the blocks are
/// whole is TypeScript's answer, so `known` matches TS for every input (arch 2.1); the bytes are exact, saturating
/// above 2^128 elements (D-2).
fn whole_blocks_bytes(
    dims: &[u64],
    elements_per_block: u128,
    bytes_per_block: u128,
) -> Option<u128> {
    if !typescript_sees_whole_blocks(dims, elements_per_block) {
        return None;
    }
    let bytes = element_count(dims).map_or(u128::MAX, |elements| {
        (elements / elements_per_block).saturating_mul(bytes_per_block)
    });
    Some(bytes)
}

/// `elements % size[0] !== 0` (`gguf.ts:478`) on the product TypeScript computes: each dimension rounded to a
/// double (`Number` of a `u64`, as `u64 as f64`), multiplied in doubles, `%` being `fmod` in both.
fn typescript_sees_whole_blocks(dims: &[u64], elements_per_block: u128) -> bool {
    let elements = dims
        .iter()
        .fold(1.0, |elements: f64, &dim| elements * dim as f64);
    elements % elements_per_block as f64 == 0.0
}

/// The product of the dimensions, `None` above `u128::MAX`.
fn element_count(dims: &[u64]) -> Option<u128> {
    if dims.contains(&0) {
        return Some(0);
    }
    dims.iter().try_fold(1u128, |elements, &dim| {
        elements.checked_mul(u128::from(dim))
    })
}

/// `Number.isInteger(a) && a > 0 && (a & (a - 1)) === 0` (`gguf.ts:468`), with the bitwise test on ECMAScript
/// `ToInt32` exactly as TypeScript evaluates it; the valid alignment as an integer.
fn valid_alignment(alignment: f64) -> Option<u128> {
    let integral = alignment.is_finite() && alignment.trunc() == alignment && alignment > 0.0;
    let power_of_two = jsnum::to_int32(alignment) & jsnum::to_int32(alignment - 1.0) == 0;
    (integral && power_of_two).then_some(alignment as u128)
}

fn aligned(offset: u64, alignment: u128) -> u128 {
    u128::from(offset)
        .div_ceil(alignment)
        .saturating_mul(alignment)
}

/// A ggml tensor type's elements and bytes per block, from gguf-py's GGML_QUANT_SIZES (`gguf.ts:132-138`).
fn block_size(tensor_type: u32) -> Option<(u128, u128)> {
    let (elements, bytes) = match tensor_type {
        0 => (1, 4),
        1 => (1, 2),
        2 => (32, 18),
        3 => (32, 20),
        6 => (32, 22),
        7 => (32, 24),
        8 => (32, 34),
        9 => (32, 36),
        10 => (256, 84),
        11 => (256, 110),
        12 => (256, 144),
        13 => (256, 176),
        14 => (256, 210),
        15 => (256, 292),
        16 => (256, 66),
        17 => (256, 74),
        18 => (256, 98),
        19 => (256, 50),
        20 => (32, 18),
        21 => (256, 110),
        22 => (256, 82),
        23 => (256, 136),
        24 => (1, 1),
        25 => (1, 2),
        26 => (1, 4),
        27 => (1, 8),
        28 => (1, 8),
        29 => (256, 56),
        30 => (1, 2),
        34 => (256, 54),
        35 => (256, 66),
        39 => (32, 17),
        _ => return None,
    };
    Some((elements, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q4_0: u32 = 2;
    const F32: u32 = 0;

    /// One tensor info after its name and dimension count, as `read_tensor_end` reads it.
    fn tensor_end(dims: &[u64], tensor_type: u32) -> Option<u128> {
        let mut bytes: Vec<u8> = dims.iter().flat_map(|d| d.to_le_bytes()).collect();
        bytes.extend(tensor_type.to_le_bytes());
        bytes.extend(0u64.to_le_bytes());
        let mut reader = Reader::new(bytes.as_slice(), u64::MAX);
        read_tensor_end(&mut reader, dims.len() as u32).unwrap()
    }

    #[test]
    fn a_whole_number_of_blocks_ends_at_its_byte_length() {
        assert_eq!(tensor_end(&[64, 2], Q4_0), Some(4 * 18));
    }

    #[test]
    fn a_partial_block_has_no_end() {
        assert_eq!(tensor_end(&[33], Q4_0), None);
    }

    #[test]
    fn whole_blocks_above_2_pow_128_elements_saturate_instead_of_losing_the_end() {
        assert_eq!(
            tensor_end(&[1 << 50, 1 << 50, 1 << 50], Q4_0),
            Some(u128::MAX)
        );
        assert_eq!(
            tensor_end(&[1 << 50, 1 << 50, 1 << 30], Q4_0),
            Some(u128::MAX)
        );
    }

    #[test]
    fn whole_blocks_are_judged_on_the_double_product_typescript_computes() {
        const Q4_K: u32 = 12;
        let exact_bytes = (u128::from(u64::MAX) * 896 / 256) * 144;
        assert_eq!(tensor_end(&[u64::MAX, 896], Q4_K), Some(exact_bytes));
        assert_eq!(
            tensor_end(&[(1 << 53) + 1, 1], Q4_K),
            Some(((1 << 53) + 1) / 256 * 144)
        );
    }

    #[test]
    fn whole_blocks_above_2_pow_128_elements_saturate_for_every_block_shape() {
        const IQ1_S: u32 = 19;
        assert_eq!(tensor_end(&[u64::MAX, u64::MAX, 3], F32), Some(u128::MAX));
        assert_eq!(
            tensor_end(&[1 << 50, 1 << 50, 1 << 50], IQ1_S),
            Some(u128::MAX)
        );
    }

    #[test]
    fn a_zero_dimension_has_no_elements_however_large_the_others() {
        assert_eq!(tensor_end(&[u64::MAX, u64::MAX, u64::MAX, 0], F32), Some(0));
    }
}
