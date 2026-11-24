//! `fetch-litert --abis <list> --out <dir>` and `fetch-litert --host --out <dir>`: stage Google's LiteRT-LM
//! C library from its pinned PyPI wheel (plan T21, arch 2.8 and 2.9, ADR-482).
//!
//! Every byte is checked against `litert-runtime.json`: the wheel's sha256 before it is opened, then the
//! library inside it (sha256, ELF machine, and on Android the 16 KB `PT_LOAD` alignment). The library is
//! written unchanged, with no `DT_NEEDED` rename: `libandroid.so` loads inside an app process.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::elf;
use crate::llama::{
    ArchiveFetcher, ArchiveOrigin, forget_cached, io_error, sha256_hex, write_through_partial,
};

const PIN_FILE: &str = "litert-runtime.json";
const ANDROID_LIBRARY_NAME: &str = "libturbollm_core_litertlm.so";
const HOST_LIBRARY_STEM: &str = "litert-lm";
const HOST_FLAG: &str = "--host";
const MAX_LIBRARY_BYTES: u64 = 256 * 1024 * 1024;
const SUPPORTED_HOSTS: &str = "linux-x86_64 (manylinux_2_27_x86_64), macos-aarch64 (macosx_12_0_arm64), windows-x86_64 (win_amd64)";
const USAGE: &str =
    "usage: cargo xtask fetch-litert --abis <arm64-v8a,x86_64> --out <dir> | --host --out <dir>";

/// One wheel and the library inside it, as pinned in `litert-runtime.json`.
#[derive(Debug)]
pub struct WheelPin {
    pub file: String,
    pub url: String,
    pub sha256: String,
    pub member: String,
    /// `None` until the first verified run has computed it; the run then reports the value to pin.
    pub library_sha256: Option<String>,
    /// `None` for libraries that are not ELF (`.dll`, `.dylib`).
    pub elf_machine: Option<u16>,
}

#[derive(Debug)]
pub struct Runtime {
    pub version: String,
    pub android: BTreeMap<String, WheelPin>,
    pub host: BTreeMap<String, WheelPin>,
}

#[derive(Debug, PartialEq)]
pub enum Request {
    Android { abis: Vec<String>, out: PathBuf },
    Host { out: PathBuf },
}

pub struct Places {
    pub cache_dir: PathBuf,
    pub out_dir: PathBuf,
}

#[derive(Debug, PartialEq)]
pub struct Staged {
    pub target: String,
    pub file: PathBuf,
    pub wheel: ArchiveOrigin,
    pub library_sha256: String,
    pub library_pinned: bool,
}

pub fn parse_runtime(json: &str) -> Result<Runtime, String> {
    let pin: Value = serde_json::from_str(json).map_err(|e| format!("{PIN_FILE}: {e}"))?;
    Ok(Runtime {
        version: text_field(&pin, "version")?,
        android: wheel_table(&pin, "android")?,
        host: wheel_table(&pin, "host")?,
    })
}

/// Reads `--abis <a,b> --out <dir>` or `--host --out <dir>`.
pub fn parse_request(args: &[String]) -> Result<Request, String> {
    let usage = || USAGE.to_string();
    let host = args.iter().any(|arg| arg == HOST_FLAG);
    let rest: Vec<&String> = args.iter().filter(|arg| *arg != HOST_FLAG).collect();
    let (mut abis, mut out) = (None, None);
    for pair in rest.chunks(2) {
        match pair {
            [flag, value] if flag.as_str() == "--abis" => abis = Some(value.as_str()),
            [flag, value] if flag.as_str() == "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(usage()),
        }
    }
    match (host, abis, out) {
        (true, None, Some(out)) => Ok(Request::Host { out }),
        (false, Some(list), Some(out)) => {
            let abis: Vec<String> = list.split(',').map(str::to_string).collect();
            if abis.iter().any(String::is_empty) {
                return Err(usage());
            }
            Ok(Request::Android { abis, out })
        }
        _ => Err(usage()),
    }
}

/// The `litert-runtime.json` key of the wheel that matches this OS and CPU.
pub fn host_key(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("linux", "x86_64") => Ok("linux-x86_64"),
        ("macos", "aarch64") => Ok("macos-aarch64"),
        ("windows", "x86_64") => Ok("windows-x86_64"),
        _ => Err(format!(
            "fetch-litert --host: no LiteRT-LM wheel for {os}-{arch}; supported hosts: {SUPPORTED_HOSTS}"
        )),
    }
}

/// Stages `<out>/<abi>/libturbollm_core_litertlm.so` for each ABI.
pub fn stage_android(
    runtime: &Runtime,
    abis: &[String],
    places: &Places,
    fetcher: &dyn ArchiveFetcher,
) -> Result<Vec<Staged>, String> {
    abis.iter()
        .map(|abi| {
            let pin = runtime.android.get(abi).ok_or_else(|| {
                let supported: Vec<&str> = runtime.android.keys().map(String::as_str).collect();
                format!(
                    "fetch-litert: no LiteRT-LM wheel for ABI {abi}; supported: {}",
                    supported.join(", ")
                )
            })?;
            let destination = places.out_dir.join(abi).join(ANDROID_LIBRARY_NAME);
            stage(abi, pin, Platform::Android, &destination, places, fetcher)
        })
        .collect()
}

/// Stages `<out>/<the OS's file name for litert-lm>` from the host wheel `key`.
pub fn stage_host(
    runtime: &Runtime,
    key: &str,
    places: &Places,
    fetcher: &dyn ArchiveFetcher,
) -> Result<Staged, String> {
    let pin = runtime.host.get(key).ok_or_else(|| {
        format!(
            "fetch-litert --host: no LiteRT-LM wheel for {key}; supported hosts: {SUPPORTED_HOSTS}"
        )
    })?;
    let destination = places
        .out_dir
        .join(turbollm_platform::library_file_name(HOST_LIBRARY_STEM));
    stage(key, pin, Platform::Host, &destination, places, fetcher)
}

#[derive(Clone, Copy, PartialEq)]
enum Platform {
    Android,
    Host,
}

fn stage(
    target: &str,
    pin: &WheelPin,
    platform: Platform,
    destination: &Path,
    places: &Places,
    fetcher: &dyn ArchiveFetcher,
) -> Result<Staged, String> {
    let (wheel, origin) = verified_wheel(pin, &places.cache_dir, fetcher)?;
    let library =
        library_in_wheel(&wheel, &pin.member).map_err(|e| format!("{}: {e}", pin.file))?;
    let library_sha256 = checked_library(pin, &library, platform)?;
    write_through_partial(destination, &library)?;
    Ok(Staged {
        target: target.to_string(),
        file: destination.to_path_buf(),
        wheel: origin,
        library_sha256,
        library_pinned: pin.library_sha256.is_some(),
    })
}

/// The hash is checked on every use: a download is cached only once it matches the pin, and a cached
/// wheel that no longer matches is removed, so one bad response cannot break later runs.
fn verified_wheel(
    pin: &WheelPin,
    cache_dir: &Path,
    fetcher: &dyn ArchiveFetcher,
) -> Result<(Vec<u8>, ArchiveOrigin), String> {
    let cached = cache_dir.join(&pin.file);
    if cached.is_file() {
        let wheel = fs::read(&cached).map_err(io_error(&cached))?;
        verify_wheel_sha256(pin, &wheel).map_err(|mismatch| forget_cached(&cached, &mismatch))?;
        return Ok((wheel, ArchiveOrigin::CacheHit));
    }
    let wheel = fetcher.fetch(&pin.url)?;
    verify_wheel_sha256(pin, &wheel)?;
    write_through_partial(&cached, &wheel)?;
    Ok((wheel, ArchiveOrigin::Downloaded))
}

fn verify_wheel_sha256(pin: &WheelPin, wheel: &[u8]) -> Result<(), String> {
    let actual = sha256_hex(wheel);
    if actual != pin.sha256 {
        return Err(format!(
            "wheel {}: sha256 mismatch, expected {:?} ({PIN_FILE}), actual {actual}",
            pin.file, pin.sha256
        ));
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub struct PackagedRequest {
    pub aar: PathBuf,
    /// `None` checks every ABI the pin file lists for Android.
    pub abis: Option<Vec<String>>,
}

const PACKAGED_USAGE: &str =
    "usage: cargo xtask check-litert-packaged <aar> [--abis <arm64-v8a,x86_64>]";

/// Reads `<aar> [--abis <a,b>]`.
pub fn parse_packaged_request(args: &[String]) -> Result<PackagedRequest, String> {
    match args {
        [aar] => Ok(PackagedRequest {
            aar: aar.into(),
            abis: None,
        }),
        [aar, flag, list] if flag == "--abis" => Ok(PackagedRequest {
            aar: aar.into(),
            abis: Some(list.split(',').map(str::to_string).collect()),
        }),
        _ => Err(PACKAGED_USAGE.to_string()),
    }
}

/// Fails unless each ABI's `jni/<abi>/libturbollm_core_litertlm.so` in the AAR hashes to the pinned library
/// (ADR-482: byte-identical to the wheel member). Returns one report line per ABI.
pub fn check_packaged(
    runtime: &Runtime,
    aar: &[u8],
    abis: &[String],
) -> Result<Vec<String>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(aar)).map_err(|e| format!("not a readable AAR: {e}"))?;
    abis.iter()
        .map(|abi| {
            let pin = runtime
                .android
                .get(abi)
                .ok_or_else(|| format!("check-litert-packaged: no pin for ABI {abi} in {PIN_FILE}"))?;
            let expected = pin.library_sha256.as_ref().ok_or_else(|| {
                format!("check-litert-packaged: {abi}: librarySha256 is not pinned in {PIN_FILE}")
            })?;
            let member = format!("jni/{abi}/{ANDROID_LIBRARY_NAME}");
            let library = library_in_archive(&mut archive, &member)
                .map_err(|e| format!("check-litert-packaged: {abi}: {e}"))?;
            let actual = sha256_hex(&library);
            if &actual != expected {
                return Err(format!(
                    "check-litert-packaged: {abi}: {member} sha256 {actual} is not the pinned {expected} ({PIN_FILE}); the AAR's copy was altered while packaging (debug-symbol stripping?)"
                ));
            }
            Ok(format!("{abi}: {member} sha256 {actual}"))
        })
        .collect()
}

fn library_in_wheel(wheel: &[u8], member: &str) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(wheel))
        .map_err(|e| format!("not a readable wheel: {e}"))?;
    library_in_archive(&mut archive, member)
}

fn library_in_archive(
    archive: &mut zip::ZipArchive<Cursor<&[u8]>>,
    member: &str,
) -> Result<Vec<u8>, String> {
    let entry = archive
        .by_name(member)
        .map_err(|e| format!("no member {member}: {e}"))?;
    if entry.size() > MAX_LIBRARY_BYTES {
        return Err(format!(
            "member {member} is {} bytes, more than the {MAX_LIBRARY_BYTES} allowed",
            entry.size()
        ));
    }
    let mut library = Vec::new();
    entry
        .take(MAX_LIBRARY_BYTES)
        .read_to_end(&mut library)
        .map_err(|e| format!("member {member}: {e}"))?;
    Ok(library)
}

/// Returns the library's sha256 once its pinned hash (when there is one), CPU and, on Android, page alignment hold.
fn checked_library(pin: &WheelPin, library: &[u8], platform: Platform) -> Result<String, String> {
    let sha256 = sha256_hex(library);
    let file = &pin.file;
    if let Some(expected) = pin
        .library_sha256
        .as_ref()
        .filter(|expected| **expected != sha256)
    {
        return Err(format!(
            "{file}: {} sha256 mismatch, expected {expected:?} ({PIN_FILE}), actual {sha256}",
            pin.member
        ));
    }
    if let Some(expected) = pin.elf_machine {
        let actual = elf::elf_machine(library).map_err(|e| format!("{file}: {e}"))?;
        if actual != expected {
            return Err(format!(
                "{file}: {} ELF machine mismatch, expected {expected:#x} ({PIN_FILE}), actual {actual:#x}",
                pin.member
            ));
        }
    }
    if platform == Platform::Android {
        let shared = elf::read_shared_library(library).map_err(|e| format!("{file}: {e}"))?;
        let problems = elf::android_problems(&shared, None);
        if !problems.is_empty() {
            return Err(format!("{file}: {}: {}", pin.member, problems.join("; ")));
        }
    }
    Ok(sha256)
}

fn wheel_table(pin: &Value, name: &str) -> Result<BTreeMap<String, WheelPin>, String> {
    pin.get(name)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{PIN_FILE}: missing object {name:?}"))?
        .iter()
        .map(|(key, wheel)| Ok((key.clone(), wheel_pin(key, wheel)?)))
        .collect()
}

fn wheel_pin(key: &str, wheel: &Value) -> Result<WheelPin, String> {
    let machine = wheel.get("elfMachine").filter(|value| !value.is_null());
    Ok(WheelPin {
        file: text_field(wheel, "file").map_err(|e| format!("{key}: {e}"))?,
        url: text_field(wheel, "url").map_err(|e| format!("{key}: {e}"))?,
        sha256: text_field(wheel, "sha256").map_err(|e| format!("{key}: {e}"))?,
        member: text_field(wheel, "member").map_err(|e| format!("{key}: {e}"))?,
        library_sha256: library_sha256(key, wheel)?,
        elf_machine: machine
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|number| u16::try_from(number).ok())
                    .ok_or_else(|| format!("{PIN_FILE}: {key}: elfMachine must be a 16-bit number"))
            })
            .transpose()?,
    })
}

/// Absent or `null` means "not pinned yet"; any other non-string would silently unpin the library.
fn library_sha256(key: &str, wheel: &Value) -> Result<Option<String>, String> {
    match wheel.get("librarySha256") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(hash)) => Ok(Some(hash.clone())),
        Some(_) => Err(format!(
            "{PIN_FILE}: {key}: librarySha256 must be a string or null"
        )),
    }
}

fn text_field(object: &Value, name: &str) -> Result<String, String> {
    object
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{PIN_FILE}: missing string field {name:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::io::Write;

    use object::Endianness;
    use object::elf;
    use object::write::elf::Writer;
    use object::write::elf::{FileHeader as FileHeaderSpec, ProgramHeader as ProgramHeaderSpec};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    const MEMBER: &str = "litert_lm/liblitert-lm.so";
    const ARM64: u16 = 0xb7;
    const X86_64: u16 = 0x3e;

    struct MapFetcher {
        bodies: HashMap<String, Vec<u8>>,
        requested: RefCell<Vec<String>>,
    }

    impl MapFetcher {
        fn serving(bodies: &[(&str, &[u8])]) -> Self {
            Self {
                bodies: bodies
                    .iter()
                    .map(|(url, body)| (url.to_string(), body.to_vec()))
                    .collect(),
                requested: RefCell::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<String> {
            self.requested.borrow().clone()
        }
    }

    impl ArchiveFetcher for MapFetcher {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            self.requested.borrow_mut().push(url.to_string());
            self.bodies
                .get(url)
                .cloned()
                .ok_or_else(|| format!("{url}: no such page"))
        }
    }

    /// A 64-bit ELF with one `PT_LOAD` segment, enough for the machine and alignment checks.
    fn elf_library(machine: u16, load_align: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut writer = Writer::new(Endianness::Little, true, &mut bytes);
        writer.reserve_file_header();
        writer.reserve_program_headers(1);
        let file_len = writer.reserved_len();
        writer
            .write_file_header(&FileHeaderSpec {
                os_abi: elf::ELFOSABI_NONE,
                abi_version: 0,
                e_type: elf::ET_DYN,
                e_machine: elf::Machine(machine),
                e_entry: 0,
                e_flags: elf::FileFlags(0),
            })
            .unwrap();
        writer.write_program_header(&ProgramHeaderSpec {
            p_type: elf::PT_LOAD,
            p_flags: elf::PF_R,
            p_offset: 0,
            p_vaddr: 0,
            p_paddr: 0,
            p_filesz: file_len,
            p_memsz: file_len,
            p_align: load_align,
        });
        bytes
    }

    fn wheel_holding(member: &str, library: &[u8]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("litert_lm/__init__.py", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"# python side").unwrap();
        writer
            .start_file(member, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(library).unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn pin_for(wheel: &[u8], library: &[u8], elf_machine: Option<u16>) -> WheelPin {
        WheelPin {
            file: "litert_lm_api-0.19.0-test.whl".to_string(),
            url: "https://files.example/test.whl".to_string(),
            sha256: sha256_hex(wheel),
            member: MEMBER.to_string(),
            library_sha256: Some(sha256_hex(library)),
            elf_machine,
        }
    }

    fn runtime_of(android: Vec<(&str, WheelPin)>, host: Vec<(&str, WheelPin)>) -> Runtime {
        let table = |pins: Vec<(&str, WheelPin)>| {
            pins.into_iter()
                .map(|(key, pin)| (key.to_string(), pin))
                .collect()
        };
        Runtime {
            version: "0.19.0".to_string(),
            android: table(android),
            host: table(host),
        }
    }

    fn places_in(root: &Path) -> Places {
        Places {
            cache_dir: root.join("cache"),
            out_dir: root.join("out"),
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// Stages one `arm64-v8a` library from a fetcher that serves `wheel` at the pin's URL.
    fn stage_arm64(pin: WheelPin, wheel: &[u8], root: &Path) -> Result<Vec<Staged>, String> {
        let fetcher = MapFetcher::serving(&[(&pin.url, wheel)]);
        stage_android(
            &runtime_of(vec![("arm64-v8a", pin)], vec![]),
            &strings(&["arm64-v8a"]),
            &places_in(root),
            &fetcher,
        )
    }

    #[test]
    fn an_android_library_is_written_under_the_abi_with_the_core_name_and_the_wheels_bytes() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let root = tempfile::tempdir().unwrap();

        let staged = stage_arm64(pin, &wheel, root.path()).unwrap();

        let expected = root
            .path()
            .join("out")
            .join("arm64-v8a")
            .join(ANDROID_LIBRARY_NAME);
        assert_eq!(staged[0].file, expected);
        assert_eq!(fs::read(expected).unwrap(), library);
        assert_eq!(staged[0].wheel, ArchiveOrigin::Downloaded);
        assert!(staged[0].library_pinned);
    }

    #[test]
    fn a_wheel_with_the_wrong_sha256_fails_and_is_not_cached() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let mut pin = pin_for(&wheel, &library, Some(ARM64));
        pin.sha256 = sha256_hex(b"another wheel");
        let root = tempfile::tempdir().unwrap();

        let problem = stage_arm64(pin, &wheel, root.path()).unwrap_err();

        assert!(problem.contains("wheel"), "{problem}");
        assert!(problem.contains("sha256 mismatch"), "{problem}");
        assert!(!root.path().join("cache").exists());
        assert!(!root.path().join("out").exists());
    }

    #[test]
    fn a_library_with_the_wrong_sha256_fails_and_writes_nothing() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let mut pin = pin_for(&wheel, &library, Some(ARM64));
        pin.library_sha256 = Some(sha256_hex(b"another library"));
        let root = tempfile::tempdir().unwrap();

        let problem = stage_arm64(pin, &wheel, root.path()).unwrap_err();

        assert!(problem.contains(MEMBER), "{problem}");
        assert!(problem.contains("sha256 mismatch"), "{problem}");
        assert!(!root.path().join("out").exists());
    }

    #[test]
    fn a_wheel_without_the_pinned_member_fails() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding("litert_lm/other.so", &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let root = tempfile::tempdir().unwrap();

        let problem = stage_arm64(pin, &wheel, root.path()).unwrap_err();

        assert!(problem.contains(MEMBER), "{problem}");
    }

    #[test]
    fn a_library_built_for_another_cpu_fails() {
        let library = elf_library(X86_64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let root = tempfile::tempdir().unwrap();

        let problem = stage_arm64(pin, &wheel, root.path()).unwrap_err();

        assert!(problem.contains("ELF machine"), "{problem}");
        assert!(
            problem.contains("0xb7") && problem.contains("0x3e"),
            "{problem}"
        );
        assert!(!root.path().join("out").exists());
    }

    #[test]
    fn a_4k_aligned_android_library_fails() {
        let library = elf_library(ARM64, 4096);
        let wheel = wheel_holding(MEMBER, &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let root = tempfile::tempdir().unwrap();

        let problem = stage_arm64(pin, &wheel, root.path()).unwrap_err();

        assert!(problem.contains("aligned to 4096"), "{problem}");
        assert!(!root.path().join("out").exists());
    }

    #[test]
    fn a_second_run_takes_the_wheel_from_the_cache_without_fetching() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let url = pin.url.clone();
        let runtime = runtime_of(vec![("arm64-v8a", pin)], vec![]);
        let root = tempfile::tempdir().unwrap();
        let fetcher = MapFetcher::serving(&[(&url, &wheel)]);
        let abis = strings(&["arm64-v8a"]);

        stage_android(&runtime, &abis, &places_in(root.path()), &fetcher).unwrap();
        let second = stage_android(&runtime, &abis, &places_in(root.path()), &fetcher).unwrap();

        assert_eq!(second[0].wheel, ArchiveOrigin::CacheHit);
        assert_eq!(fetcher.requests(), vec![url]);
    }

    #[test]
    fn a_cached_wheel_that_no_longer_matches_is_removed_and_refused() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let cached = Path::new("cache").join(&pin.file);
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("cache")).unwrap();
        fs::write(root.path().join(&cached), b"truncated").unwrap();

        let problem = stage_arm64(pin, &wheel, root.path()).unwrap_err();

        assert!(problem.contains("removed the cached"), "{problem}");
        assert!(!root.path().join(cached).exists());
    }

    #[test]
    fn both_abis_are_staged_each_from_its_own_wheel() {
        let arm = elf_library(ARM64, 16384);
        let x86 = elf_library(X86_64, 16384);
        let arm_wheel = wheel_holding(MEMBER, &arm);
        let x86_wheel = wheel_holding(MEMBER, &x86);
        let mut arm_pin = pin_for(&arm_wheel, &arm, Some(ARM64));
        arm_pin.url = "https://files.example/arm.whl".to_string();
        arm_pin.file = "arm.whl".to_string();
        let mut x86_pin = pin_for(&x86_wheel, &x86, Some(X86_64));
        x86_pin.url = "https://files.example/x86.whl".to_string();
        x86_pin.file = "x86.whl".to_string();
        let fetcher =
            MapFetcher::serving(&[(&arm_pin.url, &arm_wheel), (&x86_pin.url, &x86_wheel)]);
        let runtime = runtime_of(vec![("arm64-v8a", arm_pin), ("x86_64", x86_pin)], vec![]);
        let root = tempfile::tempdir().unwrap();

        let staged = stage_android(
            &runtime,
            &strings(&["arm64-v8a", "x86_64"]),
            &places_in(root.path()),
            &fetcher,
        )
        .unwrap();

        assert_eq!(staged.len(), 2);
        let out = root.path().join("out");
        assert_eq!(
            fs::read(out.join("arm64-v8a").join(ANDROID_LIBRARY_NAME)).unwrap(),
            arm
        );
        assert_eq!(
            fs::read(out.join("x86_64").join(ANDROID_LIBRARY_NAME)).unwrap(),
            x86
        );
    }

    #[test]
    fn an_abi_without_a_wheel_is_refused_naming_the_supported_ones() {
        let library = elf_library(ARM64, 16384);
        let wheel = wheel_holding(MEMBER, &library);
        let pin = pin_for(&wheel, &library, Some(ARM64));
        let runtime = runtime_of(vec![("arm64-v8a", pin)], vec![]);
        let root = tempfile::tempdir().unwrap();
        let fetcher = MapFetcher::serving(&[]);

        let problem = stage_android(
            &runtime,
            &strings(&["armeabi-v7a"]),
            &places_in(root.path()),
            &fetcher,
        )
        .unwrap_err();

        assert!(problem.contains("armeabi-v7a"), "{problem}");
        assert!(problem.contains("arm64-v8a"), "{problem}");
    }

    #[test]
    fn a_host_library_is_written_under_the_os_library_name_without_elf_checks() {
        let library = b"MZ a dll, not an elf".to_vec();
        let member = "litert_lm/litert-lm.dll";
        let wheel = wheel_holding(member, &library);
        let mut pin = pin_for(&wheel, &library, None);
        pin.member = member.to_string();
        let fetcher = MapFetcher::serving(&[(&pin.url, &wheel)]);
        let runtime = runtime_of(vec![], vec![("windows-x86_64", pin)]);
        let root = tempfile::tempdir().unwrap();

        let staged = stage_host(
            &runtime,
            "windows-x86_64",
            &places_in(root.path()),
            &fetcher,
        )
        .unwrap();

        let name = turbollm_platform::library_file_name("litert-lm");
        assert_eq!(staged.file, root.path().join("out").join(name));
        assert_eq!(fs::read(&staged.file).unwrap(), library);
    }

    #[test]
    fn a_library_without_a_pinned_sha256_is_staged_and_reports_the_one_to_pin() {
        let library = b"MZ a dll".to_vec();
        let wheel = wheel_holding(MEMBER, &library);
        let mut pin = pin_for(&wheel, &library, None);
        pin.library_sha256 = None;
        let fetcher = MapFetcher::serving(&[(&pin.url, &wheel)]);
        let runtime = runtime_of(vec![], vec![("windows-x86_64", pin)]);
        let root = tempfile::tempdir().unwrap();

        let staged = stage_host(
            &runtime,
            "windows-x86_64",
            &places_in(root.path()),
            &fetcher,
        )
        .unwrap();

        assert!(!staged.library_pinned);
        assert_eq!(staged.library_sha256, sha256_hex(&library));
    }

    #[test]
    fn a_host_without_a_wheel_is_refused() {
        let runtime = runtime_of(vec![], vec![]);
        let fetcher = MapFetcher::serving(&[]);
        let root = tempfile::tempdir().unwrap();

        let problem =
            stage_host(&runtime, "linux-aarch64", &places_in(root.path()), &fetcher).unwrap_err();

        assert!(problem.contains("linux-aarch64"), "{problem}");
    }

    #[test]
    fn this_os_and_cpu_pick_their_host_wheel() {
        assert_eq!(host_key("linux", "x86_64").unwrap(), "linux-x86_64");
        assert_eq!(host_key("macos", "aarch64").unwrap(), "macos-aarch64");
        assert_eq!(host_key("windows", "x86_64").unwrap(), "windows-x86_64");
        let problem = host_key("linux", "aarch64").unwrap_err();
        for supported in ["linux-x86_64", "macos-aarch64", "windows-x86_64"] {
            assert!(problem.contains(supported), "{problem}");
        }
    }

    #[test]
    fn the_command_line_names_abis_or_the_host_and_always_an_output_folder() {
        assert_eq!(
            parse_request(&strings(&["--abis", "arm64-v8a,x86_64", "--out", "o"])).unwrap(),
            Request::Android {
                abis: strings(&["arm64-v8a", "x86_64"]),
                out: "o".into()
            }
        );
        assert_eq!(
            parse_request(&strings(&["--host", "--out", "o"])).unwrap(),
            Request::Host { out: "o".into() }
        );
        assert!(parse_request(&strings(&["--host"])).is_err());
        assert!(parse_request(&strings(&["--out", "o"])).is_err());
        assert!(parse_request(&strings(&["--abis", "x86_64", "--host", "--out", "o"])).is_err());
        assert!(parse_request(&strings(&["--abis", "", "--out", "o"])).is_err());
    }

    fn aar_member(abi: &str) -> String {
        format!("jni/{abi}/{ANDROID_LIBRARY_NAME}")
    }

    fn pinned_runtime_for(library: &[u8]) -> Runtime {
        let wheel = wheel_holding(MEMBER, library);
        runtime_of(
            vec![
                ("arm64-v8a", pin_for(&wheel, library, Some(ARM64))),
                ("x86_64", pin_for(&wheel, library, Some(X86_64))),
            ],
            vec![],
        )
    }

    fn aar_with(libraries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (abi, bytes) in libraries {
            writer
                .start_file(aar_member(abi), SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn a_packaged_library_equal_to_the_pin_passes() {
        let library = elf_library(ARM64, 0x4000);
        let runtime = pinned_runtime_for(&library);
        let aar = aar_with(&[("arm64-v8a", &library), ("x86_64", &library)]);
        let checked = check_packaged(&runtime, &aar, &strings(&["arm64-v8a", "x86_64"])).unwrap();
        assert_eq!(checked.len(), 2);
        assert!(checked[0].contains("arm64-v8a") && checked[0].contains(&sha256_hex(&library)));
    }

    #[test]
    fn a_packaged_library_eight_bytes_short_fails_naming_both_hashes() {
        let library = elf_library(ARM64, 0x4000);
        let runtime = pinned_runtime_for(&library);
        let stripped = &library[..library.len() - 8];
        let aar = aar_with(&[("arm64-v8a", stripped), ("x86_64", &library)]);
        let error = check_packaged(&runtime, &aar, &strings(&["arm64-v8a", "x86_64"])).unwrap_err();
        assert!(error.contains("arm64-v8a"), "{error}");
        assert!(error.contains(&sha256_hex(&library)), "{error}");
        assert!(error.contains(&sha256_hex(stripped)), "{error}");
    }

    #[test]
    fn a_missing_abi_in_the_aar_fails() {
        let library = elf_library(ARM64, 0x4000);
        let runtime = pinned_runtime_for(&library);
        let aar = aar_with(&[("arm64-v8a", &library)]);
        let error = check_packaged(&runtime, &aar, &strings(&["arm64-v8a", "x86_64"])).unwrap_err();
        assert!(
            error.contains("x86_64") && error.contains(&aar_member("x86_64")),
            "{error}"
        );
    }

    #[test]
    fn an_abi_without_a_pinned_library_sha256_fails_the_packaged_check() {
        let library = elf_library(ARM64, 0x4000);
        let mut runtime = pinned_runtime_for(&library);
        runtime.android.get_mut("arm64-v8a").unwrap().library_sha256 = None;
        let aar = aar_with(&[("arm64-v8a", &library)]);
        let error = check_packaged(&runtime, &aar, &strings(&["arm64-v8a"])).unwrap_err();
        assert!(
            error.contains("arm64-v8a") && error.contains("not pinned"),
            "{error}"
        );
    }

    #[test]
    fn the_packaged_check_takes_an_aar_and_optionally_the_abis() {
        let request = parse_packaged_request(&strings(&["a.aar"])).unwrap();
        assert_eq!(
            request,
            PackagedRequest {
                aar: "a.aar".into(),
                abis: None
            }
        );
        let request = parse_packaged_request(&strings(&["a.aar", "--abis", "x86_64"])).unwrap();
        assert_eq!(request.abis, Some(strings(&["x86_64"])));
        assert!(parse_packaged_request(&strings(&[])).is_err());
        assert!(parse_packaged_request(&strings(&["a.aar", "--abis"])).is_err());
    }

    fn runtime_json_with_library_sha256(value: &str) -> String {
        format!(
            r#"{{"version":"0.19.0","android":{{"arm64-v8a":{{"file":"f.whl","url":"https://x/f.whl","sha256":"aa","member":"m","librarySha256":{value}}}}},"host":{{}}}}"#
        )
    }

    #[test]
    fn a_librarysha256_that_is_not_a_string_is_refused() {
        for bad in ["42", r#"{"a":1}"#, "true"] {
            let error = parse_runtime(&runtime_json_with_library_sha256(bad)).unwrap_err();
            assert!(
                error.contains("arm64-v8a")
                    && error.contains("librarySha256 must be a string or null"),
                "{bad}: {error}"
            );
        }
    }

    #[test]
    fn a_null_librarysha256_means_not_pinned() {
        let runtime = parse_runtime(&runtime_json_with_library_sha256("null")).unwrap();
        assert_eq!(runtime.android["arm64-v8a"].library_sha256, None);
    }

    fn shipped_runtime() -> Runtime {
        let pin = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("crates")
            .join("turbollm-engine-litert")
            .join(PIN_FILE);
        parse_runtime(&fs::read_to_string(pin).unwrap()).unwrap()
    }

    #[test]
    fn the_shipped_pins_are_litert_lm_0_19_0_and_both_android_libraries_are_fully_pinned() {
        let runtime = shipped_runtime();
        assert_eq!(runtime.version, "0.19.0");
        for (abi, machine) in [("arm64-v8a", ARM64), ("x86_64", X86_64)] {
            let pin = &runtime.android[abi];
            assert!(pin.file.contains("0.19.0") && pin.file.contains("android_23"));
            assert_eq!(pin.member, MEMBER);
            assert_eq!(pin.elf_machine, Some(machine));
            assert_eq!(pin.sha256.len(), 64);
            assert_eq!(pin.library_sha256.as_ref().map(String::len), Some(64));
        }
        let hosts: Vec<_> = runtime.host.keys().map(String::as_str).collect();
        assert_eq!(hosts, ["linux-x86_64", "macos-aarch64", "windows-x86_64"]);
        for pin in runtime.host.values() {
            assert!(pin.file.contains("0.19.0"));
            assert!(pin.url.starts_with("https://files.pythonhosted.org/"));
            assert_eq!(pin.sha256.len(), 64);
        }
    }
}
