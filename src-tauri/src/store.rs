use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

/// The bank on disk: one JSON file in the app data directory.
///
/// The backend deliberately treats the contents as an opaque string. All the
/// logic — scheduling, essay analysis, dictionary lookups, merging — lives in
/// the shared JavaScript core so the desktop app and the web build cannot
/// drift apart. This file's only job is to hold bytes safely.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Store { path: dir.join("bank.json") }
    }

    pub fn load(&self) -> Result<Option<String>, String> {
        match fs::read_to_string(&self.path) {
            Ok(json) => Ok(Some(json)),
            Err(err) if err.kind() == ErrorKind::NotFound => {
                // A dangling symlink also reads as NotFound. It is not a first
                // run: treating it as empty would replace the existing path.
                match fs::symlink_metadata(&self.path) {
                    Err(meta_err) if meta_err.kind() == ErrorKind::NotFound => Ok(None),
                    _ => Err(format!("Could not read bank.json: {err}")),
                }
            }
            Err(err) => Err(format!("Could not read bank.json: {err}")),
        }
    }

    /// Writes via a temporary file and a rename, so an interrupted save (a
    /// crash, a pulled plug, an update relaunching underneath us) leaves the
    /// previous bank intact rather than a half-written one.
    pub fn save(&self, json: &str) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lexis-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_returns_none_before_anything_is_saved() {
        let store = Store::new(tmpdir("empty"));
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn saves_and_reads_back_verbatim() {
        let store = Store::new(tmpdir("roundtrip"));
        let json = r#"{"version":2,"words":[],"deleted":[]}"#;
        store.save(json).unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some(json));
    }

    #[test]
    fn unreadable_bank_is_an_error_instead_of_an_empty_first_run() {
        let store = Store::new(tmpdir("unreadable"));
        fs::write(store.path(), [0xff]).unwrap();
        assert!(store.load().unwrap_err().contains("Could not read bank.json"));
        assert_eq!(fs::read(store.path()).unwrap(), [0xff]);
    }

    #[test]
    fn save_leaves_no_temporary_file_behind() {
        let store = Store::new(tmpdir("tempfile"));
        store.save("{}").unwrap();
        assert!(!store.path().with_extension("json.tmp").exists());
    }
}
