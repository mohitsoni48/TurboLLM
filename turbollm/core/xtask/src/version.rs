use toml_edit::{DocumentMut, Value};

pub fn version_drift(cargo_toml: &str, package_json: &str) -> Result<Option<String>, String> {
    let cargo_version = workspace_version(cargo_toml)?;
    let package_version = package_version(package_json)?;
    if cargo_version == package_version {
        return Ok(None);
    }
    Ok(Some(format!(
        "core/Cargo.toml version {cargo_version} != turbollm/package.json version {package_version}; \
         run cargo xtask sync-version"
    )))
}

pub fn package_version(package_json: &str) -> Result<String, String> {
    let package: serde_json::Value =
        serde_json::from_str(package_json).map_err(|e| format!("package.json: {e}"))?;
    package["version"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "package.json has no string \"version\"".to_owned())
}

pub fn workspace_version(cargo_toml: &str) -> Result<String, String> {
    let manifest = parse_manifest(cargo_toml)?;
    manifest["workspace"]["package"]["version"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(missing_workspace_version)
}

pub fn with_workspace_version(cargo_toml: &str, version: &str) -> Result<String, String> {
    let mut manifest = parse_manifest(cargo_toml)?;
    let current = manifest["workspace"]["package"]["version"]
        .as_value_mut()
        .filter(|value| value.is_str())
        .ok_or_else(missing_workspace_version)?;
    let mut replacement = Value::from(version);
    *replacement.decor_mut() = current.decor().clone();
    *current = replacement;
    Ok(manifest.to_string())
}

fn parse_manifest(cargo_toml: &str) -> Result<DocumentMut, String> {
    cargo_toml.parse().map_err(|e| format!("Cargo.toml: {e}"))
}

fn missing_workspace_version() -> String {
    "Cargo.toml has no string [workspace.package] version".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE_JSON: &str = r#"{ "name": "turbollm", "version": "1.16.0", "private": false }"#;

    const CARGO_TOML: &str = r#"# workspace root
[workspace]
resolver = "3"
members = ["crates/*", "xtask"]

[workspace.package]
version = "1.15.1"   # kept in sync by xtask
edition = "2024"

[profile.release]
lto = "thin"
"#;

    #[test]
    fn reads_the_version_from_package_json() {
        assert_eq!(package_version(PACKAGE_JSON).unwrap(), "1.16.0");
    }

    #[test]
    fn package_json_without_a_version_is_an_error() {
        assert!(package_version(r#"{ "name": "turbollm" }"#).is_err());
    }

    #[test]
    fn reads_the_workspace_version_from_cargo_toml() {
        assert_eq!(workspace_version(CARGO_TOML).unwrap(), "1.15.1");
    }

    #[test]
    fn rewrites_only_the_workspace_version() {
        let expected = CARGO_TOML.replace("version = \"1.15.1\"", "version = \"1.16.0\"");
        assert_eq!(
            with_workspace_version(CARGO_TOML, "1.16.0").unwrap(),
            expected
        );
    }

    #[test]
    fn rewriting_to_the_same_version_changes_nothing() {
        assert_eq!(
            with_workspace_version(CARGO_TOML, "1.15.1").unwrap(),
            CARGO_TOML
        );
    }

    #[test]
    fn cargo_toml_without_a_workspace_version_is_an_error() {
        assert!(with_workspace_version("[workspace]\n", "1.16.0").is_err());
    }

    #[test]
    fn drift_message_text_is_exact() {
        assert_eq!(
            version_drift(CARGO_TOML, PACKAGE_JSON).unwrap().unwrap(),
            "core/Cargo.toml version 1.15.1 != turbollm/package.json version 1.16.0; \
             run cargo xtask sync-version"
        );
    }

    #[test]
    fn matching_versions_have_no_drift() {
        let synced = with_workspace_version(CARGO_TOML, "1.16.0").unwrap();
        assert_eq!(version_drift(&synced, PACKAGE_JSON).unwrap(), None);
    }
}
