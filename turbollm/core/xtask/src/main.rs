mod elf;
mod goldens;
mod uniffi;
mod version;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "usage: cargo xtask <command>\n\n\
commands:\n  \
sync-version   set the workspace version in core/Cargo.toml from turbollm/package.json\n  \
check-version  fail if core/Cargo.toml and turbollm/package.json versions differ\n  \
goldens-check  fail if the GGUF fixture folder is incomplete or breaks its rules\n  \
uniffi-kotlin --lib <library> --out <dir>  generate Kotlin bindings from a built turbollm-ffi library\n  \
check-android-elf <file> [--needs <library>]  fail unless every PT_LOAD is 16 KB aligned (and <library> is DT_NEEDED)\n  \
check-glibc --max <x.y> <file>  fail if the file needs a GLIBC_ symbol version above <x.y>";
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
