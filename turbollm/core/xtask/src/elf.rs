//! `check-android-elf <file> [--needs <library>]` and `check-glibc --max <x.y> <file>`: checks on a built
//! shared library that only its ELF headers can answer (plan T16).
//!
//! Android 15+ devices with 16 KB pages refuse a library whose `PT_LOAD` segments are aligned below 16 KB, and
//! the nodejs-mobile addon must name `libnode.so` in `DT_NEEDED` so the loader resolves its `napi_*` imports.
//! A Linux build must not need a glibc symbol version newer than the floor the npm package promises.

use std::path::PathBuf;

use object::Endianness;
use object::elf;
use object::read::elf::{ElfFile64, ProgramHeader};

/// The page size Android requires every loadable segment to be aligned to.
pub const ANDROID_PAGE_ALIGNMENT: u64 = 16 * 1024;

const GLIBC_VERSION_PREFIX: &str = "GLIBC_";

/// What the checks need from a 64-bit ELF shared library.
#[derive(Debug, PartialEq, Eq)]
pub struct SharedLibrary {
    pub load_alignments: Vec<u64>,
    pub needed: Vec<String>,
    pub version_needs: Vec<String>,
}

/// The arguments of `check-android-elf`.
#[derive(Debug, PartialEq, Eq)]
pub struct AndroidElfRequest {
    pub file: PathBuf,
    pub needs: Option<String>,
}

/// The arguments of `check-glibc`.
#[derive(Debug, PartialEq, Eq)]
pub struct GlibcRequest {
    pub file: PathBuf,
    pub max: String,
}

/// Reads the loadable-segment alignments, `DT_NEEDED` libraries and needed symbol versions of a library.
pub fn read_shared_library(file: &[u8]) -> Result<SharedLibrary, String> {
    let library =
        ElfFile64::<Endianness>::parse(file).map_err(|e| format!("not a 64-bit ELF file: {e}"))?;
    Ok(SharedLibrary {
        load_alignments: load_alignments(&library),
        needed: needed_libraries(&library, file)
            .map_err(|e| format!("bad dynamic section: {e}"))?,
        version_needs: version_needs(&library, file)
            .map_err(|e| format!("bad .gnu.version_r: {e}"))?,
    })
}

/// The `e_machine` of a 64-bit ELF file: the CPU the library was built for.
pub fn elf_machine(file: &[u8]) -> Result<u16, String> {
    let library =
        ElfFile64::<Endianness>::parse(file).map_err(|e| format!("not a 64-bit ELF file: {e}"))?;
    Ok(library.elf_header().e_machine.get(library.endian()).0)
}

/// Why Android would refuse to load the library, or would load it without `needs`; empty when it is fine.
pub fn android_problems(library: &SharedLibrary, needs: Option<&str>) -> Vec<String> {
    let mut problems = alignment_problems(&library.load_alignments);
    if let Some(wanted) = needs.filter(|wanted| !library.needed.iter().any(|n| n == wanted)) {
        problems.push(format!(
            "no DT_NEEDED entry for {wanted} (has: {})",
            library.needed.join(", ")
        ));
    }
    problems
}

/// The `GLIBC_x.y[.z]` versions above `max`. Other version names (`GCC_3.0`, `GLIBC_PRIVATE`) are not glibc
/// releases and are ignored.
pub fn glibc_floor_violations(version_needs: &[String], max: &str) -> Result<Vec<String>, String> {
    let floor = release_numbers(max)
        .ok_or_else(|| format!("check-glibc: --max {max:?} is not a version like 2.28"))?;
    Ok(version_needs
        .iter()
        .filter(|name| glibc_release(name).is_some_and(|release| release > floor))
        .cloned()
        .collect())
}

/// Reads `<file> [--needs <library>]`.
pub fn android_elf_request(args: &[String]) -> Result<AndroidElfRequest, String> {
    let (file, needs) = file_and_flag("check-android-elf", "--needs", args)?;
    Ok(AndroidElfRequest { file, needs })
}

/// Reads `--max <x.y> <file>`, the flag required.
pub fn glibc_request(args: &[String]) -> Result<GlibcRequest, String> {
    let (file, max) = file_and_flag("check-glibc", "--max", args)?;
    let max = max.ok_or("check-glibc: --max <x.y> is required")?;
    Ok(GlibcRequest { file, max })
}

fn load_alignments(library: &ElfFile64<Endianness>) -> Vec<u64> {
    let endian = library.endian();
    library
        .elf_program_headers()
        .iter()
        .filter(|segment| segment.p_type(endian) == elf::PT_LOAD)
        .map(|segment| segment.p_align(endian))
        .collect()
}

fn needed_libraries(library: &ElfFile64<Endianness>, file: &[u8]) -> object::Result<Vec<String>> {
    let dynamic = library
        .elf_section_table()
        .dynamic_table(library.endian(), file)?;
    dynamic
        .iter()
        .filter(|entry| entry.tag == elf::DT_NEEDED)
        .map(|entry| dynamic.string(entry).map(text))
        .collect()
}

fn version_needs(library: &ElfFile64<Endianness>, file: &[u8]) -> object::Result<Vec<String>> {
    let endian = library.endian();
    let sections = library.elf_section_table();
    let Some((mut needs, link)) = sections.gnu_verneed(endian, file)? else {
        return Ok(Vec::new());
    };
    let strings = sections.strings(endian, file, link)?;
    let mut names = Vec::new();
    while let Some((_, mut versions)) = needs.next()? {
        while let Some(version) = versions.next()? {
            names.push(text(version.name(endian, strings)?));
        }
    }
    Ok(names)
}

fn alignment_problems(load_alignments: &[u64]) -> Vec<String> {
    if load_alignments.is_empty() {
        return vec!["no PT_LOAD segment".to_string()];
    }
    load_alignments
        .iter()
        .enumerate()
        .filter(|(_, align)| **align < ANDROID_PAGE_ALIGNMENT)
        .map(|(index, align)| {
            format!("PT_LOAD segment {index} is aligned to {align} bytes; Android needs at least {ANDROID_PAGE_ALIGNMENT}")
        })
        .collect()
}

fn glibc_release(version_name: &str) -> Option<Vec<u32>> {
    version_name
        .strip_prefix(GLIBC_VERSION_PREFIX)
        .and_then(release_numbers)
}

fn release_numbers(version: &str) -> Option<Vec<u32>> {
    version.split('.').map(|part| part.parse().ok()).collect()
}

/// One positional file plus one optional `<flag> <value>`, in either order.
fn file_and_flag(
    command: &str,
    flag: &str,
    args: &[String],
) -> Result<(PathBuf, Option<String>), String> {
    let mut file = None;
    let mut value = None;
    let mut words = args.iter();
    while let Some(word) = words.next() {
        if word == flag {
            value = Some(
                words
                    .next()
                    .ok_or_else(|| format!("{command}: {flag} needs a value"))?
                    .clone(),
            );
        } else if file.replace(PathBuf::from(word)).is_some() {
            return Err(format!("{command}: more than one file given"));
        }
    }
    Ok((
        file.ok_or_else(|| format!("{command}: no file given"))?,
        value,
    ))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use object::write::elf::{FileHeader as FileHeaderSpec, ProgramHeader as ProgramHeaderSpec};
    use object::write::elf::{Vernaux, Verneed, Writer};

    /// The parts of a test shared library that the checks look at.
    struct LibrarySpec<'a> {
        load_align: u64,
        needed: &'a [&'a str],
        glibc_versions: &'a [&'a str],
    }

    fn shared_library(spec: &LibrarySpec) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut writer = Writer::new(Endianness::Little, true, &mut bytes);
        let needed: Vec<_> = spec
            .needed
            .iter()
            .map(|n| writer.add_dynamic_string(n.as_bytes()))
            .collect();
        let libc = writer.add_dynamic_string(b"libc.so.6");
        let versions: Vec<_> = spec
            .glibc_versions
            .iter()
            .map(|v| writer.add_dynamic_string(v.as_bytes()))
            .collect();

        writer.reserve_file_header();
        writer.reserve_program_headers(1);
        writer.reserve_dynstr_section_index();
        writer.reserve_dynamic_section_index();
        if !versions.is_empty() {
            writer.reserve_gnu_verneed_section_index();
        }
        writer.reserve_shstrtab_section_index();
        writer.reserve_dynstr().unwrap();
        writer.reserve_dynamic(needed.len() + 1);
        writer.reserve_gnu_verneed(u16::from(!versions.is_empty()), versions.len());
        writer.reserve_shstrtab().unwrap();
        writer.reserve_section_headers();
        let file_len = writer.reserved_len();

        writer
            .write_file_header(&FileHeaderSpec {
                os_abi: elf::ELFOSABI_NONE,
                abi_version: 0,
                e_type: elf::ET_DYN,
                e_machine: elf::EM_AARCH64,
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
            p_align: spec.load_align,
        });
        writer.write_dynstr();
        writer.write_align_dynamic();
        for library in &needed {
            writer
                .write_dynamic_string(elf::DT_NEEDED, *library)
                .unwrap();
        }
        writer.write_dynamic(elf::DT_NULL, 0).unwrap();
        if !versions.is_empty() {
            writer.write_align_gnu_verneed();
            writer.write_gnu_verneed(&Verneed {
                version: elf::VER_NEED_CURRENT,
                aux_count: versions.len() as u16,
                file: writer.dynamic_string_offset(Some(libc)),
            });
            for (index, version) in versions.iter().enumerate() {
                writer.write_gnu_vernaux(&Vernaux {
                    flags: elf::VersionFlags(0),
                    index: elf::VersionIndex(index as u16 + 2),
                    name: writer.dynamic_string_offset(Some(*version)),
                    hash: elf::hash(spec.glibc_versions[index].as_bytes()),
                });
            }
        }
        writer.write_shstrtab();
        writer.write_null_section_header();
        writer.write_dynstr_section_header(0);
        writer.write_dynamic_section_header(0);
        writer.write_gnu_verneed_section_header(0);
        writer.write_shstrtab_section_header();
        bytes
    }

    #[test]
    fn reads_the_machine_the_library_was_built_for() {
        let bytes = shared_library(&LibrarySpec {
            load_align: 16384,
            needed: &[],
            glibc_versions: &[],
        });
        assert_eq!(elf_machine(&bytes).unwrap(), elf::EM_AARCH64.0);
        assert!(elf_machine(b"MZ not an elf").is_err());
    }

    fn library(load_align: u64, needed: &[&str]) -> SharedLibrary {
        let bytes = shared_library(&LibrarySpec {
            load_align,
            needed,
            glibc_versions: &[],
        });
        read_shared_library(&bytes).unwrap()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_load_alignment_needed_libraries_and_glibc_versions() {
        let bytes = shared_library(&LibrarySpec {
            load_align: 16384,
            needed: &["libnode.so", "libc.so"],
            glibc_versions: &["GLIBC_2.17", "GLIBC_2.28"],
        });
        assert_eq!(
            read_shared_library(&bytes).unwrap(),
            SharedLibrary {
                load_alignments: vec![16384],
                needed: strings(&["libnode.so", "libc.so"]),
                version_needs: strings(&["GLIBC_2.17", "GLIBC_2.28"]),
            }
        );
    }

    #[test]
    fn a_16k_aligned_library_that_needs_libnode_passes() {
        let addon = library(16384, &["libnode.so", "libc.so"]);
        assert_eq!(
            android_problems(&addon, Some("libnode.so")),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_4k_aligned_library_fails() {
        let addon = library(4096, &["libnode.so"]);
        assert_eq!(
            android_problems(&addon, Some("libnode.so")),
            strings(&["PT_LOAD segment 0 is aligned to 4096 bytes; Android needs at least 16384"])
        );
    }

    #[test]
    fn a_library_without_the_needed_entry_fails_only_when_it_is_asked_for() {
        let addon = library(16384, &["libc.so"]);
        assert_eq!(
            android_problems(&addon, Some("libnode.so")),
            strings(&["no DT_NEEDED entry for libnode.so (has: libc.so)"])
        );
        assert_eq!(android_problems(&addon, None), Vec::<String>::new());
    }

    #[test]
    fn a_library_without_loadable_segments_fails() {
        let addon = SharedLibrary {
            load_alignments: vec![],
            needed: vec![],
            version_needs: vec![],
        };
        assert_eq!(
            android_problems(&addon, None),
            strings(&["no PT_LOAD segment"])
        );
    }

    #[test]
    fn bytes_that_are_not_a_64_bit_elf_are_refused() {
        assert!(read_shared_library(b"MZ not an elf").is_err());
    }

    #[test]
    fn glibc_versions_at_or_below_the_floor_pass() {
        let needs = strings(&["GLIBC_2.17", "GLIBC_2.28", "GCC_3.0", "GLIBC_PRIVATE"]);
        assert_eq!(
            glibc_floor_violations(&needs, "2.28").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_glibc_version_above_the_floor_fails() {
        let needs = strings(&["GLIBC_2.17", "GLIBC_2.34", "GLIBC_2.3.4"]);
        assert_eq!(
            glibc_floor_violations(&needs, "2.28").unwrap(),
            strings(&["GLIBC_2.34"])
        );
    }

    #[test]
    fn glibc_versions_compare_numerically_not_as_text() {
        let needs = strings(&["GLIBC_2.9", "GLIBC_2.100"]);
        assert_eq!(
            glibc_floor_violations(&needs, "2.28").unwrap(),
            strings(&["GLIBC_2.100"])
        );
    }

    #[test]
    fn a_malformed_floor_is_refused() {
        assert!(glibc_floor_violations(&[], "two.28").is_err());
    }

    #[test]
    fn check_android_elf_takes_a_file_and_an_optional_needs() {
        assert_eq!(
            android_elf_request(&strings(&["a.so", "--needs", "libnode.so"])).unwrap(),
            AndroidElfRequest {
                file: "a.so".into(),
                needs: Some("libnode.so".into())
            }
        );
        assert_eq!(
            android_elf_request(&strings(&["a.so"])).unwrap(),
            AndroidElfRequest {
                file: "a.so".into(),
                needs: None
            }
        );
        assert!(android_elf_request(&strings(&["--needs", "libnode.so"])).is_err());
        assert!(android_elf_request(&strings(&["a.so", "--needs"])).is_err());
        assert!(android_elf_request(&strings(&["a.so", "b.so"])).is_err());
    }

    #[test]
    fn check_glibc_takes_a_floor_and_a_file() {
        assert_eq!(
            glibc_request(&strings(&["--max", "2.28", "a.node"])).unwrap(),
            GlibcRequest {
                file: "a.node".into(),
                max: "2.28".into()
            }
        );
        assert!(glibc_request(&strings(&["a.node"])).is_err());
        assert!(glibc_request(&strings(&["--max", "2.28"])).is_err());
    }
}
