use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};
use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

const TREE_DIR: &str = "llama.cpp";
const COMMIT_MARKER: &str = ".turbollm-commit";
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const USAGE: &str = "usage: cargo xtask fetch-llama --out <dir>";
const BUILD_USAGE: &str = "usage: cargo xtask build-llama --host [--variant base]";
const DEFAULT_VARIANT: &str = "base";
const RELEASE: &str = "Release";

/// The llama.cpp fork commit the engine builds from, as pinned in `llama-source.json`.
#[derive(Debug)]
pub struct LlamaSource {
    pub repo: String,
    pub commit: String,
    pub sha256: String,
}

impl LlamaSource {
    pub fn archive_url(&self) -> String {
        format!(
            "https://github.com/{}/archive/{}.tar.gz",
            self.repo, self.commit
        )
    }
}

pub trait ArchiveFetcher {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}

pub struct SourcePlaces {
    pub cache_dir: PathBuf,
    pub out_dir: PathBuf,
}

#[derive(Debug, PartialEq)]
pub enum ArchiveOrigin {
    CacheHit,
    Downloaded,
}

impl fmt::Display for ArchiveOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ArchiveOrigin::CacheHit => "cache hit",
            ArchiveOrigin::Downloaded => "downloaded",
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum FetchOutcome {
    AlreadyExtracted {
        tree: PathBuf,
    },
    Extracted {
        tree: PathBuf,
        origin: ArchiveOrigin,
        sha256: String,
    },
}

pub fn parse_source(json: &str) -> Result<LlamaSource, String> {
    let pin: Value = serde_json::from_str(json).map_err(|e| format!("llama-source.json: {e}"))?;
    Ok(LlamaSource {
        repo: pinned_field(&pin, "repo")?,
        commit: pinned_field(&pin, "commit")?,
        sha256: pinned_field(&pin, "sha256")?,
    })
}

pub fn out_dir_arg(args: &[String]) -> Result<PathBuf, String> {
    match args {
        [flag, dir] if flag == "--out" => Ok(PathBuf::from(dir)),
        _ => Err(USAGE.to_string()),
    }
}

/// Puts the pinned source tree at `<out>/llama.cpp`, from the commit-keyed cache when it holds the archive.
pub fn fetch_llama(
    source: &LlamaSource,
    places: &SourcePlaces,
    fetcher: &dyn ArchiveFetcher,
) -> Result<FetchOutcome, String> {
    let tree = places.out_dir.join(TREE_DIR);
    if extracted_commit(&tree).as_deref() == Some(source.commit.as_str()) {
        return Ok(FetchOutcome::AlreadyExtracted { tree });
    }
    let (archive, origin) = verified_archive(source, &places.cache_dir, fetcher)?;
    replace_tree(&tree, &archive, &source.commit)?;
    Ok(FetchOutcome::Extracted {
        tree,
        origin,
        sha256: source.sha256.clone(),
    })
}

/// Downloads over HTTPS, trusting the operating system's root certificates.
pub struct HttpsFetcher;

impl ArchiveFetcher for HttpsFetcher {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let tls = TlsConfig::builder()
            .provider(TlsProvider::NativeTls)
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let agent: ureq::Agent = ureq::Agent::config_builder().tls_config(tls).build().into();
        let mut response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
        response
            .body_mut()
            .with_config()
            .limit(MAX_ARCHIVE_BYTES)
            .read_to_vec()
            .map_err(|e| format!("{url}: {e}"))
    }
}

fn pinned_field(pin: &Value, name: &str) -> Result<String, String> {
    pin.get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("llama-source.json: missing string field {name:?}"))
}

fn extracted_commit(tree: &Path) -> Option<String> {
    fs::read_to_string(tree.join(COMMIT_MARKER))
        .ok()
        .map(|commit| commit.trim().to_string())
}

/// The hash is checked on every use: a download is cached only once it matches the pin, and a
/// cached archive that no longer matches is removed, so one bad response cannot break later runs.
fn verified_archive(
    source: &LlamaSource,
    cache_dir: &Path,
    fetcher: &dyn ArchiveFetcher,
) -> Result<(Vec<u8>, ArchiveOrigin), String> {
    let cached = cache_dir.join(format!("{}.tar.gz", source.commit));
    if cached.is_file() {
        let archive = fs::read(&cached).map_err(io_error(&cached))?;
        verify_sha256(source, &archive).map_err(|mismatch| forget_cached(&cached, &mismatch))?;
        return Ok((archive, ArchiveOrigin::CacheHit));
    }
    let archive = fetcher.fetch(&source.archive_url())?;
    verify_sha256(source, &archive)?;
    write_through_partial(&cached, &archive)?;
    Ok((archive, ArchiveOrigin::Downloaded))
}

pub fn forget_cached(cached: &Path, mismatch: &str) -> String {
    match fs::remove_file(cached) {
        Ok(()) => format!(
            "{mismatch}; removed the cached archive {}, the next run downloads it again",
            cached.display()
        ),
        Err(e) => format!(
            "{mismatch}; could not remove the cached archive {}: {e}",
            cached.display()
        ),
    }
}

/// Writes through a `.partial` file and renames it into place, so a reader never sees half a file.
pub fn write_through_partial(file: &Path, contents: &[u8]) -> Result<(), String> {
    let folder = file.parent().expect("the file lives in a folder");
    fs::create_dir_all(folder).map_err(io_error(folder))?;
    let partial = file.with_extension("partial");
    fs::write(&partial, contents).map_err(io_error(&partial))?;
    fs::rename(&partial, file).map_err(io_error(file))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn verify_sha256(source: &LlamaSource, archive: &[u8]) -> Result<(), String> {
    let actual = sha256_hex(archive);
    if actual != source.sha256 {
        return Err(format!(
            "llama.cpp archive {}: sha256 mismatch, expected {:?} (llama-source.json), actual {actual}",
            source.commit, source.sha256
        ));
    }
    Ok(())
}

/// Unpacks next to the tree and swaps it in last, so a failed run never leaves a marked, half-written tree.
fn replace_tree(tree: &Path, archive: &[u8], commit: &str) -> Result<(), String> {
    let staging = tree.with_file_name(format!("{TREE_DIR}.partial"));
    remove_if_present(&staging)?;
    if let Err(problem) = unpack_below_top_folder(archive, &staging) {
        remove_if_present(&staging)?;
        return Err(problem);
    }
    let marker = staging.join(COMMIT_MARKER);
    fs::write(&marker, commit).map_err(io_error(&marker))?;
    remove_if_present(tree)?;
    fs::rename(&staging, tree).map_err(io_error(tree))
}

fn unpack_below_top_folder(archive: &[u8], destination: &Path) -> Result<(), String> {
    let mut tarball = tar::Archive::new(GzDecoder::new(archive));
    let entries = tarball.entries().map_err(archive_error)?;
    for entry in entries {
        let mut entry = entry.map_err(archive_error)?;
        let entry_path = entry.path().map_err(archive_error)?.into_owned();
        let Some(inside) = path_below_top_folder(&entry_path)? else {
            continue;
        };
        refuse_special_entry(entry.header().entry_type(), &entry_path)?;
        let target = destination.join(inside);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_error(parent))?;
        }
        entry.unpack(&target).map_err(io_error(&target))?;
    }
    Ok(())
}

/// GitHub archives hold one top folder named after the repo and commit; `None` is that folder itself
/// (or the pax header beside it).
fn path_below_top_folder(entry_path: &Path) -> Result<Option<PathBuf>, String> {
    if entry_path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "llama.cpp archive entry {} leaves the source tree",
            entry_path.display()
        ));
    }
    let inside: PathBuf = entry_path.components().skip(1).collect();
    Ok((!inside.as_os_str().is_empty()).then_some(inside))
}

/// Only files and folders are unpacked: a link could carry a later entry outside the tree.
fn refuse_special_entry(kind: tar::EntryType, entry_path: &Path) -> Result<(), String> {
    if kind.is_file() || kind.is_dir() {
        return Ok(());
    }
    let what = if kind.is_symlink() || kind.is_hard_link() {
        "a link".to_string()
    } else {
        format!("a {kind:?} entry")
    };
    Err(format!(
        "llama.cpp archive entry {} is {what}",
        entry_path.display()
    ))
}

fn remove_if_present(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(io_error(dir))?;
    }
    Ok(())
}

/// What `build-llama --host [--variant <name>]` builds; only the host build exists (Android builds run in Gradle).
pub fn build_variant_arg(args: &[String]) -> Result<String, String> {
    match args {
        [host] if host == "--host" => Ok(DEFAULT_VARIANT.to_string()),
        [host, flag, variant] if host == "--host" && flag == "--variant" => Ok(variant.clone()),
        _ => Err(BUILD_USAGE.to_string()),
    }
}

/// The CMake generator for a host OS (`std::env::consts::OS`); `None` leaves CMake's default.
/// Visual Studio finds MSVC without a developer prompt, which a `cl`-less PATH needs (plan P-8).
pub fn host_generator(os: &str, ninja_on_path: bool) -> Option<&'static str> {
    if os == "windows" {
        return Some("Visual Studio 17 2022");
    }
    ninja_on_path.then_some("Ninja")
}

/// Whether `program` (without its OS suffix) is a file in one of the folders of a `PATH` value.
pub fn on_path(path_var: &OsStr, program: &str) -> bool {
    let file_name = format!("{program}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(path_var).any(|folder| folder.join(&file_name).is_file())
}

/// The host target triple from `rustc -vV`'s `host:` line.
pub fn host_triple(rustc_verbose: &str) -> Result<String, String> {
    rustc_verbose
        .lines()
        .find_map(|line| line.strip_prefix("host:"))
        .map(|triple| triple.trim().to_string())
        .ok_or_else(|| format!("rustc -vV printed no \"host:\" line:\n{rustc_verbose}"))
}

/// Where the host library of a target triple lands: `<target dir>/llama/<host-triple>`.
pub fn host_library_dir(target_dir: &Path, triple: &str) -> PathBuf {
    target_dir.join("llama").join(triple)
}

/// One CMake host build of `turbollm_core_llama_<variant>` from the fetched llama.cpp tree.
pub struct HostBuild {
    pub generator: Option<&'static str>,
    pub native_dir: PathBuf,
    pub llama_dir: PathBuf,
    pub build_dir: PathBuf,
    pub library_dir: PathBuf,
    pub variant: String,
}

impl HostBuild {
    pub fn configure_args(&self) -> Vec<OsString> {
        let mut args = vec![
            OsString::from("-S"),
            self.native_dir.clone().into_os_string(),
            OsString::from("-B"),
            self.build_dir.clone().into_os_string(),
        ];
        if let Some(generator) = self.generator {
            args.extend([OsString::from("-G"), OsString::from(generator)]);
        }
        args.push(path_define("TURBOLLM_LLAMA_DIR", &self.llama_dir));
        args.extend([
            format!("-DTURBOLLM_VARIANTS={}", self.variant).into(),
            "-DTURBOLLM_TEST_PROBES=ON".into(),
            format!("-DCMAKE_BUILD_TYPE={RELEASE}").into(),
        ]);
        args.extend(self.library_dir_defines());
        args
    }

    pub fn build_args(&self) -> Vec<OsString> {
        vec![
            OsString::from("--build"),
            self.build_dir.clone().into_os_string(),
            OsString::from("--config"),
            OsString::from(RELEASE),
            OsString::from("--target"),
            OsString::from(self.library_stem()),
            OsString::from("--parallel"),
        ]
    }

    pub fn library(&self) -> PathBuf {
        self.library_dir
            .join(turbollm_platform::library_file_name(&self.library_stem()))
    }

    fn library_stem(&self) -> String {
        format!("turbollm_core_llama_{}", self.variant)
    }

    /// Shared libraries are LIBRARY outputs on ELF/Mach-O and RUNTIME outputs (DLLs) on Windows; the
    /// `_RELEASE` forms stop multi-config generators (Visual Studio) from adding a `Release/` folder.
    fn library_dir_defines(&self) -> Vec<OsString> {
        [
            "CMAKE_LIBRARY_OUTPUT_DIRECTORY",
            "CMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE",
            "CMAKE_RUNTIME_OUTPUT_DIRECTORY",
            "CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE",
        ]
        .into_iter()
        .map(|name| path_define(name, &self.library_dir))
        .collect()
    }
}

/// A `PATH`-typed cache entry: CMake normalises its value, so Windows backslashes never reach CMake strings.
fn path_define(name: &str, path: &Path) -> OsString {
    let mut define = OsString::from(format!("-D{name}:PATH="));
    define.push(path);
    define
}

pub fn io_error(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

fn archive_error(e: std::io::Error) -> String {
    format!("llama.cpp archive: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use sha2::{Digest, Sha256};

    const COMMIT: &str = "72d4bcd102d3b823c2bb1260fdc0e5da1af1f4b1";
    const TOP: &str = "TurboLLM-Android-Llama-72d4bcd102d3b823c2bb1260fdc0e5da1af1f4b1";

    struct RecordingFetcher {
        archive: Vec<u8>,
        requested: RefCell<Vec<String>>,
    }

    impl RecordingFetcher {
        fn serving(archive: &[u8]) -> Self {
            Self {
                archive: archive.to_vec(),
                requested: RefCell::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requested.borrow().clone()
        }
    }

    impl ArchiveFetcher for RecordingFetcher {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            self.requested.borrow_mut().push(url.to_string());
            Ok(self.archive.clone())
        }
    }

    fn archive_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        for (path, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, path, contents.as_bytes())
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn llama_archive() -> Vec<u8> {
        archive_of(&[
            (&format!("{TOP}/CMakeLists.txt"), "project(llama)"),
            (&format!("{TOP}/src/llama.cpp"), "// llama"),
        ])
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn pinned_to(archive: &[u8]) -> LlamaSource {
        LlamaSource {
            repo: "mohitsoni48/TurboLLM-Android-Llama".to_string(),
            commit: COMMIT.to_string(),
            sha256: sha256_hex(archive),
        }
    }

    fn places_in(root: &Path) -> SourcePlaces {
        SourcePlaces {
            cache_dir: root.join("cache"),
            out_dir: root.join("out"),
        }
    }

    fn cached_archive(places: &SourcePlaces) -> PathBuf {
        places.cache_dir.join(format!("{COMMIT}.tar.gz"))
    }

    fn tree(places: &SourcePlaces) -> PathBuf {
        places.out_dir.join("llama.cpp")
    }

    #[test]
    fn parse_source_reads_repo_commit_and_sha256() {
        let source =
            parse_source(r#"{"repo": "owner/name", "commit": "abc123", "sha256": "00ff"}"#)
                .unwrap();
        assert_eq!(source.repo, "owner/name");
        assert_eq!(source.commit, "abc123");
        assert_eq!(source.sha256, "00ff");
    }

    #[test]
    fn parse_source_names_a_missing_field() {
        let error = parse_source(r#"{"repo": "owner/name", "commit": "abc123"}"#).unwrap_err();
        assert!(error.contains("sha256"), "{error}");
    }

    #[test]
    fn archive_url_is_the_github_tarball_of_the_commit() {
        assert_eq!(
            pinned_to(b"").archive_url(),
            format!(
                "https://github.com/mohitsoni48/TurboLLM-Android-Llama/archive/{COMMIT}.tar.gz"
            )
        );
    }

    #[test]
    fn out_dir_arg_reads_the_out_flag() {
        let args = ["--out".to_string(), "some/dir".to_string()];
        assert_eq!(out_dir_arg(&args).unwrap(), PathBuf::from("some/dir"));
    }

    #[test]
    fn out_dir_arg_requires_the_out_flag() {
        let error = out_dir_arg(&[]).unwrap_err();
        assert!(error.contains("--out <dir>"), "{error}");
    }

    #[test]
    fn wrong_sha256_fails_naming_expected_and_actual() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();
        let mut source = pinned_to(&archive);
        source.sha256 = "0".repeat(64);

        let error =
            fetch_llama(&source, &places, &RecordingFetcher::serving(&archive)).unwrap_err();

        assert!(error.contains(&"0".repeat(64)), "{error}");
        assert!(error.contains(&sha256_hex(&archive)), "{error}");
        assert!(!tree(&places).exists());
    }

    #[test]
    fn cold_cache_downloads_the_pinned_archive_and_keeps_it() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();
        let source = pinned_to(&archive);
        let fetcher = RecordingFetcher::serving(&archive);

        let outcome = fetch_llama(&source, &places, &fetcher).unwrap();

        assert_eq!(fetcher.requests(), vec![source.archive_url()]);
        assert_eq!(fs::read(cached_archive(&places)).unwrap(), archive);
        assert_eq!(
            outcome,
            FetchOutcome::Extracted {
                tree: tree(&places),
                origin: ArchiveOrigin::Downloaded,
                sha256: source.sha256.clone(),
            }
        );
    }

    #[test]
    fn warm_cache_makes_no_network_call() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();
        fs::create_dir_all(&places.cache_dir).unwrap();
        fs::write(cached_archive(&places), &archive).unwrap();
        let fetcher = RecordingFetcher::serving(b"");

        let outcome = fetch_llama(&pinned_to(&archive), &places, &fetcher).unwrap();

        assert!(fetcher.requests().is_empty());
        assert!(matches!(
            outcome,
            FetchOutcome::Extracted {
                origin: ArchiveOrigin::CacheHit,
                ..
            }
        ));
    }

    #[test]
    fn extraction_strips_the_archive_top_folder() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();

        fetch_llama(
            &pinned_to(&archive),
            &places,
            &RecordingFetcher::serving(&archive),
        )
        .unwrap();

        let tree = tree(&places);
        assert_eq!(
            fs::read_to_string(tree.join("CMakeLists.txt")).unwrap(),
            "project(llama)"
        );
        assert_eq!(
            fs::read_to_string(tree.join("src").join("llama.cpp")).unwrap(),
            "// llama"
        );
        assert!(!tree.join(TOP).exists());
    }

    #[test]
    fn extraction_marks_the_tree_with_the_commit() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();

        fetch_llama(
            &pinned_to(&archive),
            &places,
            &RecordingFetcher::serving(&archive),
        )
        .unwrap();

        let marker = fs::read_to_string(tree(&places).join(".turbollm-commit")).unwrap();
        assert_eq!(marker.trim(), COMMIT);
    }

    #[test]
    fn second_run_with_the_marker_present_is_a_no_op() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();
        let source = pinned_to(&archive);
        fetch_llama(&source, &places, &RecordingFetcher::serving(&archive)).unwrap();
        fs::remove_file(cached_archive(&places)).unwrap();
        let fetcher = RecordingFetcher::serving(b"");

        let outcome = fetch_llama(&source, &places, &fetcher).unwrap();

        assert_eq!(
            outcome,
            FetchOutcome::AlreadyExtracted {
                tree: tree(&places)
            }
        );
        assert!(fetcher.requests().is_empty());
    }

    #[test]
    fn a_tree_of_another_commit_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let stale = tree(&places);
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join(".turbollm-commit"), "an-older-commit").unwrap();
        fs::write(stale.join("stale.txt"), "old").unwrap();
        let archive = llama_archive();

        fetch_llama(
            &pinned_to(&archive),
            &places,
            &RecordingFetcher::serving(&archive),
        )
        .unwrap();

        assert!(!stale.join("stale.txt").exists());
        assert!(stale.join("CMakeLists.txt").exists());
    }

    #[test]
    fn an_entry_escaping_the_tree_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = archive_with_raw_path(&format!("{TOP}/../escaped.txt"));

        let error = fetch_llama(
            &pinned_to(&archive),
            &places,
            &RecordingFetcher::serving(&archive),
        )
        .unwrap_err();

        assert!(error.contains("escaped.txt"), "{error}");
        assert!(error.contains("leaves the source tree"), "{error}");
        assert!(!places.out_dir.join("escaped.txt").exists());
        assert!(!tree(&places).exists());
    }

    #[test]
    fn a_download_with_the_wrong_sha256_is_not_kept_in_the_cache() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = llama_archive();
        let source = pinned_to(&archive);

        let error = fetch_llama(
            &source,
            &places,
            &RecordingFetcher::serving(b"a captive portal page"),
        )
        .unwrap_err();

        assert!(error.contains("sha256 mismatch"), "{error}");
        assert!(!cached_archive(&places).exists());
        let fetcher = RecordingFetcher::serving(&archive);
        fetch_llama(&source, &places, &fetcher).unwrap();
        assert_eq!(fetcher.requests(), vec![source.archive_url()]);
    }

    #[test]
    fn a_cached_archive_with_the_wrong_sha256_is_removed_and_named() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        fs::create_dir_all(&places.cache_dir).unwrap();
        fs::write(cached_archive(&places), b"a poisoned cache entry").unwrap();

        let error = fetch_llama(
            &pinned_to(&llama_archive()),
            &places,
            &RecordingFetcher::serving(b""),
        )
        .unwrap_err();

        let named = format!(
            "removed the cached archive {}",
            cached_archive(&places).display()
        );
        assert!(error.contains(&named), "{error}");
        assert!(!cached_archive(&places).exists());
    }

    #[test]
    fn a_symlink_entry_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = archive_with_link(tar::EntryType::Symlink, "/etc");

        let error = fetch_llama(
            &pinned_to(&archive),
            &places,
            &RecordingFetcher::serving(&archive),
        )
        .unwrap_err();

        assert!(error.contains(&format!("{TOP}/link is a link")), "{error}");
        assert!(!tree(&places).exists());
    }

    #[test]
    fn a_hardlink_entry_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let places = places_in(root.path());
        let archive = archive_with_link(tar::EntryType::Link, &format!("{TOP}/CMakeLists.txt"));

        let error = fetch_llama(
            &pinned_to(&archive),
            &places,
            &RecordingFetcher::serving(&archive),
        )
        .unwrap_err();

        assert!(error.contains(&format!("{TOP}/link is a link")), "{error}");
        assert!(!tree(&places).exists());
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn build_variant_defaults_to_base() {
        assert_eq!(build_variant_arg(&strings(&["--host"])).unwrap(), "base");
    }

    #[test]
    fn build_variant_reads_the_variant_flag() {
        let args = strings(&["--host", "--variant", "dotprod"]);
        assert_eq!(build_variant_arg(&args).unwrap(), "dotprod");
    }

    #[test]
    fn build_variant_requires_the_host_flag() {
        let error = build_variant_arg(&strings(&["--variant", "base"])).unwrap_err();
        assert!(error.contains("build-llama --host"), "{error}");
    }

    #[test]
    fn windows_builds_with_visual_studio_2022_even_with_ninja_on_path() {
        assert_eq!(
            host_generator("windows", true),
            Some("Visual Studio 17 2022")
        );
    }

    #[test]
    fn linux_and_macos_build_with_ninja_when_it_is_on_path() {
        assert_eq!(host_generator("linux", true), Some("Ninja"));
        assert_eq!(host_generator("macos", true), Some("Ninja"));
    }

    #[test]
    fn without_ninja_cmake_keeps_its_default_generator() {
        assert_eq!(host_generator("linux", false), None);
    }

    #[test]
    fn a_program_in_a_path_folder_is_on_path() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(
            bin.join(format!("ninja{}", std::env::consts::EXE_SUFFIX)),
            "",
        )
        .unwrap();
        let path_var = std::env::join_paths([root.path().join("empty"), bin]).unwrap();

        assert!(on_path(&path_var, "ninja"));
        assert!(!on_path(&path_var, "cmake"));
    }

    #[test]
    fn host_triple_is_read_from_rustc_verbose_version() {
        let verbose = "rustc 1.95.0 (abc 2026-01-01)\nbinary: rustc\nhost: x86_64-pc-windows-msvc\nrelease: 1.95.0\n";
        assert_eq!(host_triple(verbose).unwrap(), "x86_64-pc-windows-msvc");
    }

    #[test]
    fn host_triple_without_a_host_line_is_an_error() {
        let error = host_triple("rustc 1.95.0\n").unwrap_err();
        assert!(error.contains("host:"), "{error}");
    }

    #[test]
    fn the_host_library_dir_is_keyed_by_triple_under_target_llama() {
        let target = Path::new("core").join("target");
        assert_eq!(
            host_library_dir(&target, "x86_64-unknown-linux-gnu"),
            target.join("llama").join("x86_64-unknown-linux-gnu")
        );
    }

    fn host_build(generator: Option<&'static str>) -> HostBuild {
        HostBuild {
            generator,
            native_dir: Path::new("crate").join("native"),
            llama_dir: Path::new("src").join("llama.cpp"),
            build_dir: Path::new("lib").join("build"),
            library_dir: PathBuf::from("lib"),
            variant: "base".to_string(),
        }
    }

    fn path_define(name: &str, path: &Path) -> String {
        format!("-D{name}:PATH={}", path.display())
    }

    fn as_strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect()
    }

    #[test]
    fn configure_args_name_the_generator_sources_and_release_flags() {
        let build = host_build(Some("Visual Studio 17 2022"));
        let lib = Path::new("lib");
        let expected = vec![
            "-S".to_string(),
            build.native_dir.display().to_string(),
            "-B".to_string(),
            build.build_dir.display().to_string(),
            "-G".to_string(),
            "Visual Studio 17 2022".to_string(),
            path_define("TURBOLLM_LLAMA_DIR", &build.llama_dir),
            "-DTURBOLLM_VARIANTS=base".to_string(),
            "-DTURBOLLM_TEST_PROBES=ON".to_string(),
            "-DCMAKE_BUILD_TYPE=Release".to_string(),
            path_define("CMAKE_LIBRARY_OUTPUT_DIRECTORY", lib),
            path_define("CMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE", lib),
            path_define("CMAKE_RUNTIME_OUTPUT_DIRECTORY", lib),
            path_define("CMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE", lib),
        ];
        assert_eq!(as_strings(build.configure_args()), expected);
    }

    #[test]
    fn configure_args_leave_out_the_generator_when_cmake_picks_it() {
        let args = as_strings(host_build(None).configure_args());
        assert!(!args.contains(&"-G".to_string()), "{args:?}");
        assert!(args.contains(&"-DTURBOLLM_VARIANTS=base".to_string()));
    }

    #[test]
    fn build_args_build_only_the_variant_library_in_release() {
        let build = host_build(None);
        let expected = vec![
            "--build".to_string(),
            build.build_dir.display().to_string(),
            "--config".to_string(),
            "Release".to_string(),
            "--target".to_string(),
            "turbollm_core_llama_base".to_string(),
            "--parallel".to_string(),
        ];
        assert_eq!(as_strings(build.build_args()), expected);
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_built_library_is_a_dll_without_prefix() {
        let build = host_build(None);
        assert_eq!(
            build.library(),
            Path::new("lib").join("turbollm_core_llama_base.dll")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_the_built_library_is_a_lib_prefixed_so() {
        let build = host_build(None);
        assert_eq!(
            build.library(),
            Path::new("lib").join("libturbollm_core_llama_base.so")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_the_built_library_is_a_lib_prefixed_dylib() {
        let build = host_build(None);
        assert_eq!(
            build.library(),
            Path::new("lib").join("libturbollm_core_llama_base.dylib")
        );
    }

    fn archive_with_raw_path(path: &str) -> Vec<u8> {
        let mut header = tar::Header::new_gnu();
        header.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        builder.append(&header, &b"x"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn archive_with_link(kind: tar::EntryType, target: &str) -> Vec<u8> {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
        let mut file = tar::Header::new_gnu();
        file.set_size(5);
        file.set_mode(0o644);
        builder
            .append_data(&mut file, format!("{TOP}/CMakeLists.txt"), &b"llama"[..])
            .unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(kind);
        link.set_size(0);
        link.set_mode(0o777);
        builder
            .append_link(&mut link, format!("{TOP}/link"), target)
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }
}
