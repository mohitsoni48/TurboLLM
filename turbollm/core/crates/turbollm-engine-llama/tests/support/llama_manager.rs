//! A manager whose only engine is llama.cpp, in-process on every host, as the fake and the
//! real-native tests both drive it (2a's llama row is Android-only, so the tests bring their own).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use turbollm_engine::{
    Catalog, CatalogEntry, Engine, EngineManager, InProcess, ManagerConfig, PlatformKind,
    PlatformKinds,
};
use turbollm_engine_llama::LlamaBackend;
use turbollm_platform::HostFacts;

const MAX_QUEUED: usize = 8;

pub fn manager_over(backend: LlamaBackend, stall: Duration, cache_dir: PathBuf) -> EngineManager {
    let engine: Arc<dyn Engine> = Arc::new(InProcess::new(backend));
    let entry = CatalogEntry {
        descriptor: engine.descriptor().clone(),
        per_platform: in_process_everywhere(),
        engine,
    };
    EngineManager::new(ManagerConfig {
        catalog: Catalog::new(HostFacts::detect()).with_entry(entry),
        journal: None,
        predecessor: None,
        stall,
        max_queued: MAX_QUEUED,
        cache_dir,
    })
}

fn in_process_everywhere() -> PlatformKinds {
    PlatformKinds {
        android: PlatformKind::InProcess,
        ios: PlatformKind::InProcess,
        linux: PlatformKind::InProcess,
        windows: PlatformKind::InProcess,
        mac_os: PlatformKind::InProcess,
    }
}
