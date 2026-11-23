//! The crash journal: a record on disk naming the model a native load is opening, so a load that took
//! the process down is recognised at the next start and not retried blindly (ADR-455 plan R-6). The
//! file and its JSON are the ones the Kotlin SDK's `LoadSentinel` writes, so a record left by the SDK
//! before an update is read after it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const JOURNAL_FOLDER: &str = ".turbollm-sdk";
const JOURNAL_FILE: &str = "loading.json";

/// One core's view of the journal file. Each record names its owner, so a core clears only the
/// record it wrote, never one a later core in the same process has written since.
#[derive(Debug, Clone)]
pub struct LoadJournal {
    path: PathBuf,
    owner: String,
}

/// The JSON the Kotlin SDK writes; records from before owners existed have none.
#[derive(Serialize, Deserialize)]
struct LoadingRecord {
    path: String,
    #[serde(default)]
    owner: String,
}

impl LoadJournal {
    pub fn new(path: PathBuf, owner: impl Into<String>) -> LoadJournal {
        LoadJournal {
            path,
            owner: owner.into(),
        }
    }

    /// `<modelRoot>/.turbollm-sdk/loading.json`, where the SDK has always kept the journal.
    pub fn path_in(model_root: &Path) -> PathBuf {
        model_root.join(JOURNAL_FOLDER).join(JOURNAL_FILE)
    }

    /// Best effort: true once the record is on disk. A journal that cannot be written never stops
    /// the load; a crash during that load just goes unrecorded.
    pub fn write(&self, model_path: &Path) -> bool {
        self.try_write(model_path).is_ok()
    }

    /// Removes the record, but only one this journal's owner wrote.
    pub fn clear(&self) {
        let written_by_us =
            read_record(&self.path).is_some_and(|record| record.owner == self.owner);
        if written_by_us {
            let _ = fs::remove_file(&self.path);
        }
    }

    /// The model a crashed load was opening, once: the file is deleted whether or not it was readable.
    pub fn consume_stale(path: &Path) -> Option<String> {
        if !path.exists() {
            return None;
        }
        let stale_model = read_record(path).map(|record| record.path);
        let _ = fs::remove_file(path);
        stale_model
    }

    fn try_write(&self, model_path: &Path) -> io::Result<()> {
        if let Some(folder) = self.path.parent() {
            fs::create_dir_all(folder)?;
        }
        let record = LoadingRecord {
            path: std::path::absolute(model_path)?
                .to_string_lossy()
                .into_owned(),
            owner: self.owner.clone(),
        };
        fs::write(&self.path, serde_json::to_string(&record)?)
    }
}

fn read_record(path: &Path) -> Option<LoadingRecord> {
    let json = fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct ModelRoot {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    impl ModelRoot {
        fn new() -> ModelRoot {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("models");
            fs::create_dir_all(&root).unwrap();
            ModelRoot { _dir: dir, root }
        }

        fn journal(&self, owner: &str) -> LoadJournal {
            LoadJournal::new(self.journal_file(), owner)
        }

        fn journal_file(&self) -> PathBuf {
            LoadJournal::path_in(&self.root)
        }

        fn model(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn write_record_as_the_kotlin_sdk(&self, json: &str) {
            fs::create_dir_all(self.root.join(".turbollm-sdk")).unwrap();
            fs::write(self.journal_file(), json).unwrap();
        }
    }

    fn absolute(path: &Path) -> String {
        std::path::absolute(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn the_journal_lives_where_the_sdk_has_always_kept_it() {
        let root = Path::new("models");
        assert_eq!(
            LoadJournal::path_in(root),
            root.join(".turbollm-sdk").join("loading.json")
        );
    }

    #[test]
    fn a_written_journal_names_the_models_absolute_path() {
        let root = ModelRoot::new();
        let model = root.model("org/repo/m.gguf");

        root.journal("core-a").write(&model);

        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.journal_file()).unwrap()).unwrap();
        let expected = serde_json::json!({ "path": absolute(&model), "owner": "core-a" });
        assert_eq!(written, expected);
    }

    #[test]
    fn a_written_record_has_the_bytes_the_kotlin_sdk_writes() {
        let root = ModelRoot::new();
        let model = root.model("m.gguf");

        root.journal("core-a").write(&model);

        let kotlin_bytes = serde_json::json!({ "path": absolute(&model), "owner": "core-a" });
        assert_eq!(
            fs::read_to_string(root.journal_file()).unwrap(),
            format!("{{\"path\":{},\"owner\":\"core-a\"}}", kotlin_bytes["path"])
        );
    }

    #[test]
    fn a_journal_that_cannot_be_written_is_reported_as_not_written() {
        let root = ModelRoot::new();
        fs::write(
            root.root.join(".turbollm-sdk"),
            "a file where the journal folder belongs",
        )
        .unwrap();

        assert!(!root.journal("core-a").write(&root.model("m.gguf")));
    }

    #[test]
    fn a_written_journal_is_reported_as_written() {
        let root = ModelRoot::new();
        assert!(root.journal("core-a").write(&root.model("m.gguf")));
    }

    #[test]
    fn clearing_removes_the_journal() {
        let root = ModelRoot::new();
        let journal = root.journal("core-a");
        journal.write(&root.model("m.gguf"));

        journal.clear();

        assert!(!root.journal_file().exists());
    }

    #[test]
    fn a_core_never_clears_the_journal_another_core_wrote() {
        let root = ModelRoot::new();
        let earlier = root.journal("core-a");
        let later = root.journal("core-b");
        let later_model = root.model("y.gguf");
        earlier.write(&root.model("x.gguf"));
        later.write(&later_model);

        earlier.clear();

        assert_eq!(
            LoadJournal::consume_stale(&root.journal_file()),
            Some(absolute(&later_model))
        );
    }

    #[test]
    fn a_journal_left_by_a_crashed_load_is_returned_once_then_none() {
        let root = ModelRoot::new();
        let model = root.model("m.gguf");
        root.journal("core-a").write(&model);

        let after_restart = root.journal_file();

        assert_eq!(
            LoadJournal::consume_stale(&after_restart),
            Some(absolute(&model))
        );
        assert_eq!(LoadJournal::consume_stale(&after_restart), None);
        assert!(!root.journal_file().exists());
    }

    #[test]
    fn without_a_leftover_journal_there_is_nothing_stale() {
        let root = ModelRoot::new();
        assert_eq!(LoadJournal::consume_stale(&root.journal_file()), None);
    }

    #[test]
    fn an_unreadable_leftover_is_discarded_as_nothing_stale() {
        let root = ModelRoot::new();
        root.write_record_as_the_kotlin_sdk("{not json");

        assert_eq!(LoadJournal::consume_stale(&root.journal_file()), None);
        assert!(!root.journal_file().exists());
    }

    #[test]
    fn a_record_the_kotlin_sdk_wrote_is_consumed_after_the_update() {
        let root = ModelRoot::new();
        root.write_record_as_the_kotlin_sdk(
            r#"{"path":"/data/user/0/app/files/models/org/repo/m.gguf","owner":"3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b"}"#,
        );

        assert_eq!(
            LoadJournal::consume_stale(&root.journal_file()),
            Some("/data/user/0/app/files/models/org/repo/m.gguf".to_string())
        );
        assert!(!root.journal_file().exists());
    }

    #[test]
    fn a_record_from_before_owners_existed_is_consumed() {
        let root = ModelRoot::new();
        root.write_record_as_the_kotlin_sdk(r#"{"path":"/models/old.gguf"}"#);

        assert_eq!(
            LoadJournal::consume_stale(&root.journal_file()),
            Some("/models/old.gguf".to_string())
        );
        assert_eq!(LoadJournal::consume_stale(&root.journal_file()), None);
    }

    #[test]
    fn a_record_from_before_owners_existed_is_not_cleared_by_an_owner() {
        let root = ModelRoot::new();
        root.write_record_as_the_kotlin_sdk(r#"{"path":"/models/old.gguf"}"#);

        root.journal("core-a").clear();

        assert!(root.journal_file().exists());
    }

    #[test]
    fn clearing_another_owners_record_leaves_it_untouched() {
        let root = ModelRoot::new();
        root.journal("core-b").write(&root.model("y.gguf"));
        let before = fs::read(root.journal_file()).unwrap();

        root.journal("core-a").clear();

        assert_eq!(fs::read(root.journal_file()).unwrap(), before);
    }

    #[test]
    fn clearing_with_no_record_does_nothing() {
        let root = ModelRoot::new();
        root.journal("core-a").clear();
        assert!(!root.journal_file().exists());
    }
}
