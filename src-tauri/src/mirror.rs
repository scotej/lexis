//! The Syncthing mirror, from the filesystem's side.
//!
//! Everything about *what* goes in the folder — the envelope, the encryption,
//! which peer wins a merge — lives in the shared JavaScript core, exactly like
//! the bank itself. This module is the part that cannot: a browser has no
//! filesystem, so the desktop build lends one, and nothing more. It reads,
//! writes, lists, and deletes inside one directory, and it treats every byte
//! as opaque.
//!
//! Two details are load-bearing rather than incidental:
//!
//! * **The temporary file is named the way Syncthing names its own.**
//!   Syncthing always ignores `.syncthing.<name>.tmp`, so writing through one
//!   means a half-written envelope is never scanned, never transferred, and
//!   never seen by the other machine as a corrupt bank.
//! * **Filenames from the frontend are validated, not trusted.** The frontend
//!   is our own bundled code, but the directory is a real one the user picked,
//!   and a path separator or a `..` reaching this far would let a bug write
//!   outside it. One character class, enforced here, removes the question.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// lexis keeps to its own subdirectory so the folder can hold anything else.
const SUBDIR: &str = "lexis";

const README: &str = "\
This folder holds lexis's local backup.

Each device writes exactly one file, bank.<device>.lexis.json, and reads the
others. One writer per file is why Syncthing has nothing to conflict over.

The contents are encrypted with the same password you use for lexis sync
(PBKDF2-SHA256, then AES-256-GCM). Nothing here is readable without it, and
nothing here is readable by Syncthing, by another person on this folder, or by
anyone who copies it. There is no password recovery: without it these files
cannot be decrypted by anything, including lexis.

Files may be deleted freely; lexis rewrites its own on the next sync. Deleting
another device's file only removes this machine's copy of that backup.
";

#[derive(Serialize)]
pub struct MirrorInfo {
    /// The resolved directory lexis writes into (`<folder>/lexis`).
    pub path: String,
    /// The folder the user chose, with `~` expanded.
    pub root: String,
    /// Whether a `.stfolder` marker was found at or above the chosen folder.
    /// Informational: a folder Syncthing doesn't watch still works as a backup,
    /// it just won't reach the other machine.
    pub syncthing: bool,
}

#[derive(Serialize)]
pub struct MirrorEntry {
    pub name: String,
    pub size: u64,
    /// Modification time in epoch milliseconds, or 0 when the platform
    /// won't say. Used only to notice that *something* changed.
    pub modified: u64,
}

/// Expands a leading `~`, so a typed path behaves the way a shell would.
fn expand_home(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            let rest = trimmed.trim_start_matches('~').trim_start_matches(['/', '\\']);
            return Path::new(&home).join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// A filename this module is willing to touch. Deliberately strict: our own
/// names are `bank.<hex>.lexis.json` and Syncthing's conflict variants of it,
/// so nothing legitimate needs a separator, a `..`, or a leading dot.
fn safe_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.len() > 200 {
        return Err("bad mirror filename".into());
    }
    if name.starts_with('.') || name.contains("..") {
        return Err("bad mirror filename".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err("bad mirror filename".into());
    }
    Ok(name)
}

/// Is this folder — or one containing it — a Syncthing folder? Syncthing drops
/// a `.stfolder` marker at each folder root, so this is the honest test.
fn under_syncthing(root: &Path) -> bool {
    let mut cursor = Some(root);
    while let Some(dir) = cursor {
        if dir.join(".stfolder").exists() {
            return true;
        }
        cursor = dir.parent();
    }
    false
}

fn mirror_dir(root: &str) -> PathBuf {
    expand_home(root).join(SUBDIR)
}

/// Validates the chosen folder and prepares lexis's subdirectory in it.
pub fn check(root: &str) -> Result<MirrorInfo, String> {
    let base = expand_home(root);
    if base.as_os_str().is_empty() {
        return Err("Choose a folder first.".into());
    }
    if !base.exists() {
        return Err(format!("{} doesn't exist.", base.display()));
    }
    if !base.is_dir() {
        return Err(format!("{} isn't a folder.", base.display()));
    }

    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;

    // Prove writability now rather than at the first sync, when the failure
    // would surface as a mysterious status line.
    let probe = dir.join(".syncthing.lexis-write-test.tmp");
    fs::write(&probe, b"lexis").map_err(|e| format!("{} isn't writable: {e}", dir.display()))?;
    let _ = fs::remove_file(&probe);

    let readme = dir.join("README.txt");
    if !readme.exists() {
        let _ = fs::write(&readme, README);
    }

    Ok(MirrorInfo {
        path: dir.to_string_lossy().into_owned(),
        root: base.to_string_lossy().into_owned(),
        syncthing: under_syncthing(&base),
    })
}

pub fn list(root: &str) -> Result<Vec<MirrorEntry>, String> {
    let dir = mirror_dir(root);
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        // A folder that isn't there yet is empty, not broken — the drive may
        // simply not be mounted, and the next pass will find it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Couldn't read {}: {e}", dir.display())),
    };

    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if safe_name(&name).is_err() {
            continue; // README.txt is fine; dotfiles and temporaries are skipped
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(MirrorEntry { name, size: meta.len(), modified });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn read(root: &str, name: &str) -> Result<Option<String>, String> {
    let name = safe_name(name)?;
    match fs::read_to_string(mirror_dir(root).join(name)) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes through a temporary and a rename, so the other machine only ever
/// sees a whole file. The temporary uses Syncthing's own naming, which
/// Syncthing unconditionally ignores.
pub fn write(root: &str, name: &str, contents: &str) -> Result<(), String> {
    let name = safe_name(name)?;
    // The chosen folder must already exist. Without this, `create_dir_all`
    // below would happily invent the whole path on an unmounted drive — and
    // the backup would sit in a directory Syncthing has never heard of while
    // looking, from here, exactly like a success.
    let base = expand_home(root);
    if !base.is_dir() {
        return Err(format!("{} isn't available.", base.display()));
    }
    let dir = base.join(SUBDIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".syncthing.{name}.tmp"));
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(name)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn remove(root: &str, name: &str) -> Result<(), String> {
    let name = safe_name(name)?;
    match fs::remove_file(mirror_dir(root).join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lexis-mirror-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn root_of(dir: &Path) -> String {
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn check_creates_the_subfolder_and_a_readme() {
        let dir = tmpdir("check");
        let info = check(&root_of(&dir)).unwrap();
        assert!(dir.join("lexis").is_dir());
        assert!(dir.join("lexis/README.txt").exists());
        assert_eq!(info.path, dir.join("lexis").to_string_lossy());
        assert!(!info.syncthing);
    }

    #[test]
    fn check_notices_a_syncthing_folder_above_the_chosen_one() {
        let dir = tmpdir("stfolder");
        fs::create_dir_all(dir.join(".stfolder")).unwrap();
        let nested = dir.join("inner");
        fs::create_dir_all(&nested).unwrap();
        assert!(check(&root_of(&nested)).unwrap().syncthing);
    }

    #[test]
    fn check_refuses_a_folder_that_isnt_there() {
        let missing = std::env::temp_dir().join("lexis-mirror-test-absent-xyz");
        let _ = fs::remove_dir_all(&missing);
        assert!(check(&root_of(&missing)).is_err());
    }

    #[test]
    fn writes_reads_lists_and_removes() {
        let dir = tmpdir("roundtrip");
        let root = root_of(&dir);
        check(&root).unwrap();

        write(&root, "bank.abc123.lexis.json", "{\"lexis\":2}").unwrap();
        assert_eq!(
            read(&root, "bank.abc123.lexis.json").unwrap().unwrap(),
            "{\"lexis\":2}"
        );

        let names: Vec<String> = list(&root).unwrap().into_iter().map(|e| e.name).collect();
        assert!(names.contains(&"bank.abc123.lexis.json".to_string()));

        remove(&root, "bank.abc123.lexis.json").unwrap();
        assert!(read(&root, "bank.abc123.lexis.json").unwrap().is_none());
        // Removing what is already gone is success, not an error.
        remove(&root, "bank.abc123.lexis.json").unwrap();
    }

    #[test]
    fn writing_into_a_folder_that_isnt_there_fails_rather_than_inventing_it() {
        let missing = std::env::temp_dir().join("lexis-mirror-test-unmounted/deeper");
        let _ = fs::remove_dir_all(std::env::temp_dir().join("lexis-mirror-test-unmounted"));
        assert!(write(&root_of(&missing), "bank.aa.lexis.json", "{}").is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn write_leaves_no_temporary_behind() {
        let dir = tmpdir("tempfile");
        let root = root_of(&dir);
        write(&root, "bank.ff00.lexis.json", "{}").unwrap();
        assert!(!dir.join("lexis/.syncthing.bank.ff00.lexis.json.tmp").exists());
    }

    #[test]
    fn listing_skips_dotfiles_and_temporaries() {
        let dir = tmpdir("skip");
        let root = root_of(&dir);
        check(&root).unwrap();
        fs::write(dir.join("lexis/.syncthing.bank.aa.lexis.json.tmp"), "x").unwrap();
        fs::write(dir.join("lexis/.DS_Store"), "x").unwrap();
        let names: Vec<String> = list(&root).unwrap().into_iter().map(|e| e.name).collect();
        assert!(names.iter().all(|n| !n.starts_with('.')));
    }

    #[test]
    fn listing_a_folder_that_vanished_is_empty_not_fatal() {
        let dir = tmpdir("gone");
        let root = root_of(&dir);
        check(&root).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert!(list(&root).unwrap().is_empty());
    }

    #[test]
    fn names_that_could_escape_the_folder_are_refused() {
        for bad in [
            "../outside.json",
            "sub/bank.json",
            "sub\\bank.json",
            "..",
            ".hidden",
            "bank.$(whoami).json",
            "",
        ] {
            assert!(safe_name(bad).is_err(), "{bad} should be refused");
        }
        assert!(safe_name("bank.a1b2c3.lexis.json").is_ok());
        assert!(safe_name("bank.a1b2c3.lexis.sync-conflict-20260819-101112-ABCDEF.json").is_ok());
    }

    #[test]
    fn a_leading_tilde_resolves_against_home() {
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
        if let Ok(home) = home {
            assert_eq!(expand_home("~/Documents"), Path::new(&home).join("Documents"));
            assert_eq!(expand_home("~"), Path::new(&home));
        }
        assert_eq!(expand_home("/tmp/x"), Path::new("/tmp/x"));
    }
}
