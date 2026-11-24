//! LiteRT-LM as a TurboLLM engine, driven through Google's LiteRT-LM C library (ADR-482).
//!
//! The runtime this crate dlopens is pinned in `litert-runtime.json` and staged by `cargo xtask fetch-litert`.

pub mod api;
pub mod chunk;
pub mod prompt;
