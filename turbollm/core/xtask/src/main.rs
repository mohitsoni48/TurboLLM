mod elf;
mod goldens;
mod litert;
mod llama;
mod uniffi;
mod version;

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const USAGE: &str = "usage: cargo xtask <command>\n\n\
commands:\n  \
sync-version   set the workspace version in core/Cargo.toml from turbollm/package.json\n  \
check-version  fail if core/Cargo.toml and turbollm/package.json versions differ\n  \
goldens-check  fail if the GGUF fixture folder is incomplete or breaks its rules\n  \
uniffi-kotlin --lib <library> --out <dir>  generate Kotlin bindings from a built turbollm-ffi library\n  \
check-android-elf <file> [--needs <library>]  fail unless every PT_LOAD is 16 KB aligned (and <library> is DT_NEEDED)\n  \
check-glibc --max <x.y> <file>  fail if the file needs a GLIBC_ symbol version above <x.y>\n  \
fetch-llama --out <dir>  put the pinned, sha256-checked llama.cpp source at <dir>/llama.cpp\n  \
build-llama --host [--variant base]  CMake-build turbollm_core_llama_<variant> into target/llama/<host-triple>
  \nfetch-litert --abis <arm64-v8a,x86_64> --out <dir>  stage the pinned LiteRT-LM library per Android ABI
  \nfetch-litert --host --out <dir>  stage the pinned LiteRT-LM library for this OS
  check-litert-packaged <aar> [--abis <list>]  fail unless the AAR's LiteRT library is byte-identical to the pin";
const FAILURE_EXIT: u8 = 1;
const UNKNOWN_COMMAND_EXIT: u8 = 2;

fn main() -> ExitCode {
    let command = env::args().nth(1).unwrap_or_default();
    let outcome = match command.as_str() {
        "sync-version" => sync_version(),
        "check-version" => check_version(),
        "goldens-check" => goldens_check(),
        "uniffi-kotlin" => uniffi_kotlin(),
        "check-android-elf" => check_android_elf(),
        "check-glibc" => check_glibc(),
        "fetch-llama" => fetch_llama(),
        "build-llama" => build_llama(),
        "fetch-litert" => fetch_litert(),
        "check-litert-packaged" => check_litert_packaged(),
        _ => {
            eprintln!("unknown command {command:?}\n{USAGE}");
            return ExitCode::from(UNKNOWN_COMMAND_EXIT);
        }
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(FAILURE_EXIT)
        }
    }
}

fn sync_version() -> Result<(), String> {
    let cargo_toml = read(&workspace_manifest())?;
    let version = version::package_version(&read(&package_json())?)?;
    let synced = version::with_workspace_version(&cargo_toml, &version)?;
    if synced != cargo_toml {
        fs::write(workspace_manifest(), synced)
            .map_err(|e| format!("{}: {e}", workspace_manifest().display()))?;
    }
    println!("core/Cargo.toml version {version}");
    Ok(())
}

fn check_version() -> Result<(), String> {
    let drift = version::version_drift(&read(&workspace_manifest())?, &read(&package_json())?)?;
    drift.map_or(Ok(()), Err)
}

fn goldens_check() -> Result<(), String> {
    let listing = goldens::list_fixtures(&core_dir().join("fixtures").join("gguf"))?;
    let problems = goldens::problems(&listing);
    if !problems.is_empty() {
        return Err(problems.join("\n"));
    }
    println!(
        "goldens-check: {} crafted, {} goldens, ok",
        listing.crafted.len(),
        listing.goldens.len()
    );
    Ok(())
}

fn uniffi_kotlin() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(2).collect();
    let request = uniffi::kotlin_request(&args)?;
    uniffi::generate_kotlin(&request, &core_dir())?;
    println!("uniffi-kotlin: wrote {}", request.out_dir.display());
    Ok(())
}

fn check_android_elf() -> Result<(), String> {
    let request = elf::android_elf_request(&command_args())?;
    let library = elf::read_shared_library(&read_bytes(&request.file)?)?;
    let problems = elf::android_problems(&library, request.needs.as_deref());
    let file = request.file.display();
    if !problems.is_empty() {
        let listing = problems.join("\n  ");
        return Err(format!("check-android-elf: {file}:\n  {listing}"));
    }
    println!(
        "check-android-elf: {file}: PT_LOAD align {:?}, NEEDED [{}], ok",
        library.load_alignments,
        library.needed.join(", ")
    );
    Ok(())
}

fn check_glibc() -> Result<(), String> {
    let request = elf::glibc_request(&command_args())?;
    let library = elf::read_shared_library(&read_bytes(&request.file)?)?;
    let too_new = elf::glibc_floor_violations(&library.version_needs, &request.max)?;
    let file = request.file.display();
    if !too_new.is_empty() {
        return Err(format!(
            "check-glibc: {file} needs {} (floor {})",
            too_new.join(", "),
            request.max
        ));
    }
    println!(
        "check-glibc: {file}: no GLIBC_ version above {}, ok",
        request.max
    );
    Ok(())
}

fn fetch_llama() -> Result<(), String> {
    let out_dir = llama::out_dir_arg(&command_args())?;
    fetched_llama_tree(out_dir).map(|_| ())
}

fn build_llama() -> Result<(), String> {
    let variant = llama::build_variant_arg(&command_args())?;
    let native_dir = llama_crate_dir().join("native");
    require_file(&native_dir.join("CMakeLists.txt"))?;
    let target_dir = core_dir().join("target");
    let llama_dir = fetched_llama_tree(target_dir.join("llama").join("src"))?;
    let library_dir = llama::host_library_dir(&target_dir, &rustc_host_triple()?);
    let build = llama::HostBuild {
        generator: llama::host_generator(env::consts::OS, ninja_on_path()),
        native_dir,
        llama_dir,
        build_dir: library_dir.join("build"),
        library_dir,
        variant,
    };
    run_cmake(&build.configure_args())?;
    run_cmake(&build.build_args())?;
    require_file(&build.library())?;
    println!("build-llama: built {}", build.library().display());
    Ok(())
}

fn check_litert_packaged() -> Result<(), String> {
    let request = litert::parse_packaged_request(&command_args())?;
    let runtime = litert::parse_runtime(&read(&litert_runtime_pin())?)?;
    let abis = request
        .abis
        .unwrap_or_else(|| runtime.android.keys().cloned().collect());
    for line in litert::check_packaged(&runtime, &read_bytes(&request.aar)?, &abis)? {
        println!("check-litert-packaged: {line}, ok");
    }
    Ok(())
}

fn fetch_litert() -> Result<(), String> {
    let request = litert::parse_request(&command_args())?;
    let runtime = litert::parse_runtime(&read(&litert_runtime_pin())?)?;
    let mut places = litert::Places {
        cache_dir: core_dir().join("target").join("cache").join("litert"),
        out_dir: PathBuf::new(),
    };
    let staged = match request {
        litert::Request::Android { abis, out } => {
            places.out_dir = out;
            litert::stage_android(&runtime, &abis, &places, &llama::HttpsFetcher)?
        }
        litert::Request::Host { out } => {
            places.out_dir = out;
            let key = litert::host_key(env::consts::OS, env::consts::ARCH)?;
            vec![litert::stage_host(
                &runtime,
                key,
                &places,
                &llama::HttpsFetcher,
            )?]
        }
    };
    for library in &staged {
        println!(
            "fetch-litert: {} {}: wheel {}, library sha256 {}{}, wrote {}",
            runtime.version,
            library.target,
            library.wheel,
            library.library_sha256,
            if library.library_pinned {
                ""
            } else {
                " (not pinned yet: add it to litert-runtime.json)"
            },
            library.file.display()
        );
    }
    Ok(())
}

fn fetched_llama_tree(out_dir: PathBuf) -> Result<PathBuf, String> {
    let source = llama::parse_source(&read(&llama_source_pin())?)?;
    let places = llama::SourcePlaces {
        cache_dir: core_dir().join("target").join("cache").join("llama"),
        out_dir,
    };
    match llama::fetch_llama(&source, &places, &llama::HttpsFetcher)? {
        llama::FetchOutcome::AlreadyExtracted { tree } => {
            println!(
                "fetch-llama: {} already holds {}, nothing to do",
                tree.display(),
                source.commit
            );
            Ok(tree)
        }
        llama::FetchOutcome::Extracted {
            tree,
            origin,
            sha256,
        } => {
            println!(
                "fetch-llama: {origin} {}, sha256 {sha256}, extracted to {}",
                source.archive_url(),
                tree.display()
            );
            Ok(tree)
        }
    }
}

fn rustc_host_triple() -> Result<String, String> {
    let rustc = env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = Command::new(&rustc)
        .arg("-vV")
        .output()
        .map_err(|e| format!("{}: {e}", rustc.to_string_lossy()))?;
    llama::host_triple(&String::from_utf8_lossy(&output.stdout))
}

fn ninja_on_path() -> bool {
    env::var_os("PATH").is_some_and(|path_var| llama::on_path(&path_var, "ninja"))
}

/// `TURBOLLM_CMAKE` first, so a box whose PATH holds an unsuitable `cmake` can name the right one (plan P-8).
fn run_cmake(args: &[OsString]) -> Result<(), String> {
    let cmake = env::var_os("TURBOLLM_CMAKE").unwrap_or_else(|| "cmake".into());
    let status = Command::new(&cmake)
        .args(args)
        .status()
        .map_err(|e| format!("{}: {e}", cmake.to_string_lossy()))?;
    if !status.success() {
        return Err(format!("{} {args:?}: {status}", cmake.to_string_lossy()));
    }
    Ok(())
}

fn require_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{}: no such file", path.display()));
    }
    Ok(())
}

fn command_args() -> Vec<String> {
    env::args().skip(2).collect()
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn core_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask lives inside turbollm/core")
        .to_path_buf()
}

fn llama_source_pin() -> PathBuf {
    llama_crate_dir().join("llama-source.json")
}

fn llama_crate_dir() -> PathBuf {
    core_dir().join("crates").join("turbollm-engine-llama")
}

fn litert_runtime_pin() -> PathBuf {
    core_dir()
        .join("crates")
        .join("turbollm-engine-litert")
        .join("litert-runtime.json")
}

fn workspace_manifest() -> PathBuf {
    core_dir().join("Cargo.toml")
}

fn package_json() -> PathBuf {
    core_dir()
        .parent()
        .expect("core lives inside turbollm")
        .join("package.json")
}

fn read(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}
