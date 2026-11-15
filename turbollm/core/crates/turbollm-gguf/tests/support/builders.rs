//! Ports of the TypeScript builders behind the generated fixtures (`gguf-goldens.ts` RECIPES, plan P-1):
//! `bigVocabGguf` from `gguf.test.ts`, and `ggufFile` / `ggufVocabOnly` from `src/test-support/gguf-file.ts`.
//! Each must produce the golden's bytes exactly; the golden's `size` and `sha256` prove it.

const GGUF_MAGIC: u32 = 0x4655_4747;
const T_UINT32: u32 = 4;
const T_FLOAT32: u32 = 6;
const T_BOOL: u32 = 7;
const T_STRING: u32 = 8;
const T_ARRAY: u32 = 9;
const F32_TENSOR: u32 = 0;
const F32_BYTES: u64 = 4;
const GGUF_FILE_ALIGNMENT: u64 = 32;
const BIG_VOCAB_TENSOR_DATA: usize = 1_000_000;

/// The bytes of a generated fixture, from its golden `recipe` and `args`.
pub fn generated_fixture(recipe: &str, args: &[u64]) -> Vec<u8> {
    match (recipe, args) {
        ("big-vocab", &[tokens, merges]) => big_vocab_gguf(tokens, merges),
        ("huge-description", &[length]) => huge_description_gguf(length),
        ("long-name", &[length]) => long_name_gguf(length),
        _ => panic!("unknown generated recipe {recipe} {args:?}"),
    }
}

struct TensorInfo {
    name: &'static str,
    dims: Vec<u64>,
    tensor_type: u32,
    offset: u64,
}

fn big_vocab_gguf(tokens: u64, merges: u64) -> Vec<u8> {
    let kvs = [
        ("general.architecture", string_value("gemma4")),
        ("general.name", string_value("Big Vocab")),
        ("general.file_type", u32_value(15)),
        ("gemma4.block_count", u32_value(30)),
        ("gemma4.attention.head_count_kv", u32_array(&[8, 2, 8])),
        (
            "gemma4.attention.sliding_window_pattern",
            bool_array(&[true, false, true]),
        ),
        (
            "tokenizer.chat_template",
            string_value("{% if reasoning_effort %}x{% endif %}"),
        ),
        (
            "tokenizer.ggml.tokens",
            string_array(tokens, |i| format!("\u{2581}tok{i}\u{e9}")),
        ),
        ("tokenizer.ggml.scores", zero_f32_array(tokens)),
        (
            "tokenizer.ggml.merges",
            string_array(merges, |i| format!("a{i} b{i}")),
        ),
        ("gemma4.embedding_length", u32_value(2048)),
    ];
    let tensors = [
        f32_tensor("token_embd.weight", vec![2048, 64], 0),
        f32_tensor("output.weight", vec![100], 524_288),
    ];
    let mut file = header(&kvs, &tensors);
    file.resize(file.len() + BIG_VOCAB_TENSOR_DATA, 0);
    file
}

fn huge_description_gguf(length: u64) -> Vec<u8> {
    let kvs = [
        ("general.architecture", string_value("llama")),
        ("general.description", string_value(&repeated('x', length))),
        ("llama.block_count", u32_value(7)),
    ];
    gguf_file_one_f32_tensor(&kvs, f32_tensor("a", vec![10], 0))
}

fn long_name_gguf(length: u64) -> Vec<u8> {
    let kvs = [
        ("general.architecture", string_value("llama")),
        ("general.name", string_value(&repeated('n', length))),
    ];
    header(&kvs, &[])
}

fn repeated(letter: char, length: u64) -> String {
    let length = usize::try_from(length).expect("a generated string fits in memory");
    letter.to_string().repeat(length)
}

fn f32_tensor(name: &'static str, dims: Vec<u64>, offset: u64) -> TensorInfo {
    TensorInfo {
        name,
        dims,
        tensor_type: F32_TENSOR,
        offset,
    }
}

/// `ggufFile` with one F32 tensor: the header padded to the alignment, then the tensor's data padded too, every
/// byte after the padded header following the file's deterministic pattern.
fn gguf_file_one_f32_tensor(kvs: &[(&str, Vec<u8>)], tensor: TensorInfo) -> Vec<u8> {
    let elements: u64 = tensor.dims.iter().product();
    let mut file = header(kvs, &[tensor]);
    let data_start = (file.len() as u64).next_multiple_of(GGUF_FILE_ALIGNMENT);
    let file_len = data_start + (elements * F32_BYTES).next_multiple_of(GGUF_FILE_ALIGNMENT);
    file.resize(usize::try_from(data_start).expect("fits in memory"), 0);
    file.extend((data_start..file_len).map(tensor_pattern_byte));
    file
}

fn tensor_pattern_byte(index: u64) -> u8 {
    ((index * 31 + (index >> 9)) & 0xff) as u8
}

fn header(kvs: &[(&str, Vec<u8>)], tensors: &[TensorInfo]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(GGUF_MAGIC.to_le_bytes());
    out.extend(3u32.to_le_bytes());
    out.extend((tensors.len() as u64).to_le_bytes());
    out.extend((kvs.len() as u64).to_le_bytes());
    for (key, value) in kvs {
        out.extend(length_prefixed(key.as_bytes()));
        out.extend(value);
    }
    for tensor in tensors {
        out.extend(tensor_info_bytes(tensor));
    }
    out
}

fn tensor_info_bytes(tensor: &TensorInfo) -> Vec<u8> {
    let mut out = length_prefixed(tensor.name.as_bytes());
    out.extend((tensor.dims.len() as u32).to_le_bytes());
    for dim in &tensor.dims {
        out.extend(dim.to_le_bytes());
    }
    out.extend(tensor.tensor_type.to_le_bytes());
    out.extend(tensor.offset.to_le_bytes());
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

fn array(element_type: u32, count: u64, elements: Vec<u8>) -> Vec<u8> {
    let mut payload = element_type.to_le_bytes().to_vec();
    payload.extend(count.to_le_bytes());
    payload.extend(elements);
    typed(T_ARRAY, payload)
}

fn u32_array(numbers: &[u32]) -> Vec<u8> {
    let elements = numbers.iter().flat_map(|n| n.to_le_bytes()).collect();
    array(T_UINT32, numbers.len() as u64, elements)
}

fn bool_array(flags: &[bool]) -> Vec<u8> {
    let elements = flags.iter().map(|&flag| u8::from(flag)).collect();
    array(T_BOOL, flags.len() as u64, elements)
}

fn string_array(count: u64, text: impl Fn(u64) -> String) -> Vec<u8> {
    let elements = (0..count)
        .flat_map(|i| length_prefixed(text(i).as_bytes()))
        .collect();
    array(T_STRING, count, elements)
}

fn zero_f32_array(count: u64) -> Vec<u8> {
    let zeros = vec![0; usize::try_from(count * F32_BYTES).expect("fits in memory")];
    array(T_FLOAT32, count, zeros)
}
