use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The file name a shared library called `stem` has on this OS: `x.dll`, `libx.so`, `libx.dylib`.
pub fn library_file_name(stem: &str) -> OsString {
    libloading::library_filename(stem)
}

/// Where to look for the library, in order: `dir/<file>` when that file exists, then the bare file
/// name, which the OS loader resolves on its own search path.
pub fn library_candidates(stem: &str, dir: Option<&Path>) -> Vec<PathBuf> {
    let file_name = library_file_name(stem);
    let in_dir = dir
        .map(|dir| dir.join(&file_name))
        .filter(|path| path.is_file());
    in_dir
        .into_iter()
        .chain([PathBuf::from(file_name)])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[cfg(windows)]
    #[test]
    fn on_windows_a_library_is_a_dll() {
        assert_eq!(library_file_name("x"), "x.dll");
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn on_linux_and_android_a_library_is_a_lib_so() {
        assert_eq!(library_file_name("x"), "libx.so");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_a_library_is_a_lib_dylib() {
        assert_eq!(library_file_name("x"), "libx.dylib");
    }

    #[test]
    fn a_library_present_in_the_directory_comes_before_the_bare_file_name() {
        let dir = TempDir::new().unwrap();
        let in_dir = dir.path().join(library_file_name("x"));
        fs::write(&in_dir, b"").unwrap();

        assert_eq!(
            library_candidates("x", Some(dir.path())),
            [in_dir, bare_name("x")]
        );
    }

    #[test]
    fn a_directory_without_the_library_leaves_only_the_bare_file_name() {
        let dir = TempDir::new().unwrap();

        assert_eq!(library_candidates("x", Some(dir.path())), [bare_name("x")]);
    }

    #[test]
    fn no_directory_gives_only_the_bare_file_name() {
        assert_eq!(library_candidates("x", None), [bare_name("x")]);
    }

    fn bare_name(stem: &str) -> PathBuf {
        PathBuf::from(library_file_name(stem))
    }
}
