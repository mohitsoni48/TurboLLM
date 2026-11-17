//! GGUF metadata values as the TypeScript parser sees them (`gguf.ts:146-158`, `270-354`): every scalar becomes
//! a JavaScript number, string or boolean, and the conversions between them follow ECMAScript.

use crate::error::GgufError;
use crate::jsnum;
use crate::reader::Reader;
use crate::source::ReadAt;

const T_UINT8: u32 = 0;
const T_INT8: u32 = 1;
const T_UINT16: u32 = 2;
const T_INT16: u32 = 3;
const T_UINT32: u32 = 4;
const T_INT32: u32 = 5;
const T_FLOAT32: u32 = 6;
const T_BOOL: u32 = 7;
pub(crate) const T_STRING: u32 = 8;
const T_ARRAY: u32 = 9;
const T_UINT64: u32 = 10;
const T_INT64: u32 = 11;
const T_FLOAT64: u32 = 12;

/// A decoded scalar: the JavaScript value `readScalar` returns.
pub(crate) enum Value {
    Number(f64),
    Text(String),
    Flag(bool),
}

impl Value {
    /// ECMAScript `Number(value)`.
    pub(crate) fn to_number(&self) -> f64 {
        match self {
            Value::Number(number) => *number,
            Value::Text(text) => jsnum::to_number(text),
            Value::Flag(flag) => f64::from(u8::from(*flag)),
        }
    }

    /// ECMAScript `String(value)`.
    pub(crate) fn into_js_string(self) -> String {
        match self {
            Value::Number(number) => jsnum::number_to_string(number),
            Value::Text(text) => text,
            Value::Flag(flag) => flag.to_string(),
        }
    }

    /// The mask entry `readBoolArray` makes of an element: a string counts only when it reads `true`.
    fn to_mask_flag(&self) -> bool {
        match self {
            Value::Number(number) => *number != 0.0 && !number.is_nan(),
            Value::Text(text) => text.to_lowercase() == "true",
            Value::Flag(flag) => *flag,
        }
    }
}

/// `readScalar` (`gguf.ts:270-286`): an array or unknown type is `BadType`.
pub(crate) fn read_scalar<R: ReadAt>(
    reader: &mut Reader<R>,
    value_type: u32,
) -> Result<Value, GgufError> {
    let number = match value_type {
        T_UINT8 => f64::from(reader.bytes(1)?[0]),
        T_INT8 => f64::from(i8::from_le_bytes(fixed(reader.bytes(1)?))),
        T_UINT16 => f64::from(u16::from_le_bytes(fixed(reader.bytes(2)?))),
        T_INT16 => f64::from(i16::from_le_bytes(fixed(reader.bytes(2)?))),
        T_UINT32 => f64::from(reader.u32()?),
        T_INT32 => f64::from(i32::from_le_bytes(fixed(reader.bytes(4)?))),
        T_FLOAT32 => f64::from(f32::from_le_bytes(fixed(reader.bytes(4)?))),
        T_BOOL => return Ok(Value::Flag(reader.bytes(1)?[0] != 0)),
        T_UINT64 => reader.u64()? as f64,
        T_INT64 => i64::from_le_bytes(fixed(reader.bytes(8)?)) as f64,
        T_FLOAT64 => f64::from_le_bytes(fixed(reader.bytes(8)?)),
        T_STRING => return Ok(Value::Text(read_string(reader)?)),
        _ => return Err(GgufError::BadType(value_type)),
    };
    Ok(Value::Number(number))
}

/// A length-prefixed string, decoded as Node's `toString('utf8')` does (invalid bytes become U+FFFD).
pub(crate) fn read_string<R: ReadAt>(reader: &mut Reader<R>) -> Result<String, GgufError> {
    let len = reader.u64()?;
    Ok(String::from_utf8_lossy(reader.bytes(len)?).into_owned())
}

/// `skipValue` (`gguf.ts:288-304`): a nested array's elements and unknown types are zero bytes wide.
pub(crate) fn skip_value<R: ReadAt>(
    reader: &mut Reader<R>,
    value_type: u32,
) -> Result<(), GgufError> {
    match value_type {
        T_STRING => {
            let len = reader.u64()?;
            reader.skip(len);
        }
        T_ARRAY => {
            let element_type = reader.u32()?;
            let count = reader.u64()?;
            if element_type == T_STRING {
                reader.skip_strings(count)?;
            } else {
                reader.skip(count.saturating_mul(scalar_size(element_type)));
            }
        }
        _ => reader.skip(scalar_size(value_type)),
    }
    Ok(())
}

/// Visits each number of a value in order (`readNumberList`, `gguf.ts:309-318`): a scalar is one number, an
/// array its elements. Returns whether the value was an array.
pub(crate) fn for_each_number<R: ReadAt>(
    reader: &mut Reader<R>,
    value_type: u32,
    mut visit: impl FnMut(f64),
) -> Result<bool, GgufError> {
    if value_type != T_ARRAY {
        visit(read_scalar(reader, value_type)?.to_number());
        return Ok(false);
    }
    let element_type = reader.u32()?;
    let count = reader.u64()?;
    for _ in 0..count {
        visit(read_scalar(reader, element_type)?.to_number());
    }
    Ok(true)
}

/// `readNumberOrMax` (`gguf.ts:322-332`): the largest number, floored at 0; NaN never wins.
pub(crate) fn read_number_or_max<R: ReadAt>(
    reader: &mut Reader<R>,
    value_type: u32,
) -> Result<f64, GgufError> {
    let mut max = 0.0;
    for_each_number(reader, value_type, |number| max = js_max(max, number))?;
    Ok(max)
}

/// One step of `maxOf`: `if (v > max) max = v`.
pub(crate) fn js_max(max: f64, number: f64) -> f64 {
    if number > max { number } else { max }
}

/// `readBoolArray` (`gguf.ts:338-354`): a value that is not an array is consumed and reads as no mask.
pub(crate) fn read_bool_array<R: ReadAt>(
    reader: &mut Reader<R>,
    value_type: u32,
) -> Result<Vec<bool>, GgufError> {
    if value_type != T_ARRAY {
        skip_value(reader, value_type)?;
        return Ok(Vec::new());
    }
    let element_type = reader.u32()?;
    let count = reader.u64()?;
    let mut mask = Vec::new();
    for _ in 0..count {
        mask.push(read_scalar(reader, element_type)?.to_mask_flag());
    }
    Ok(mask)
}

fn scalar_size(value_type: u32) -> u64 {
    match value_type {
        T_UINT8 | T_INT8 | T_BOOL => 1,
        T_UINT16 | T_INT16 => 2,
        T_UINT32 | T_INT32 | T_FLOAT32 => 4,
        T_UINT64 | T_INT64 | T_FLOAT64 => 8,
        _ => 0,
    }
}

fn fixed<const N: usize>(bytes: &[u8]) -> [u8; N] {
    let mut word = [0; N];
    word.copy_from_slice(bytes);
    word
}
