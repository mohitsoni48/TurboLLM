//! `parseHeader` (`gguf.ts:402-509`): the magic, the version, the KV pairs dispatched in the TypeScript order,
//! then the tensor infos.

use crate::error::GgufError;
use crate::meta::GgufMeta;
use crate::quant::{ftype_quant_label, is_bogus_general_name};
use crate::reader::Reader;
use crate::source::ReadAt;
use crate::tensors::{DEFAULT_ALIGNMENT, read_data_end};
use crate::value::{
    T_STRING, for_each_number, js_max, read_bool_array, read_number_or_max, read_scalar,
    read_string, skip_value,
};

const MAGIC: u32 = 0x4655_4747;

pub(crate) fn parse_header<R: ReadAt>(reader: &mut Reader<R>) -> Result<GgufMeta, GgufError> {
    if reader.u32()? != MAGIC {
        return Err(GgufError::NotGguf);
    }
    let version = reader.u32()?;
    if version != 2 && version != 3 {
        return Err(GgufError::BadVersion(version));
    }
    let tensor_count = reader.u64()?;
    let kv_count = reader.u64()?;
    let mut fields = HeaderFields::default();
    for _ in 0..kv_count {
        let key = read_string(reader)?;
        let value_type = reader.u32()?;
        fields.read_value(reader, &key, value_type)?;
    }
    let data_end = read_data_end(reader, tensor_count, fields.alignment)?;
    Ok(fields.into_meta(data_end))
}

/// What the KV pairs said so far: the TypeScript `m` object and the locals beside it, as JavaScript numbers
/// until the end.
struct HeaderFields {
    arch: Option<String>,
    name: Option<String>,
    quant: Option<String>,
    size_label: Option<String>,
    alignment: f64,
    native_ctx: f64,
    block_count: f64,
    embed_len: f64,
    head_count_kv: f64,
    head_count_kv_per_layer: Vec<u32>,
    key_length: Option<f64>,
    value_length: Option<f64>,
    key_length_swa: Option<f64>,
    value_length_swa: Option<f64>,
    sliding_window: f64,
    sliding_window_pattern: Vec<bool>,
    full_attention_interval: f64,
    ssm_inner_size: f64,
    ssm_state_size: f64,
    ssm_conv_kernel: f64,
    expert_count: f64,
    nextn_layers: f64,
    has_chat_template: bool,
    reasoning_effort: bool,
}

impl Default for HeaderFields {
    fn default() -> Self {
        HeaderFields {
            arch: None,
            name: None,
            quant: None,
            size_label: None,
            alignment: DEFAULT_ALIGNMENT,
            native_ctx: 0.0,
            block_count: 0.0,
            embed_len: 0.0,
            head_count_kv: 0.0,
            head_count_kv_per_layer: Vec::new(),
            key_length: None,
            value_length: None,
            key_length_swa: None,
            value_length_swa: None,
            sliding_window: 0.0,
            sliding_window_pattern: Vec::new(),
            full_attention_interval: 0.0,
            ssm_inner_size: 0.0,
            ssm_state_size: 0.0,
            ssm_conv_kernel: 0.0,
            expert_count: 0.0,
            nextn_layers: 0.0,
            has_chat_template: false,
            reasoning_effort: false,
        }
    }
}

impl HeaderFields {
    /// The key dispatch of `gguf.ts:418-463`, branch by branch in the same order: the first match wins.
    fn read_value<R: ReadAt>(
        &mut self,
        reader: &mut Reader<R>,
        key: &str,
        value_type: u32,
    ) -> Result<(), GgufError> {
        let r = reader;
        let t = value_type;
        if key == "general.architecture" {
            self.arch = Some(read_scalar(r, t)?.into_js_string());
        } else if key == "general.name" {
            self.read_general_name(r, t)?;
        } else if key == "general.file_type" {
            let file_type = read_scalar(r, t)?.to_number();
            self.quant = Some(ftype_quant_label(file_type).unwrap_or_default().to_string());
        } else if key == "general.size_label" {
            self.size_label = Some(read_scalar(r, t)?.into_js_string());
        } else if key == "general.alignment" {
            self.alignment = read_scalar(r, t)?.to_number();
        } else if key.ends_with(".context_length") {
            self.native_ctx = read_number_or_max(r, t)?;
        } else if key.ends_with(".block_count") {
            self.block_count = read_number_or_max(r, t)?;
        } else if key.ends_with(".embedding_length") {
            self.embed_len = read_number_or_max(r, t)?;
        } else if key.ends_with(".attention.head_count_kv") {
            self.read_head_count_kv(r, t)?;
        } else if key.ends_with(".attention.key_length") {
            self.key_length = Some(read_number_or_max(r, t)?);
        } else if key.ends_with(".attention.value_length") {
            self.value_length = Some(read_number_or_max(r, t)?);
        } else if key.ends_with(".attention.key_length_swa") {
            self.key_length_swa = Some(read_number_or_max(r, t)?);
        } else if key.ends_with(".attention.value_length_swa") {
            self.value_length_swa = Some(read_number_or_max(r, t)?);
        } else if key.ends_with(".attention.sliding_window") {
            self.sliding_window = read_number_or_max(r, t)?;
        } else if key.ends_with(".attention.sliding_window_pattern") {
            self.sliding_window_pattern = read_bool_array(r, t)?;
        } else if key.ends_with(".full_attention_interval") {
            self.full_attention_interval = read_number_or_max(r, t)?;
        } else if key.ends_with(".ssm.inner_size") {
            self.ssm_inner_size = read_number_or_max(r, t)?;
        } else if key.ends_with(".ssm.state_size") {
            self.ssm_state_size = read_number_or_max(r, t)?;
        } else if key.ends_with(".ssm.conv_kernel") {
            self.ssm_conv_kernel = read_number_or_max(r, t)?;
        } else if key.ends_with(".expert_count") {
            self.expert_count = read_number_or_max(r, t)?;
        } else if key.ends_with(".nextn_predict_layers") {
            self.nextn_layers = read_number_or_max(r, t)?;
        } else if key == "tokenizer.chat_template" {
            self.read_chat_template(r, t)?;
        } else {
            skip_value(r, t)?;
        }
        Ok(())
    }

    /// A storage-format word is not a model name: it leaves the name as it was (`gguf.ts:422-425`).
    fn read_general_name<R: ReadAt>(
        &mut self,
        reader: &mut Reader<R>,
        value_type: u32,
    ) -> Result<(), GgufError> {
        let name = read_scalar(reader, value_type)?.into_js_string();
        if !is_bogus_general_name(&name) {
            self.name = Some(name);
        }
        Ok(())
    }

    /// The largest count always; the per-layer counts only when the file declares an array (`gguf.ts:432-440`).
    fn read_head_count_kv<R: ReadAt>(
        &mut self,
        reader: &mut Reader<R>,
        value_type: u32,
    ) -> Result<(), GgufError> {
        let mut max = 0.0;
        let mut per_layer = Vec::new();
        let is_array = for_each_number(reader, value_type, |count| {
            max = js_max(max, count);
            per_layer.push(field_u32(count));
        })?;
        self.head_count_kv = max;
        if is_array {
            self.head_count_kv_per_layer = per_layer;
        }
        Ok(())
    }

    /// Any `tokenizer.chat_template` sets the flag; only a string one is searched (`gguf.ts:453-459`).
    fn read_chat_template<R: ReadAt>(
        &mut self,
        reader: &mut Reader<R>,
        value_type: u32,
    ) -> Result<(), GgufError> {
        self.has_chat_template = true;
        if value_type != T_STRING {
            return skip_value(reader, value_type);
        }
        let template = read_scalar(reader, value_type)?.into_js_string();
        if template.contains("reasoning_effort") {
            self.reasoning_effort = true;
        }
        Ok(())
    }

    /// The return literal of `gguf.ts:485-508`.
    fn into_meta(self, data_end: u64) -> GgufMeta {
        GgufMeta {
            arch: self.arch.unwrap_or_else(|| "unknown".to_string()),
            name: self.name.unwrap_or_default(),
            quant: self.quant.unwrap_or_default(),
            size_label: self.size_label.unwrap_or_default(),
            native_ctx: field_u32(self.native_ctx),
            block_count: field_u32(self.block_count),
            embed_len: field_u32(self.embed_len),
            head_count_kv: field_u32(self.head_count_kv),
            head_dim: field_u32(self.key_length.or(self.value_length).unwrap_or(0.0)),
            expert_count: field_u32(self.expert_count),
            nextn_layers: field_u32(self.nextn_layers),
            has_chat_template: self.has_chat_template,
            reasoning_effort: self.reasoning_effort,
            sliding_window: field_u32(self.sliding_window),
            sliding_window_pattern: self.sliding_window_pattern,
            head_dim_swa: field_u32(self.key_length_swa.or(self.value_length_swa).unwrap_or(0.0)),
            head_count_kv_per_layer: self.head_count_kv_per_layer,
            full_attention_interval: field_u32(self.full_attention_interval),
            ssm_inner_size: field_u32(self.ssm_inner_size),
            ssm_state_size: field_u32(self.ssm_state_size),
            ssm_conv_kernel: field_u32(self.ssm_conv_kernel),
            data_end,
        }
    }
}

/// Declared divergence D-1: the JavaScript number truncated, then saturated into `[0, u32::MAX]` (NaN is 0),
/// which is exactly Rust's float-to-integer `as` cast.
fn field_u32(number: f64) -> u32 {
    number as u32
}
