//! The device key: a random 256-bit secret that seals AI settings at rest.
//!
//! The web build derives its storage key from the user's password, but the
//! desktop deliberately has no password — the app works fully without sync.
//! Rather than leave a pasted API key in plaintext JSON beside the bank, the
//! Rust side mints one AES-256 key per device and keeps it in its own file.
//!
//! Threat model, honestly stated: this protects the key from other accounts
//! on the machine, from backup archives, and from anything that copies files
//! without running as this user. It cannot protect against malware already
//! running as this user — nothing stored on their behalf can. The file is
//! therefore created with owner-only permissions (0600) as defence in depth,
//! matching what OS keychains do for credentials of exactly this kind.

use rand::RngCore;
use std::fs;
use std::path::{Path, PathBuf};

pub struct DeviceKey {
    path: PathBuf,
    bytes: Option<[u8; 32]>,
}

impl DeviceKey {
    pub fn new(dir: PathBuf) -> Self {
        DeviceKey {
            path: dir.join("device.key"),
            bytes: None,
        }
    }

    /// The raw key material, loaded or created on first use.
    ///
    /// Creation is atomic via temp-file-plus-rename (the same pattern
    /// `store.rs` uses for the bank), so an interrupted first run leaves
    /// either no file or a whole one — never a truncated key that would
    /// silently decrypt to garbage forever after.
    ///
    /// A file of the wrong length can therefore only be one somebody else
    /// clobbered, and whatever it once sealed is unreadable either way. So it
    /// is replaced rather than reported: an error here would wedge AI settings
    /// permanently, since re-entering them is itself what calls this.
    pub fn get(&mut self) -> Result<[u8; 32], String> {
        if let Some(bytes) = self.bytes {
            return Ok(bytes);
        }
        let bytes = match fs::read(&self.path) {
            Ok(data) => match <[u8; 32]>::try_from(data) {
                Ok(arr) => arr,
                Err(_) => self.create()?,
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => self.create()?,
            Err(err) => return Err(err.to_string()),
        };
        self.bytes = Some(bytes);
        Ok(bytes)
    }

    fn create(&self) -> Result<[u8; 32], String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        write_private(&self.path, &bytes)?;
        Ok(bytes)
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Writes bytes to `path` with owner-only permissions, atomically.
///
/// Unix gets a genuine 0600. Windows has no per-file read restriction in its
/// default ACLs, so the plain write there is honest about doing nothing
/// rather than pretending.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let tmp = path.with_extension("key.tmp");
        // A leftover temp file from an interrupted run would make
        // create_new fail forever, so clear the way first.
        let _ = fs::remove_file(&tmp);
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(|e| e.to_string())?;
            f.write_all(bytes).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    #[cfg(not(unix))]
    {
        let tmp = path.with_extension("key.tmp");
        fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lexis-device-key-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_a_key_once_and_reloads_the_same_bytes() {
        let dir = tmpdir("roundtrip");
        let path = dir.join("device.key");

        let mut first = DeviceKey::new(dir.clone());
        let a = first.get().unwrap();
        assert_eq!(a.len(), 32);
        assert!(path.exists());

        let mut second = DeviceKey::new(dir);
        let b = second.get().unwrap();
        assert_eq!(a, b, "a second handle must read the same key");
    }

    #[test]
    fn two_devices_get_different_keys() {
        let dir_a = tmpdir("distinct-a");
        let dir_b = tmpdir("distinct-b");
        let mut a = DeviceKey::new(dir_a);
        let mut b = DeviceKey::new(dir_b);
        assert_ne!(a.get().unwrap(), b.get().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir("perms");
        let mut key = DeviceKey::new(dir);
        key.get().unwrap();
        let mode = fs::metadata(key.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "no group or world access");
    }

    #[test]
    fn a_wrong_length_key_file_is_replaced_rather_than_reported() {
        let dir = tmpdir("corrupt");
        let mut key = DeviceKey::new(dir);
        fs::write(key.path(), b"too short").unwrap();
        let bytes = key.get().expect("a clobbered key file must not wedge the feature");
        assert_eq!(bytes.len(), 32);
        assert_eq!(
            fs::read(key.path()).unwrap().len(),
            32,
            "the replacement was written back"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_temp_file_does_not_wedge_creation_forever() {
        let dir = tmpdir("stale-tmp");
        let mut key = DeviceKey::new(dir);
        std::fs::write(key.path.with_extension("key.tmp"), b"junk").unwrap();
        assert!(key.get().is_ok(), "creation recovers from leftover tmp");
    }
}
