mod device_key;
mod mirror;
mod store;

use device_key::DeviceKey;
use serde::Serialize;
use std::sync::Mutex;
use store::Store;
use tauri::{Emitter, Manager};

/// Reads the bank file, or `None` on a first run.
#[tauri::command]
fn load_bank(state: tauri::State<'_, Mutex<Store>>) -> Result<Option<String>, String> {
    let store = state.lock().map_err(|e| e.to_string())?;
    store.load()
}

#[tauri::command]
fn save_bank(state: tauri::State<'_, Mutex<Store>>, json: String) -> Result<(), String> {
    let store = state.lock().map_err(|e| e.to_string())?;
    store.save(&json)
}

/// Only the path selected in the native save dialog receives the PDF bytes.
#[tauri::command]
async fn save_pdf(app: tauri::AppHandle, bytes: Vec<u8>, filename: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if !bytes.starts_with(b"%PDF-") {
        return Err("The export is not a PDF file.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Export word bank")
            .set_file_name(&filename)
            .add_filter("PDF document", &["pdf"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| format!("Could not save the PDF: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ---- the device key ----
 *
 * One command: hand the webview the raw key material it needs to seal AI
 * settings (see `device_key.rs` for the threat model). The key is generated
 * on first use and never leaves this process except over the IPC bridge —
 * it is not written to logs, exports, or backups.
 */

#[tauri::command]
fn ai_device_key(state: tauri::State<'_, Mutex<DeviceKey>>) -> Result<Vec<u8>, String> {
    let bytes = state.lock().map_err(|e| e.to_string())?.get()?;
    Ok(bytes.to_vec())
}

/* ---- the Syncthing mirror ----
 *
 * Five thin commands over one directory the user nominates. The bytes are
 * already encrypted by the time they arrive here; see `mirror.rs` and the
 * shared core's `mirror.js`.
 */

#[tauri::command]
fn mirror_check(root: String) -> Result<mirror::MirrorInfo, String> {
    mirror::check(&root)
}

#[tauri::command]
fn mirror_list(root: String) -> Result<Vec<mirror::MirrorEntry>, String> {
    mirror::list(&root)
}

#[tauri::command]
fn mirror_read(root: String, name: String) -> Result<Option<String>, String> {
    mirror::read(&root, &name)
}

#[tauri::command]
fn mirror_write(root: String, name: String, contents: String) -> Result<(), String> {
    mirror::write(&root, &name, &contents)
}

#[tauri::command]
fn mirror_remove(root: String, name: String) -> Result<(), String> {
    mirror::remove(&root, &name)
}

#[derive(Serialize, Clone)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            notes: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Downloads and installs the pending update, emitting `update-progress`
/// (0–100) along the way, then relaunches the app.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("you're already on the latest version")?;

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let pct = total
                    .map(|t| (downloaded as f64 / t as f64 * 100.0).min(100.0) as u32)
                    .unwrap_or(0);
                let _ = progress_app.emit("update-progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let dir = app.path().app_data_dir()?;
            app.manage(Mutex::new(Store::new(dir.clone())));
            app.manage(Mutex::new(DeviceKey::new(dir)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_bank,
            save_bank,
            save_pdf,
            ai_device_key,
            check_update,
            install_update,
            mirror_check,
            mirror_list,
            mirror_read,
            mirror_write,
            mirror_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
