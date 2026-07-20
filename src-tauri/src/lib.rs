mod store;

use serde::Serialize;
use std::sync::Mutex;
use store::Store;
use tauri::{Emitter, Manager};

/// Reads the bank file, or `None` on a first run.
#[tauri::command]
fn load_bank(state: tauri::State<'_, Mutex<Store>>) -> Result<Option<String>, String> {
    let store = state.lock().map_err(|e| e.to_string())?;
    Ok(store.load())
}

#[tauri::command]
fn save_bank(state: tauri::State<'_, Mutex<Store>>, json: String) -> Result<(), String> {
    let store = state.lock().map_err(|e| e.to_string())?;
    store.save(&json)
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
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let dir = app.path().app_data_dir()?;
            app.manage(Mutex::new(Store::new(dir)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_bank,
            save_bank,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
