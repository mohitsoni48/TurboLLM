//! ADR-462's resolve rules (port of `EngineCatalog.kt:53-120`): with no engine named, a model runs on
//! the first available engine that reads its format; a named engine is pinned and never falls back.

use std::sync::Arc;

use crate::catalog::{Catalog, CatalogEntry};
use crate::engine::Engine;
use crate::error::{EngineError, InvalidReason};
use crate::ids::{EngineId, ModelFormat};

const ENGINE_PARAM: &str = "engine";

impl Catalog {
    /// Validates before any load is accepted: the engine a model of `format` runs on.
    pub fn resolve(
        &self,
        format: ModelFormat,
        requested: Option<&EngineId>,
    ) -> Result<EngineId, EngineError> {
        let entry = match requested {
            None => self.first_available_reader_of(format)?,
            Some(id) => self.pinned(id, format)?,
        };
        Ok(entry.descriptor.id.clone())
    }

    /// The engine a resolved load names.
    pub fn engine(&self, id: &EngineId) -> Result<Arc<dyn Engine>, EngineError> {
        Ok(Arc::clone(&self.entry(id)?.engine))
    }

    fn first_available_reader_of(&self, format: ModelFormat) -> Result<&CatalogEntry, EngineError> {
        let mut first_refusal = None;
        for reader in self.readers_of(format) {
            match self.why_unavailable(reader) {
                None => return Ok(reader),
                Some(reason) => {
                    first_refusal.get_or_insert_with(|| unavailable_because(reader, reason));
                }
            }
        }
        Err(first_refusal.unwrap_or_else(|| no_reader_of(format)))
    }

    fn pinned(
        &self,
        requested: &EngineId,
        format: ModelFormat,
    ) -> Result<&CatalogEntry, EngineError> {
        let entry = self.entry(requested)?;
        if !entry.descriptor.formats.contains(&format) {
            return Err(cannot_read(entry, format));
        }
        match self.why_unavailable(entry) {
            Some(reason) => Err(unavailable_because(entry, reason)),
            None => Ok(entry),
        }
    }

    fn readers_of(&self, format: ModelFormat) -> impl Iterator<Item = &CatalogEntry> {
        self.hosted_entries()
            .filter(move |entry| entry.descriptor.formats.contains(&format))
    }

    fn entry(&self, id: &EngineId) -> Result<&CatalogEntry, EngineError> {
        self.hosted_entries()
            .find(|entry| entry.descriptor.id == *id)
            .ok_or_else(|| unknown_engine(id))
    }
}

fn unavailable_because(entry: &CatalogEntry, reason: String) -> EngineError {
    EngineError::EngineUnavailable {
        engine: entry.descriptor.id.clone(),
        kind: entry.descriptor.kind,
        reason,
    }
}

fn cannot_read(entry: &CatalogEntry, format: ModelFormat) -> EngineError {
    let descriptor = &entry.descriptor;
    EngineError::InvalidRequest {
        param: Some(ENGINE_PARAM.to_owned()),
        reason: InvalidReason::EngineFormatMismatch,
        message: format!(
            "{} ({}) can't read {} models.",
            descriptor.name,
            descriptor.id,
            display_name(format)
        ),
    }
}

fn unknown_engine(requested: &EngineId) -> EngineError {
    EngineError::InvalidRequest {
        param: Some(ENGINE_PARAM.to_owned()),
        reason: InvalidReason::UnknownEngine,
        message: format!("This SDK has no engine named {requested}."),
    }
}

/// Kotlin's `checkNotNull` here was an internal error; no SDK build lacks a reader of either format.
fn no_reader_of(format: ModelFormat) -> EngineError {
    EngineError::EngineFailure(format!(
        "No engine in this SDK reads {} models.",
        display_name(format)
    ))
}

fn display_name(format: ModelFormat) -> &'static str {
    match format {
        ModelFormat::Gguf => "GGUF",
        ModelFormat::Litertlm => ".litertlm",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogEntry;
    use crate::catalog::tests::{engine_probing, failing, host, id, passing, sdk_catalog};
    use crate::descriptor::{Backend, EngineDescriptor};
    use crate::engine::{AbortSignal, LoadControl};
    use crate::error::InvalidReason;
    use crate::ids::EngineKind;
    use crate::inprocess::InProcess;
    use crate::request::LoadSpec;
    use crate::testing::ScriptedBackend;
    use std::path::PathBuf;
    use turbollm_platform::Os;

    fn llama() -> EngineId {
        id(EngineId::LLAMA_CPP_CPU)
    }

    fn litert() -> EngineId {
        id(EngineId::LITERT_LM)
    }

    fn second_gguf_reader() -> EngineDescriptor {
        EngineDescriptor {
            id: id("gguf-two"),
            name: "GGUF two".to_owned(),
            kind: EngineKind::LlamaCpp,
            formats: vec![ModelFormat::Gguf],
            backends: vec![Backend::Cpu],
        }
    }

    fn passing_catalog() -> Catalog {
        sdk_catalog(passing(), passing())
    }

    fn invalid_request(error: EngineError) -> (Option<String>, InvalidReason, String) {
        match error {
            EngineError::InvalidRequest {
                param,
                reason,
                message,
            } => (param, reason, message),
            other => panic!("expected InvalidRequest, got {other:?}"),
        }
    }

    fn unavailable(error: EngineError) -> (EngineId, EngineKind, String) {
        match error {
            EngineError::EngineUnavailable {
                engine,
                kind,
                reason,
            } => (engine, kind, reason),
            other => panic!("expected EngineUnavailable, got {other:?}"),
        }
    }

    fn spec() -> LoadSpec {
        LoadSpec {
            path: PathBuf::from("model.gguf"),
            context_size: None,
            threads: 4,
            backend: Backend::Cpu,
            cache_dir: PathBuf::from("cache"),
        }
    }

    fn control() -> LoadControl {
        LoadControl {
            progress: Arc::new(|_| {}),
            abort: AbortSignal::new(),
        }
    }

    #[test]
    fn with_no_engine_named_a_gguf_goes_to_llama_cpp_and_a_bundle_to_litert_lm() {
        let catalog = passing_catalog();
        assert_eq!(catalog.resolve(ModelFormat::Gguf, None), Ok(llama()));
        assert_eq!(catalog.resolve(ModelFormat::Litertlm, None), Ok(litert()));
    }

    #[test]
    fn a_named_engine_that_reads_the_format_is_the_one_used() {
        let resolved = passing_catalog().resolve(ModelFormat::Litertlm, Some(&litert()));
        assert_eq!(resolved, Ok(litert()));
    }

    #[test]
    fn an_engine_the_sdk_does_not_have_is_an_unknown_engine_refusal() {
        let refusal = passing_catalog()
            .resolve(ModelFormat::Gguf, Some(&id("nope")))
            .unwrap_err();
        assert_eq!(
            invalid_request(refusal),
            (
                Some("engine".to_owned()),
                InvalidReason::UnknownEngine,
                "This SDK has no engine named nope.".to_owned()
            )
        );
    }

    #[test]
    fn litert_lm_asked_to_run_a_gguf_is_a_format_mismatch_that_names_both() {
        let refusal = passing_catalog()
            .resolve(ModelFormat::Gguf, Some(&litert()))
            .unwrap_err();
        assert_eq!(
            invalid_request(refusal),
            (
                Some("engine".to_owned()),
                InvalidReason::EngineFormatMismatch,
                "LiteRT-LM (litert-lm) can't read GGUF models.".to_owned()
            )
        );
    }

    #[test]
    fn llama_cpp_asked_to_run_a_bundle_is_a_format_mismatch_naming_the_bundle_format() {
        let refusal = passing_catalog()
            .resolve(ModelFormat::Litertlm, Some(&llama()))
            .unwrap_err();
        assert_eq!(
            invalid_request(refusal).2,
            "llama.cpp (CPU) (llama.cpp-cpu) can't read .litertlm models."
        );
    }

    #[test]
    fn a_named_engine_that_cannot_run_here_is_refused_without_falling_back_to_another() {
        let catalog = sdk_catalog(passing(), failing("No LiteRT-LM here."));
        let refusal = catalog
            .resolve(ModelFormat::Litertlm, Some(&litert()))
            .unwrap_err();
        assert_eq!(
            unavailable(refusal),
            (
                litert(),
                EngineKind::LitertLm,
                "No LiteRT-LM here.".to_owned()
            )
        );
    }

    #[test]
    fn a_named_engine_is_pinned_even_when_another_reader_of_the_format_is_available() {
        let catalog = Catalog::new(host(Os::Android))
            .with_entry(CatalogEntry::llama_cpp_cpu(engine_probing(failing(
                "pinned out",
            ))))
            .with_entry(CatalogEntry {
                descriptor: second_gguf_reader(),
                ..CatalogEntry::llama_cpp_cpu(engine_probing(passing()))
            });
        assert_eq!(catalog.resolve(ModelFormat::Gguf, None), Ok(id("gguf-two")));
        let refusal = catalog
            .resolve(ModelFormat::Gguf, Some(&llama()))
            .unwrap_err();
        assert_eq!(unavailable(refusal).2, "pinned out");
    }

    #[test]
    fn with_no_engine_named_and_no_reader_available_the_first_reader_explains_why() {
        let catalog = sdk_catalog(
            failing("No llama.cpp library in this build runs on this CPU."),
            passing(),
        );
        let refusal = catalog.resolve(ModelFormat::Gguf, None).unwrap_err();
        assert_eq!(
            unavailable(refusal),
            (
                llama(),
                EngineKind::LlamaCpp,
                "No llama.cpp library in this build runs on this CPU.".to_owned()
            )
        );
    }

    #[test]
    fn with_no_reader_of_the_format_at_all_the_refusal_says_so() {
        let catalog = Catalog::new(host(Os::Android))
            .with_entry(CatalogEntry::llama_cpp_cpu(engine_probing(passing())));
        let refusal = catalog.resolve(ModelFormat::Litertlm, None).unwrap_err();
        assert_eq!(
            refusal,
            EngineError::EngineFailure("No engine in this SDK reads .litertlm models.".to_owned())
        );
    }

    #[test]
    fn an_engine_marked_unavailable_stays_unavailable_for_routing() {
        let catalog = passing_catalog();
        catalog.mark_unavailable(&litert(), "The LiteRT-LM library did not link.".to_owned());
        for requested in [None, Some(&litert())] {
            let refusal = catalog
                .resolve(ModelFormat::Litertlm, requested)
                .unwrap_err();
            assert_eq!(
                unavailable(refusal).2,
                "The LiteRT-LM library did not link."
            );
        }
    }

    #[test]
    fn a_mark_wins_over_a_passing_probe_for_the_catalogues_lifetime() {
        let catalog = passing_catalog();
        catalog.mark_unavailable(&llama(), "did not link".to_owned());
        for _ in 0..3 {
            assert!(catalog.resolve(ModelFormat::Gguf, None).is_err());
        }
    }

    #[test]
    fn an_engine_not_in_process_here_is_unknown() {
        let catalog = Catalog::new(host(Os::Windows))
            .with_entry(CatalogEntry::llama_cpp_cpu(engine_probing(passing())));
        let refusal = catalog
            .resolve(ModelFormat::Gguf, Some(&llama()))
            .unwrap_err();
        assert_eq!(invalid_request(refusal).1, InvalidReason::UnknownEngine);
        assert!(catalog.engine(&llama()).is_err());
    }

    #[test]
    fn gguf_models_go_to_the_llama_cpp_engine() {
        let llama_engine = engine_probing(passing());
        let catalog = Catalog::new(host(Os::Android))
            .with_entry(CatalogEntry::llama_cpp_cpu(Arc::clone(&llama_engine)))
            .with_entry(CatalogEntry::litert_lm(engine_probing(passing())));
        let resolved = catalog.resolve(ModelFormat::Gguf, None).unwrap();
        assert!(Arc::ptr_eq(
            &catalog.engine(&resolved).unwrap(),
            &llama_engine
        ));
    }

    #[test]
    fn litert_models_go_to_the_litert_lm_engine() {
        let litert_engine = engine_probing(passing());
        let catalog = Catalog::new(host(Os::Android))
            .with_entry(CatalogEntry::llama_cpp_cpu(engine_probing(passing())))
            .with_entry(CatalogEntry::litert_lm(Arc::clone(&litert_engine)));
        let resolved = catalog.resolve(ModelFormat::Litertlm, None).unwrap();
        assert!(Arc::ptr_eq(
            &catalog.engine(&resolved).unwrap(),
            &litert_engine
        ));
    }

    #[test]
    fn an_unknown_engine_cannot_be_fetched() {
        let refusal = passing_catalog().engine(&id("nope")).err().unwrap();
        assert_eq!(
            invalid_request(refusal).2,
            "This SDK has no engine named nope."
        );
    }

    #[tokio::test]
    async fn every_load_gets_a_fresh_model_from_the_engine() {
        let backend = ScriptedBackend::new(Vec::new());
        let record = backend.record();
        let catalog = Catalog::new(host(Os::Android)).with_entry(CatalogEntry::llama_cpp_cpu(
            Arc::new(InProcess::new(backend)),
        ));
        let engine = catalog
            .engine(&catalog.resolve(ModelFormat::Gguf, None).unwrap())
            .unwrap();

        let first = engine.load(spec(), control()).await.unwrap();
        let second = engine.load(spec(), control()).await.unwrap();
        first.close().await;
        second.close().await;

        let opens = record
            .history()
            .iter()
            .filter(|seen| *seen == "open")
            .count();
        assert_eq!(opens, 2);
    }
}
