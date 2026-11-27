//! `uniffi-kotlin --lib <library> --out <dir>`: Kotlin bindings generated from a built `turbollm-ffi` library.

use std::env;
use std::fs;
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
    ::uniffi::generate(options).map_err(|e| format!("uniffi-kotlin: {e:#}"))?;
    keep_generated_jna_threads_attached(&absolute(&request.out_dir)?)
}

const CONTINUATION_CALLBACK: &str = "internal object uniffiRustFutureContinuationCallbackImpl:";
const CALLBACK_SIGNATURE: &str = "override fun callback(";
const KEEP_ATTACHED: &str = "com.sun.jna.Native.detach(false)";

/// Applies [`keep_jna_threads_attached`] to every generated Kotlin file that implements JNA callbacks.
pub fn keep_generated_jna_threads_attached(out_dir: &Path) -> Result<(), String> {
    let mut patched = 0;
    for file in kotlin_files(out_dir)? {
        let kotlin = fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        if !kotlin.contains(CALLBACK_SIGNATURE) {
            continue;
        }
        let kept =
            keep_jna_threads_attached(&kotlin).map_err(|e| format!("{}: {e}", file.display()))?;
        fs::write(&file, kept).map_err(|e| format!("{}: {e}", file.display()))?;
        patched += 1;
    }
    if patched == 0 {
        return Err(format!(
            "uniffi-kotlin: no generated Kotlin in {} implements a JNA callback; the JNA detach patch found nothing to hook",
            out_dir.display()
        ));
    }
    Ok(())
}

/// Makes every UniFFI callback into Kotlin keep its native thread attached to the VM until the thread exits.
///
/// JNA attaches a Rust thread when it first calls into Kotlin and, by default, detaches it when that callback
/// returns. The flag is per thread, not per callback: when a callback re-enters Rust and Rust calls back into Kotlin
/// on the same thread (a coroutine resuming on the core's worker, which polls a finished future, whose continuation
/// UniFFI then runs inline), the inner callback's return detaches the thread under the outer one's Java frames. A
/// desktop JVM refuses that ("JNA: could not detach thread"); ART aborts the app ("attempting to detach while still
/// running code"). `Native.detach(false)` leaves the thread attached; JNA detaches it when the thread exits.
///
/// The generated shape is checked, not assumed: the patch is refused when the continuation callback is missing, when
/// a callback's body does not open on its signature line, or when the source is already patched.
pub fn keep_jna_threads_attached(kotlin: &str) -> Result<String, String> {
    if !kotlin.contains(CONTINUATION_CALLBACK) {
        return Err(format!(
            "uniffi-kotlin: the generated Kotlin has no `{CONTINUATION_CALLBACK}`; the JNA detach patch cannot hook it"
        ));
    }
    if kotlin.contains(KEEP_ATTACHED) {
        return Err(format!(
            "uniffi-kotlin: the generated Kotlin already calls {KEEP_ATTACHED}"
        ));
    }
    let mut patched = String::with_capacity(kotlin.len() + 4096);
    for line in kotlin.split_inclusive('\n') {
        patched.push_str(line);
        let signature = line.trim_end();
        let code = signature.trim_start();
        if !code.starts_with(CALLBACK_SIGNATURE) {
            continue;
        }
        if !code.ends_with(" {") {
            return Err(format!(
                "uniffi-kotlin: the body of `{code}` does not open on its line; the JNA detach patch cannot hook it"
            ));
        }
        let indent = signature.len() - code.len() + 4;
        patched.push_str(&format!("{}{KEEP_ATTACHED}\n", " ".repeat(indent)));
    }
    Ok(patched)
}

fn kotlin_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let path = entry.map_err(|e| format!("{}: {e}", dir.display()))?.path();
        if path.is_dir() {
            files.extend(kotlin_files(&path)?);
        } else if path.extension().is_some_and(|ext| ext == "kt") {
            files.push(path);
        }
    }
    Ok(files)
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

    /// Excerpts of uniffi 0.32.2's Kotlin output for turbollm-ffi, byte for byte: the async continuation, a trait
    /// vtable method, and a trait's free and clone callbacks.
    const GENERATED: &str = "\
internal object uniffiRustFutureContinuationCallbackImpl: UniffiRustFutureContinuationCallback {
    override fun callback(data: Long, pollResult: Byte) {
        uniffiContinuationHandleMap.remove(data).resume(pollResult)
    }
}

internal object uniffiCallbackInterfaceCoreForeignModel {
    internal object `generate`: UniffiCallbackInterfaceCoreForeignModelMethod1 {
        override fun callback(`uniffiHandle`: Long,`request`: RustBuffer.ByValue,`sink`: Long,`uniffiOutReturn`: Pointer,uniffiCallStatus: UniffiRustCallStatus,) {
            val uniffiObj = FfiConverterTypeCoreForeignModel.handleMap.get(uniffiHandle)
        }
    }
    internal object uniffiFree: UniffiCallbackInterfaceFree {
        override fun callback(handle: Long) {
            FfiConverterTypeCoreForeignModel.handleMap.remove(handle)
        }
    }
    internal object uniffiClone: UniffiCallbackInterfaceClone {
        override fun callback(handle: Long): Long {
            return FfiConverterTypeCoreForeignModel.handleMap.clone(handle)
        }
    }
}
";

    fn callbacks_and_their_first_statements(kotlin: &str) -> Vec<(String, String)> {
        let lines: Vec<&str> = kotlin.lines().collect();
        lines
            .windows(2)
            .filter(|pair| pair[0].trim_start().starts_with("override fun callback("))
            .map(|pair| (pair[0].to_owned(), pair[1].to_owned()))
            .collect()
    }

    #[test]
    fn every_jna_callback_first_keeps_its_thread_attached() {
        let patched = keep_jna_threads_attached(GENERATED).unwrap();

        let callbacks = callbacks_and_their_first_statements(&patched);
        assert_eq!(callbacks.len(), 4, "{patched}");
        for (signature, first) in callbacks {
            let indent = signature.len() - signature.trim_start().len() + 4;
            assert_eq!(
                first,
                format!("{}com.sun.jna.Native.detach(false)", " ".repeat(indent)),
                "{patched}"
            );
        }
        assert!(
            patched
                .contains("        uniffiContinuationHandleMap.remove(data).resume(pollResult)\n")
        );
    }

    #[test]
    fn output_without_the_continuation_callback_is_refused() {
        let without =
            GENERATED.replace("uniffiRustFutureContinuationCallbackImpl", "somethingElse");
        let refused = keep_jna_threads_attached(&without).unwrap_err();
        assert!(
            refused.contains("uniffiRustFutureContinuationCallbackImpl"),
            "{refused}"
        );
    }

    #[test]
    fn a_callback_whose_body_does_not_open_on_its_line_is_refused() {
        let reshaped = GENERATED.replace(
            "override fun callback(handle: Long) {",
            "override fun callback(handle: Long)\n        {",
        );
        let refused = keep_jna_threads_attached(&reshaped).unwrap_err();
        assert!(
            refused.contains("override fun callback(handle: Long)"),
            "{refused}"
        );
    }

    #[test]
    fn already_patched_output_is_refused_rather_than_patched_twice() {
        let once = keep_jna_threads_attached(GENERATED).unwrap();
        assert!(keep_jna_threads_attached(&once).is_err());
    }

    #[test]
    fn every_generated_kotlin_file_in_the_output_is_patched() {
        let out = tempfile::tempdir().unwrap();
        let package = out.path().join("dev/turbollm/core");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("turbollm_core_ffi.kt"), GENERATED).unwrap();

        keep_generated_jna_threads_attached(out.path()).unwrap();

        let patched = std::fs::read_to_string(package.join("turbollm_core_ffi.kt")).unwrap();
        assert_eq!(
            patched.matches("com.sun.jna.Native.detach(false)").count(),
            4
        );
    }

    #[test]
    fn an_output_folder_without_the_continuation_callback_is_refused() {
        let out = tempfile::tempdir().unwrap();
        std::fs::write(out.path().join("other.kt"), "package x\n").unwrap();
        assert!(keep_generated_jna_threads_attached(out.path()).is_err());
    }

    #[test]
    fn an_unknown_argument_is_refused() {
        let refused =
            kotlin_request(&args(&["--lib", "x.so", "--out", "o", "--swift"])).unwrap_err();
        assert!(refused.contains("--swift"), "{refused}");
    }
}
