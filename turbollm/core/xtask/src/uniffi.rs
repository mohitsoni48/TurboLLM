//! `uniffi-kotlin --lib <library> --out <dir>`: Kotlin bindings generated from a built `turbollm-ffi` library.

use std::env;
use std::path::{Path, PathBuf};

/// Where the built library is and where its Kotlin goes.
#[derive(Debug, PartialEq, Eq)]
pub struct KotlinRequest {
    pub library: PathBuf,
    pub out_dir: PathBuf,
}

/// Reads `--lib <path> --out <dir>`, in either order, both required.
pub fn kotlin_request(args: &[String]) -> Result<KotlinRequest, String> {
    let mut library = None;
    let mut out_dir = None;
    let mut words = args.iter();
    while let Some(flag) = words.next() {
        let slot = match flag.as_str() {
            "--lib" => &mut library,
            "--out" => &mut out_dir,
            _ => return Err(format!("uniffi-kotlin: unknown argument {flag:?}")),
        };
        let value = words.next().ok_or_else(|| missing(flag))?;
        *slot = Some(PathBuf::from(value));
    }
    Ok(KotlinRequest {
        library: library.ok_or_else(|| missing("--lib"))?,
        out_dir: out_dir.ok_or_else(|| missing("--out"))?,
    })
}

/// Writes the Kotlin for every UniFFI component in the library, configured by its crate's `uniffi.toml`.
/// `workspace` is where `cargo metadata` runs to find that file.
pub fn generate_kotlin(request: &KotlinRequest, workspace: &Path) -> Result<(), String> {
    let options = ::uniffi::GenerateOptions {
        languages: vec![::uniffi::TargetLanguage::Kotlin],
        source: utf8(&absolute(&request.library)?)?.into(),
        out_dir: utf8(&absolute(&request.out_dir)?)?.into(),
        metadata_no_deps: true,
        ..Default::default()
    };
    env::set_current_dir(workspace).map_err(|e| format!("{}: {e}", workspace.display()))?;
    ::uniffi::generate(options).map_err(|e| format!("uniffi-kotlin: {e:#}"))
}

fn missing(flag: &str) -> String {
    format!("uniffi-kotlin: {flag} <path> is required")
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    std::path::absolute(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn utf8(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("uniffi-kotlin: path is not UTF-8: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn lib_and_out_are_read_in_either_order() {
        let expected = KotlinRequest {
            library: PathBuf::from("target/release/turbollm_core_ffi.dll"),
            out_dir: PathBuf::from("out"),
        };
        let lib_first = args(&[
            "--lib",
            "target/release/turbollm_core_ffi.dll",
            "--out",
            "out",
        ]);
        let out_first = args(&[
            "--out",
            "out",
            "--lib",
            "target/release/turbollm_core_ffi.dll",
        ]);
        assert_eq!(kotlin_request(&lib_first), Ok(expected));
        assert_eq!(
            kotlin_request(&out_first).map(|request| request.out_dir),
            Ok(PathBuf::from("out"))
        );
    }

    #[test]
    fn a_missing_lib_is_refused() {
        let refused = kotlin_request(&args(&["--out", "out"])).unwrap_err();
        assert!(refused.contains("--lib"), "{refused}");
    }

    #[test]
    fn a_missing_out_is_refused() {
        let refused = kotlin_request(&args(&["--lib", "x.so"])).unwrap_err();
        assert!(refused.contains("--out"), "{refused}");
    }

    #[test]
    fn a_flag_without_its_value_is_refused() {
        let refused = kotlin_request(&args(&["--out", "out", "--lib"])).unwrap_err();
        assert!(refused.contains("--lib"), "{refused}");
    }

    #[test]
    fn an_unknown_argument_is_refused() {
        let refused =
            kotlin_request(&args(&["--lib", "x.so", "--out", "o", "--swift"])).unwrap_err();
        assert!(refused.contains("--swift"), "{refused}");
    }
}
