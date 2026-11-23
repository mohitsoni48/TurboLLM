//! The 2a rows: the SDK's two engines, in-process on Android only. Desktop cells arrive with the
//! supervised kind (2b), iOS cells with Track I. ADR-239: no row for an engine that runs nowhere.

use std::sync::Arc;

use crate::catalog::{CatalogEntry, PlatformKind, PlatformKinds};
use crate::descriptor::{Backend, EngineDescriptor};
use crate::engine::Engine;
use crate::ids::{EngineId, EngineKind, ModelFormat};

const DESKTOP_IN_2B: PlatformKind = PlatformKind::Unsupported("desktop engines arrive in Phase 2b");
const IOS_IN_TRACK_I: PlatformKind = PlatformKind::Unsupported("iOS engines arrive with Track I");

impl CatalogEntry {
    /// `EngineCatalog.kt` `llamaCppCpuSlot`.
    pub fn llama_cpp_cpu(engine: Arc<dyn Engine>) -> CatalogEntry {
        CatalogEntry {
            descriptor: EngineDescriptor {
                id: EngineId::new(EngineId::LLAMA_CPP_CPU),
                name: "llama.cpp (CPU)".to_owned(),
                kind: EngineKind::LlamaCpp,
                formats: vec![ModelFormat::Gguf],
                backends: vec![Backend::Cpu],
            },
            per_platform: android_in_process(),
            engine,
        }
    }

    /// `EngineCatalog.kt` `liteRtLmSlot`.
    pub fn litert_lm(engine: Arc<dyn Engine>) -> CatalogEntry {
        CatalogEntry {
            descriptor: EngineDescriptor {
                id: EngineId::new(EngineId::LITERT_LM),
                name: "LiteRT-LM".to_owned(),
                kind: EngineKind::LitertLm,
                formats: vec![ModelFormat::Litertlm],
                backends: vec![Backend::Gpu, Backend::Cpu],
            },
            per_platform: android_in_process(),
            engine,
        }
    }
}

fn android_in_process() -> PlatformKinds {
    PlatformKinds {
        android: PlatformKind::InProcess,
        ios: IOS_IN_TRACK_I,
        linux: DESKTOP_IN_2B,
        windows: DESKTOP_IN_2B,
        mac_os: DESKTOP_IN_2B,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tests::{engine_probing, passing};
    use turbollm_platform::Os;

    #[test]
    fn llama_cpp_cpu_reads_gguf_on_the_cpu() {
        let entry = CatalogEntry::llama_cpp_cpu(engine_probing(passing()));
        assert_eq!(
            entry.descriptor,
            EngineDescriptor {
                id: EngineId::new(EngineId::LLAMA_CPP_CPU),
                name: "llama.cpp (CPU)".to_owned(),
                kind: EngineKind::LlamaCpp,
                formats: vec![ModelFormat::Gguf],
                backends: vec![Backend::Cpu],
            }
        );
    }

    #[test]
    fn litert_lm_reads_litertlm_on_the_gpu_or_the_cpu() {
        let entry = CatalogEntry::litert_lm(engine_probing(passing()));
        assert_eq!(
            entry.descriptor,
            EngineDescriptor {
                id: EngineId::new(EngineId::LITERT_LM),
                name: "LiteRT-LM".to_owned(),
                kind: EngineKind::LitertLm,
                formats: vec![ModelFormat::Litertlm],
                backends: vec![Backend::Gpu, Backend::Cpu],
            }
        );
    }

    #[test]
    fn both_sdk_engines_run_in_process_on_android_and_nowhere_else_yet() {
        let entries = [
            CatalogEntry::llama_cpp_cpu(engine_probing(passing())),
            CatalogEntry::litert_lm(engine_probing(passing())),
        ];
        for entry in entries {
            assert_eq!(entry.per_platform.on(Os::Android), PlatformKind::InProcess);
            for os in [Os::Ios, Os::Linux, Os::Windows, Os::MacOs] {
                assert!(
                    matches!(entry.per_platform.on(os), PlatformKind::Unsupported(_)),
                    "{os:?}"
                );
            }
        }
    }
}
