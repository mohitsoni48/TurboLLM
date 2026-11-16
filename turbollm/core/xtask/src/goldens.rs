//! `cargo xtask goldens-check`: the GGUF fixture folder is complete and within its rules (plan T8, arch 3.1-3.3).

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde_json::Value;

/// The most bytes a committed crafted fixture may have (arch 3.1).
const CRAFTED_SIZE_CAP: u64 = 64 * 1024;
const CRAFTED_GITIGNORE: &str = "!*.gguf";
const DECLARED_DIVERGENCE_RULES: [&str; 2] = ["D-1", "D-2"];

/// What the fixture folder holds, as far as the check cares.
#[derive(Default)]
pub struct FixtureListing {
    /// `crafted/<id>.gguf` ids with their sizes.
    pub crafted: Vec<(String, u64)>,
    /// `golden/<id>.json` ids, without `quant-names` and the `<id>.ts.json` files.
    pub goldens: Vec<String>,
    /// Golden ids that have no crafted file by design: generated fixtures and corpus entries.
    pub uncrafted_goldens: HashSet<String>,
    /// `golden/<id>.ts.json` ids.
    pub typescript_goldens: HashSet<String>,
    /// `divergences.json` entries: id and rule.
    pub divergences: Vec<(String, String)>,
    /// The text of `crafted/.gitignore`, when it exists.
    pub crafted_gitignore: Option<String>,
}

/// Every rule the listing breaks, one line each; empty when the folder is in order.
pub fn problems(listing: &FixtureListing) -> Vec<String> {
    let mut problems = crafted_without_golden(listing);
    problems.extend(goldens_without_crafted(listing));
    problems.extend(oversized_crafted(listing));
    problems.extend(undeclared_divergences(listing));
    if listing.crafted_gitignore.as_deref().map(str::trim) != Some(CRAFTED_GITIGNORE) {
        problems.push(format!("crafted/.gitignore is not {CRAFTED_GITIGNORE:?}"));
    }
    problems
}

/// Reads the fixture folder at `fixtures_dir` (`turbollm/core/fixtures/gguf`).
pub fn list_fixtures(fixtures_dir: &Path) -> Result<FixtureListing, String> {
    let crafted_dir = fixtures_dir.join("crafted");
    let golden_dir = fixtures_dir.join("golden");
    let crafted = files_with_suffix(&crafted_dir, ".gguf")?;
    let golden_files = files_with_suffix(&golden_dir, ".json")?;
    let typescript_goldens = golden_files
        .iter()
        .filter_map(|(id, _)| id.strip_suffix(".ts"))
        .map(String::from);
    let goldens: Vec<String> = golden_files
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| id != "quant-names" && !id.ends_with(".ts"))
        .collect();
    let mut uncrafted_goldens = corpus_ids(fixtures_dir)?;
    for id in &goldens {
        if read_json(&golden_dir.join(format!("{id}.json")))?
            .get("generated")
            .is_some()
        {
            uncrafted_goldens.insert(id.clone());
        }
    }
    Ok(FixtureListing {
        crafted,
        uncrafted_goldens,
        typescript_goldens: typescript_goldens.collect(),
        goldens,
        divergences: divergences(fixtures_dir)?,
        crafted_gitignore: fs::read_to_string(crafted_dir.join(".gitignore")).ok(),
    })
}

fn crafted_without_golden(listing: &FixtureListing) -> Vec<String> {
    let goldens: HashSet<&String> = listing.goldens.iter().collect();
    listing
        .crafted
        .iter()
        .filter(|(id, _)| !goldens.contains(id))
        .map(|(id, _)| format!("crafted/{id}.gguf has no golden/{id}.json"))
        .collect()
}

fn goldens_without_crafted(listing: &FixtureListing) -> Vec<String> {
    let crafted: HashSet<&String> = listing.crafted.iter().map(|(id, _)| id).collect();
    listing
        .goldens
        .iter()
        .filter(|id| !crafted.contains(id) && !listing.uncrafted_goldens.contains(*id))
        .map(|id| format!("golden/{id}.json has no crafted/{id}.gguf"))
        .collect()
}

fn oversized_crafted(listing: &FixtureListing) -> Vec<String> {
    listing
        .crafted
        .iter()
        .filter(|(_, size)| *size > CRAFTED_SIZE_CAP)
        .map(|(id, size)| {
            format!("crafted/{id}.gguf is {size} bytes, above the {CRAFTED_SIZE_CAP}-byte cap")
        })
        .collect()
}

fn undeclared_divergences(listing: &FixtureListing) -> Vec<String> {
    let mut problems = Vec::new();
    for (id, rule) in &listing.divergences {
        if !listing.typescript_goldens.contains(id) {
            problems.push(format!("divergence {id} has no golden/{id}.ts.json"));
        }
        if !DECLARED_DIVERGENCE_RULES.contains(&rule.as_str()) {
            let declared = DECLARED_DIVERGENCE_RULES.join(" or ");
            problems.push(format!("divergence {id} has rule {rule}, not {declared}"));
        }
    }
    problems
}

/// The ids (file names without `suffix`) and sizes of the files in `dir`, sorted.
fn files_with_suffix(dir: &Path, suffix: &str) -> Result<Vec<(String, u64)>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = file_name.strip_suffix(suffix) {
            let size = entry
                .metadata()
                .map_err(|e| format!("{file_name}: {e}"))?
                .len();
            files.push((id.to_string(), size));
        }
    }
    files.sort();
    Ok(files)
}

fn corpus_ids(fixtures_dir: &Path) -> Result<HashSet<String>, String> {
    let corpus = read_json(&fixtures_dir.join("corpus.json"))?;
    let entries = corpus.as_array().ok_or("corpus.json is not an array")?;
    entries
        .iter()
        .map(|entry| {
            entry["id"]
                .as_str()
                .map(String::from)
                .ok_or_else(|| "corpus.json entry without an id".to_string())
        })
        .collect()
}

fn divergences(fixtures_dir: &Path) -> Result<Vec<(String, String)>, String> {
    divergence_entries(&read_json(&fixtures_dir.join("divergences.json"))?)
}

fn divergence_entries(declared: &Value) -> Result<Vec<(String, String)>, String> {
    let entries = declared
        .as_object()
        .ok_or("divergences.json is not an object")?;
    entries
        .iter()
        .map(|(id, rule)| {
            let rule = rule
                .as_str()
                .ok_or_else(|| format!("divergences.json: the rule of {id} is not a string"))?;
            Ok((id.clone(), rule.to_string()))
        })
        .collect()
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tidy_listing() -> FixtureListing {
        FixtureListing {
            crafted: vec![("align-3".into(), 120), ("d1-above-u32".into(), 200)],
            goldens: vec![
                "align-3".into(),
                "d1-above-u32".into(),
                "gen-big-vocab".into(),
            ],
            uncrafted_goldens: HashSet::from(["gen-big-vocab".into()]),
            typescript_goldens: HashSet::from(["d1-above-u32".into()]),
            divergences: vec![("d1-above-u32".into(), "D-1".into())],
            crafted_gitignore: Some("!*.gguf\n".into()),
        }
    }

    #[test]
    fn a_tidy_folder_has_no_problems() {
        assert_eq!(problems(&tidy_listing()), Vec::<String>::new());
    }

    #[test]
    fn a_crafted_file_without_a_golden_is_a_problem() {
        let mut listing = tidy_listing();
        listing.crafted.push(("orphan".into(), 10));
        assert_eq!(
            problems(&listing),
            ["crafted/orphan.gguf has no golden/orphan.json"]
        );
    }

    #[test]
    fn a_golden_without_a_crafted_file_is_a_problem() {
        let mut listing = tidy_listing();
        listing.goldens.push("lost".into());
        assert_eq!(
            problems(&listing),
            ["golden/lost.json has no crafted/lost.gguf"]
        );
    }

    #[test]
    fn a_crafted_file_above_64_kib_is_a_problem() {
        let mut listing = tidy_listing();
        listing.crafted[0].1 = 65_537;
        assert_eq!(
            problems(&listing),
            ["crafted/align-3.gguf is 65537 bytes, above the 65536-byte cap"]
        );
    }

    #[test]
    fn a_crafted_file_of_exactly_64_kib_is_allowed() {
        let mut listing = tidy_listing();
        listing.crafted[0].1 = 65_536;
        assert_eq!(problems(&listing), Vec::<String>::new());
    }

    #[test]
    fn a_divergence_without_its_typescript_golden_is_a_problem() {
        let mut listing = tidy_listing();
        listing.typescript_goldens.clear();
        assert_eq!(
            problems(&listing),
            ["divergence d1-above-u32 has no golden/d1-above-u32.ts.json"]
        );
    }

    #[test]
    fn a_divergence_with_an_undeclared_rule_is_a_problem() {
        let mut listing = tidy_listing();
        listing.divergences[0].1 = "D-3".into();
        assert_eq!(
            problems(&listing),
            ["divergence d1-above-u32 has rule D-3, not D-1 or D-2"]
        );
    }

    #[test]
    fn divergence_entries_are_id_and_rule_pairs() {
        let declared = serde_json::json!({ "d1-above-u32": "D-1" });
        assert_eq!(
            divergence_entries(&declared).unwrap(),
            [("d1-above-u32".to_string(), "D-1".to_string())]
        );
    }

    #[test]
    fn a_divergence_rule_that_is_not_a_string_is_reported() {
        let declared = serde_json::json!({ "d1-above-u32": 1 });
        assert_eq!(
            divergence_entries(&declared).unwrap_err(),
            "divergences.json: the rule of d1-above-u32 is not a string"
        );
    }

    #[test]
    fn a_missing_crafted_gitignore_is_a_problem() {
        let mut listing = tidy_listing();
        listing.crafted_gitignore = None;
        assert_eq!(
            problems(&listing),
            ["crafted/.gitignore is not \"!*.gguf\""]
        );
    }

    #[test]
    fn a_crafted_gitignore_with_other_rules_is_a_problem() {
        let mut listing = tidy_listing();
        listing.crafted_gitignore = Some("*.gguf\n".into());
        assert_eq!(
            problems(&listing),
            ["crafted/.gitignore is not \"!*.gguf\""]
        );
    }
}
