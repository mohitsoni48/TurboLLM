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
    let (archive, origin) = cached_or_downloaded(source, &places.cache_dir, fetcher)?;
    let sha256 = verified_sha256(source, &archive)?;
    replace_tree(&tree, &archive, &source.commit)?;
    Ok(FetchOutcome::Extracted {
        tree,
        origin,
        sha256,
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

/// The cache keeps the archive as downloaded; its hash is checked on every use, not only after a download.
fn cached_or_downloaded(
    source: &LlamaSource,
    cache_dir: &Path,
    fetcher: &dyn ArchiveFetcher,
) -> Result<(Vec<u8>, ArchiveOrigin), String> {
    let cached = cache_dir.join(format!("{}.tar.gz", source.commit));
    if cached.is_file() {
        return Ok((
            fs::read(&cached).map_err(io_error(&cached))?,
            ArchiveOrigin::CacheHit,
        ));
    }
    let archive = fetcher.fetch(&source.archive_url())?;
    keep_in_cache(&cached, &archive)?;
    Ok((archive, ArchiveOrigin::Downloaded))
}

fn keep_in_cache(cached: &Path, archive: &[u8]) -> Result<(), String> {
    let cache_dir = cached
        .parent()
        .expect("the cached archive lives in the cache folder");
    fs::create_dir_all(cache_dir).map_err(io_error(cache_dir))?;
    let partial = cached.with_extension("partial");
    fs::write(&partial, archive).map_err(io_error(&partial))?;
    fs::rename(&partial, cached).map_err(io_error(cached))
}

fn verified_sha256(source: &LlamaSource, archive: &[u8]) -> Result<String, String> {
    let actual: String = Sha256::digest(archive)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual != source.sha256 {
        return Err(format!(
            "llama.cpp archive {}: sha256 mismatch, expected {:?} (llama-source.json), actual {actual}",
            source.commit, source.sha256
        ));
    }
    Ok(actual)
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

fn remove_if_present(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(io_error(dir))?;
    }
    Ok(())
}

fn io_error(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
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
}
