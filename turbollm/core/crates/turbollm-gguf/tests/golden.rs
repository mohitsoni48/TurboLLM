//! Byte-for-byte parity with the TypeScript oracle (architecture 3.2): every golden in `fixtures/gguf/golden`
//! holds the exact JSON text `parseGgufAsync` produced and the `ggufCutShort` verdicts; Rust must reproduce both.

mod support;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};
use support::builders::generated_fixture;
use support::{crafted_path, fixtures_dir, parse_text};
use turbollm_gguf::{MAX_HEADER_READ, is_cut_short, parse, parse_file};

#[test]
fn every_golden_matches_the_typescript_oracle() {
    let corpus_ids = corpus_ids();
    let mut tally = Tally::default();
    let mut mismatches = Vec::new();
    for (id, golden) in goldens() {
        match fixture_kind(&id, &golden, &corpus_ids) {
            FixtureKind::Crafted => tally.crafted += 1,
            FixtureKind::Generated => tally.generated += 1,
            FixtureKind::Corpus if corpus_slice(&id).exists() => tally.corpus += 1,
            FixtureKind::Corpus => {
                tally.corpus_missing += 1;
                continue;
            }
        }
        mismatches.extend(check_golden(&id, &golden, &corpus_ids));
    }
    tally.report();
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[derive(Default)]
struct Tally {
    crafted: usize,
    generated: usize,
    corpus: usize,
    corpus_missing: usize,
}

impl Tally {
    fn report(&self) {
        println!(
            "goldens: crafted={} generated={} corpus={}",
            self.crafted, self.generated, self.corpus
        );
        if self.corpus_missing == 0 {
            return;
        }
        assert!(
            std::env::var("CI").as_deref() != Ok("true"),
            "{} corpus slices not fetched on CI",
            self.corpus_missing
        );
        println!("corpus not fetched; run node core/scripts/fetch-gguf-corpus.mjs");
    }
}

enum FixtureKind {
    Crafted,
    Generated,
    Corpus,
}

fn fixture_kind(id: &str, golden: &Value, corpus_ids: &HashSet<String>) -> FixtureKind {
    if golden.get("generated").is_some() {
        FixtureKind::Generated
    } else if corpus_ids.contains(id) {
        FixtureKind::Corpus
    } else {
        FixtureKind::Crafted
    }
}

fn check_golden(id: &str, golden: &Value, corpus_ids: &HashSet<String>) -> Vec<String> {
    let max_read = golden["maxRead"].as_u64().unwrap_or(MAX_HEADER_READ);
    match fixture_kind(id, golden, corpus_ids) {
        FixtureKind::Crafted => check_file(id, golden, &crafted_path(id), max_read),
        FixtureKind::Corpus => check_file(id, golden, &corpus_slice(id), max_read),
        FixtureKind::Generated => check_generated(id, golden, max_read),
    }
}

fn check_file(id: &str, golden: &Value, path: &Path, max_read: u64) -> Vec<String> {
    let mut mismatches = compare_parse(id, golden, &parse_text(&parse_file(path, max_read)));
    mismatches.extend(compare_cut_short(id, golden, path));
    mismatches
}

/// Rebuilds the bytes from the recipe, proves them identical to the oracle's, then checks them in memory and,
/// for the cut-short verdicts, from a file.
fn check_generated(id: &str, golden: &Value, max_read: u64) -> Vec<String> {
    let generated = &golden["generated"];
    let args: Vec<u64> = generated["args"]
        .as_array()
        .expect("generated args")
        .iter()
        .map(|arg| arg.as_u64().expect("integer arg"))
        .collect();
    let bytes = generated_fixture(generated["recipe"].as_str().expect("recipe"), &args);
    assert_eq!(
        bytes.len() as u64,
        generated["size"].as_u64().unwrap(),
        "{id}: size"
    );
    assert_eq!(
        sha256_hex(&bytes),
        generated["sha256"].as_str().unwrap(),
        "{id}: sha256"
    );
    let mut mismatches = compare_parse(id, golden, &parse_text(&parse(bytes.as_slice(), max_read)));
    let path = staged_generated_file(id, &bytes);
    mismatches.extend(compare_cut_short(id, golden, &path));
    fs::remove_file(&path).expect("remove the staged generated fixture");
    mismatches
}

fn compare_parse(id: &str, golden: &Value, actual: &str) -> Vec<String> {
    let expected = golden["parse"]
        .as_str()
        .expect("parse is a JSON string (plan P-2)");
    if actual == expected {
        return Vec::new();
    }
    vec![format!(
        "{id}: parse\n  expected {expected}\n  actual   {actual}"
    )]
}

fn compare_cut_short(id: &str, golden: &Value, path: &Path) -> Vec<String> {
    let pairs = golden["cutShort"].as_array().expect("cutShort pairs");
    pairs
        .iter()
        .filter_map(|pair| {
            let size = pair[0].as_u64().expect("cutShort size");
            let expected = pair[1].as_bool().expect("cutShort verdict");
            let actual = is_cut_short(path, size);
            (actual != expected)
                .then(|| format!("{id}: cutShort at {size}: expected {expected}, actual {actual}"))
        })
        .collect()
}

fn goldens() -> Vec<(String, Value)> {
    let mut goldens: Vec<(String, Value)> = fs::read_dir(fixtures_dir().join("golden"))
        .expect("read the golden folder")
        .map(|entry| entry.expect("golden entry").path())
        .filter_map(|path| golden_id(&path).map(|id| (id, read_json(&path))))
        .collect();
    goldens.sort_by(|a, b| a.0.cmp(&b.0));
    goldens
}

/// The fixture id of a `golden/<id>.json`; `None` for the quant-name table and the raw TypeScript output of a
/// declared divergence (`<id>.ts.json`).
fn golden_id(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?;
    let id = file_name.strip_suffix(".json")?;
    (id != "quant-names" && !id.ends_with(".ts")).then(|| id.to_string())
}

fn corpus_ids() -> HashSet<String> {
    let corpus = read_json(&fixtures_dir().join("corpus.json"));
    corpus
        .as_array()
        .expect("corpus.json is an array")
        .iter()
        .map(|entry| entry["id"].as_str().expect("corpus id").to_string())
        .collect()
}

fn corpus_slice(id: &str) -> PathBuf {
    fixtures_dir()
        .join(".corpus-cache")
        .join(format!("{id}.gguf"))
}

fn staged_generated_file(id: &str, bytes: &[u8]) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{id}.gguf"));
    fs::write(&path, bytes).expect("stage the generated fixture");
    path
}

fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
