//! Which build of the llama session library runs on this CPU (port of `CpuVariant.kt`, ADR-455).

use std::path::{Path, PathBuf};

use libloading::Library;
use turbollm_engine::EngineError;
use turbollm_platform::{CpuFeatures, cpu_features_from_cpuinfo, library_candidates, read_cpuinfo};

/// The message when no variant this CPU can run opens (`CpuVariant.kt:25-28`).
pub const NO_VARIANT_RUNS_HERE: &str = "No llama.cpp library in this build runs on this CPU.";

/// One build of the session library, tuned for a CPU feature level. Declared best first; x86_64
/// ships `Base` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    I8mm,
    Dotprod,
    Base,
}

/// The library that opened and which variant it is, so the caller can say which file runs.
#[derive(Debug)]
pub struct VariantLibrary {
    pub variant: Variant,
    pub file: PathBuf,
    pub library: Library,
}

impl Variant {
    const BEST_FIRST: [Variant; 3] = [Variant::I8mm, Variant::Dotprod, Variant::Base];

    /// The library name without prefix or suffix: `turbollm_core_llama_dotprod`.
    pub fn library_stem(self) -> &'static str {
        match self {
            Variant::I8mm => "turbollm_core_llama_i8mm",
            Variant::Dotprod => "turbollm_core_llama_dotprod",
            Variant::Base => "turbollm_core_llama_base",
        }
    }

    /// `CpuVariant.kt:10-13`.
    fn required_features(self) -> &'static [&'static str] {
        match self {
            Variant::I8mm => &["asimddp", "i8mm"],
            Variant::Dotprod => &["asimddp"],
            Variant::Base => &[],
        }
    }

    fn runs_with(self, features: &CpuFeatures) -> bool {
        self.required_features()
            .iter()
            .all(|feature| features.contains(feature))
    }
}

/// The variants this CPU can run, best first.
pub fn candidates(features: &CpuFeatures) -> Vec<Variant> {
    Variant::BEST_FIRST
        .into_iter()
        .filter(|variant| variant.runs_with(features))
        .collect()
}

/// Opens the best variant this host's CPU runs from `dir` (or the loader's search path), falling
/// down the list when one does not open.
pub fn load_best(dir: Option<&Path>) -> Result<VariantLibrary, EngineError> {
    load_best_for(dir, &cpu_features_from_cpuinfo(&read_cpuinfo()))
}

fn load_best_for(
    dir: Option<&Path>,
    features: &CpuFeatures,
) -> Result<VariantLibrary, EngineError> {
    let (variant, (file, library)) =
        first_that_opens(&candidates(features), |variant| open_variant(variant, dir))?;
    Ok(VariantLibrary {
        variant,
        file,
        library,
    })
}

/// The first candidate `open` opens, with what it opened (`CpuVariant.kt:23-28`).
fn first_that_opens<L>(
    candidates: &[Variant],
    mut open: impl FnMut(Variant) -> Option<L>,
) -> Result<(Variant, L), EngineError> {
    candidates
        .iter()
        .find_map(|&variant| open(variant).map(|opened| (variant, opened)))
        .ok_or_else(|| crate::llama_unavailable(NO_VARIANT_RUNS_HERE))
}

/// The variant's library from `dir` when it is there, else from the loader's search path.
fn open_variant(variant: Variant, dir: Option<&Path>) -> Option<(PathBuf, Library)> {
    open_first(library_candidates(variant.library_stem(), dir))
}

/// The first of `files` that opens as a shared library, with the file it was.
fn open_first(files: Vec<PathBuf>) -> Option<(PathBuf, Library)> {
    files.into_iter().find_map(|file| {
        // SAFETY: a variant library's initialisers only set up llama.cpp's static state.
        let library = unsafe { Library::new(&file) }.ok()?;
        Some((file, library))
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;
    use turbollm_engine::{EngineId, EngineKind};
    use turbollm_platform::library_file_name;

    use super::*;

    const ARMV80: &str = include_str!("../../../fixtures/cpuinfo/armv80.txt");
    const ARMV9: &str = include_str!("../../../fixtures/cpuinfo/armv9.txt");
    const S21FE: &str = include_str!("../../../fixtures/cpuinfo/s21fe.txt");
    const X86: &str = include_str!("../../../fixtures/cpuinfo/x86.txt");

    #[test]
    fn an_armv9_core_with_i8mm_prefers_i8mm_then_dotprod_then_base() {
        assert_eq!(
            candidates_for(ARMV9),
            [Variant::I8mm, Variant::Dotprod, Variant::Base]
        );
    }

    #[test]
    fn the_s21_fe_has_dotprod_but_no_i8mm() {
        assert_eq!(candidates_for(S21FE), [Variant::Dotprod, Variant::Base]);
    }

    #[test]
    fn a_plain_armv80_core_gets_only_base() {
        assert_eq!(candidates_for(ARMV80), [Variant::Base]);
    }

    #[test]
    fn an_x86_cpu_has_no_features_line_and_gets_only_base() {
        assert_eq!(candidates_for(X86), [Variant::Base]);
    }

    #[test]
    fn features_are_matched_as_whole_words_not_substrings() {
        let sve_i8mm_only = "Features\t: fp asimd asimddp svei8mm\n";

        assert_eq!(
            candidates_for(sve_i8mm_only),
            [Variant::Dotprod, Variant::Base]
        );
    }

    #[test]
    fn i8mm_without_dotprod_is_not_enough_for_the_i8mm_build() {
        assert_eq!(
            candidates_for("Features\t: fp asimd i8mm\n"),
            [Variant::Base]
        );
    }

    #[test]
    fn a_feature_missing_on_any_core_is_not_used() {
        let mixed_cores = "Features\t: fp asimd asimddp i8mm\n\nFeatures\t: fp asimd asimddp\n";

        assert_eq!(
            candidates_for(mixed_cores),
            [Variant::Dotprod, Variant::Base]
        );
    }

    #[test]
    fn an_unreadable_cpuinfo_gets_only_base() {
        assert_eq!(candidates_for(""), [Variant::Base]);
    }

    #[test]
    fn the_best_variant_is_loaded_by_its_library_name() {
        let mut loaded = Vec::new();

        let (variant, _) = first_that_opens(&candidates_for(ARMV9), |variant| {
            loaded.push(variant.library_stem());
            Some(())
        })
        .unwrap();

        assert_eq!(variant, Variant::I8mm);
        assert_eq!(loaded, ["turbollm_core_llama_i8mm"]);
    }

    #[test]
    fn a_missing_i8mm_library_falls_back_to_dotprod() {
        let mut attempted = Vec::new();

        let (variant, _) = first_that_opens(&candidates_for(ARMV9), |variant| {
            attempted.push(variant.library_stem());
            (variant != Variant::I8mm).then_some(())
        })
        .unwrap();

        assert_eq!(variant, Variant::Dotprod);
        assert_eq!(
            attempted,
            ["turbollm_core_llama_i8mm", "turbollm_core_llama_dotprod"]
        );
    }

    #[test]
    fn no_loadable_variant_means_the_llama_cpp_engine_is_unavailable() {
        let mut attempted = Vec::new();

        let error = first_that_opens(&candidates_for(ARMV9), |variant| {
            attempted.push(variant.library_stem());
            None::<()>
        })
        .unwrap_err();

        assert_eq!(error, llama_unavailable());
        assert_eq!(
            attempted,
            [
                "turbollm_core_llama_i8mm",
                "turbollm_core_llama_dotprod",
                "turbollm_core_llama_base"
            ]
        );
    }

    #[test]
    fn a_corrupt_variant_file_does_not_open_so_its_variant_is_skipped() {
        let dir = TempDir::new().unwrap();
        let corrupt = dir
            .path()
            .join(library_file_name(Variant::Dotprod.library_stem()));
        fs::write(&corrupt, b"not a shared library").unwrap();
        let missing = dir
            .path()
            .join(library_file_name(Variant::Base.library_stem()));

        // Only files in the temp dir: the loader's search path, which differs per host, stays out.
        let opened = open_first(vec![corrupt, missing]);

        assert!(opened.is_none());
    }

    fn candidates_for(cpuinfo: &str) -> Vec<Variant> {
        candidates(&cpu_features_from_cpuinfo(cpuinfo))
    }

    fn llama_unavailable() -> EngineError {
        EngineError::EngineUnavailable {
            engine: EngineId::new(EngineId::LLAMA_CPP_CPU),
            kind: EngineKind::LlamaCpp,
            reason: NO_VARIANT_RUNS_HERE.to_owned(),
        }
    }
}
