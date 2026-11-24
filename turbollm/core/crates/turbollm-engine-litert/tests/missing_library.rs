//! `LiteRtBackend::new`: where the runtime library is looked for, and what a load says when it is
//! not there (arch 3.7). No LiteRT library is needed.

use std::path::PathBuf;

use tempfile::TempDir;
use turbollm_engine::{
    AbortSignal, Backend, EngineError, EngineId, EngineKind, LoadControl, LoadSpec, NativeBackend,
};
use turbollm_engine_litert::{LIBRARY_STEM, LiteRtBackend};
use turbollm_platform::library_file_name;

fn spec() -> LoadSpec {
    LoadSpec {
        path: PathBuf::from("model.litertlm"),
        context_size: None,
        threads: 1,
        backend: Backend::Cpu,
        cache_dir: PathBuf::from("cache"),
    }
}

fn control() -> LoadControl {
    LoadControl {
        progress: std::sync::Arc::new(|_| {}),
        abort: AbortSignal::new(),
    }
}

#[test]
fn the_runtime_is_staged_as_turbollm_core_litertlm() {
    assert_eq!(LIBRARY_STEM, "turbollm_core_litertlm");
    let name = library_file_name(LIBRARY_STEM);
    assert!(name.to_string_lossy().contains("turbollm_core_litertlm"));
    assert!(!name.to_string_lossy().contains("litert-lm"));
}

#[test]
fn a_load_without_the_library_is_unavailable_with_the_architecture_text() {
    let empty = TempDir::new().unwrap();
    let backend = LiteRtBackend::new(Some(empty.path().to_path_buf()));

    let failure = backend.open(&spec(), &control()).err().expect("no library");

    match failure {
        EngineError::EngineUnavailable {
            engine,
            kind,
            reason,
        } => {
            assert_eq!(engine, EngineId::new(EngineId::LITERT_LM));
            assert_eq!(kind, EngineKind::LitertLm);
            assert!(
                reason.starts_with("LiteRT-LM cannot run on this device: "),
                "{reason}"
            );
        }
        other => panic!("expected EngineUnavailable, got {other:?}"),
    }
}

#[test]
fn a_file_in_the_library_folder_that_is_not_a_library_is_unavailable_too() {
    let dir = TempDir::new().unwrap();
    std::fs::write(
        dir.path().join(library_file_name(LIBRARY_STEM)),
        b"not a library",
    )
    .unwrap();
    let backend = LiteRtBackend::new(Some(dir.path().to_path_buf()));

    let failure = backend.open(&spec(), &control()).err().expect("no library");

    assert!(
        matches!(failure, EngineError::EngineUnavailable { .. }),
        "{failure:?}"
    );
}
