use std::path::PathBuf;

use turbollm_gguf::quant_from_name;

#[test]
fn every_golden_file_name_gets_the_typescript_quant() {
    let golden = load_quant_name_golden();
    let mismatches: Vec<String> = golden
        .iter()
        .filter_map(|(file_name, expected)| describe_mismatch(file_name, expected.as_deref()))
        .collect();

    println!("quant-names golden: {} rows", golden.len());
    assert!(!golden.is_empty(), "quant-names.json has no rows");
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

fn describe_mismatch(file_name: &str, expected: Option<&str>) -> Option<String> {
    let actual = quant_from_name(file_name);
    (actual.as_deref() != expected)
        .then(|| format!("{file_name:?}: expected {expected:?}, got {actual:?}"))
}

fn load_quant_name_golden() -> Vec<(String, Option<String>)> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/gguf/golden/quant-names.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}
