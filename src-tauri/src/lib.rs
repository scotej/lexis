mod bank;
mod dict;
mod essay;
mod srs;

use bank::{Bank, Store, TodayList, Word};
use chrono::{Local, NaiveDate};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const TODAY_TARGET: usize = 10;

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn normalize(word: &str) -> Result<String, String> {
    let w = word.trim().to_lowercase();
    if w.is_empty() {
        return Err("type a word first".into());
    }
    if !w.chars().all(|c| c.is_alphabetic() || c == '-' || c == '\'') || w.chars().count() > 40 {
        return Err("that doesn't look like a single word".into());
    }
    Ok(w)
}

#[derive(Serialize)]
struct TodayItem {
    word: String,
    pos: String,
    def: String,
    ticked: bool,
}

#[derive(Serialize)]
struct TodayView {
    date: NaiveDate,
    items: Vec<TodayItem>,
    remaining: usize,
}

fn ensure_today_list(bank: &mut Bank, date: NaiveDate) {
    let fresh = match &bank.today {
        Some(t) => t.date != date,
        None => true,
    };
    if fresh {
        // Due words first (most overdue at the top), then the words whose
        // review comes up soonest, until we have about ten.
        let mut candidates: Vec<(&NaiveDate, &String)> =
            bank.words.iter().map(|w| (&w.srs.due, &w.word)).collect();
        candidates.sort();
        let words: Vec<String> = candidates
            .into_iter()
            .take(TODAY_TARGET)
            .map(|(_, w)| w.clone())
            .collect();
        bank.today = Some(TodayList { date, words, ticked: Vec::new() });
    } else if let Some(t) = &mut bank.today {
        // Drop anything deleted from the bank since the list was made.
        let existing: Vec<String> = t
            .words
            .iter()
            .filter(|w| bank.words.iter().any(|b| &&b.word == w))
            .cloned()
            .collect();
        t.words = existing;
        let words = t.words.clone();
        t.ticked.retain(|w| words.contains(w));
    }
}

fn today_view(bank: &Bank) -> TodayView {
    let empty = Vec::new();
    let (date, words, ticked) = match &bank.today {
        Some(t) => (t.date, &t.words, &t.ticked),
        None => (today(), &empty, &empty),
    };
    let items: Vec<TodayItem> = words
        .iter()
        .filter_map(|w| bank.find(w))
        .map(|w| TodayItem {
            word: w.word.clone(),
            pos: w.senses.first().map(|s| s.pos.clone()).unwrap_or_default(),
            def: w.senses.first().map(|s| s.def.clone()).unwrap_or_default(),
            ticked: ticked.contains(&w.word),
        })
        .collect();
    let remaining = items.iter().filter(|i| !i.ticked).count();
    TodayView { date, items, remaining }
}

#[tauri::command]
async fn add_word(state: tauri::State<'_, Mutex<Store>>, word: String) -> Result<Word, String> {
    let w = normalize(&word)?;
    {
        let store = state.lock().unwrap();
        if store.bank.find(&w).is_some() {
            return Err(format!("\u{201c}{}\u{201d} is already in your bank", w));
        }
    }

    let dict = dict::fetch_definition(&w).await?;
    let synonyms = dict::fetch_synonyms(&w).await;

    let now = today();
    let entry = Word {
        word: w.clone(),
        phonetic: dict.phonetic,
        senses: dict.senses,
        synonyms,
        source: dict.source,
        source_url: dict.source_url,
        added: now,
        srs: bank::Srs::new(now),
        times_used: 0,
    };

    let mut store = state.lock().unwrap();
    store.bank.words.insert(0, entry.clone());
    // A brand-new word can join today's checklist if there's room.
    if let Some(t) = &mut store.bank.today {
        if t.date == now && t.words.len() < TODAY_TARGET {
            t.words.push(w);
        }
    }
    store.save()?;
    Ok(entry)
}

#[tauri::command]
fn list_words(state: tauri::State<'_, Mutex<Store>>) -> Result<Vec<Word>, String> {
    let store = state.lock().unwrap();
    let mut words = store.bank.words.clone();
    words.sort_by(|a, b| b.added.cmp(&a.added).then(a.word.cmp(&b.word)));
    Ok(words)
}

#[tauri::command]
fn delete_word(state: tauri::State<'_, Mutex<Store>>, word: String) -> Result<(), String> {
    let mut store = state.lock().unwrap();
    store.bank.words.retain(|w| w.word != word);
    if let Some(t) = &mut store.bank.today {
        t.words.retain(|w| w != &word);
        t.ticked.retain(|w| w != &word);
    }
    store.save()
}

#[tauri::command]
fn today_list(state: tauri::State<'_, Mutex<Store>>) -> Result<TodayView, String> {
    let mut store = state.lock().unwrap();
    ensure_today_list(&mut store.bank, today());
    store.save()?;
    Ok(today_view(&store.bank))
}

#[tauri::command]
fn tick_word(
    state: tauri::State<'_, Mutex<Store>>,
    word: String,
    ticked: bool,
) -> Result<TodayView, String> {
    let now = today();
    let mut store = state.lock().unwrap();
    ensure_today_list(&mut store.bank, now);
    let already = store
        .bank
        .today
        .as_ref()
        .map(|t| t.ticked.contains(&word))
        .unwrap_or(false);
    if ticked && !already {
        if let Some(w) = store.bank.find_mut(&word) {
            srs::apply(&mut w.srs, srs::Grade::Good, now);
            w.times_used += 1;
        }
        if let Some(t) = &mut store.bank.today {
            t.ticked.push(word);
        }
    } else if !ticked && already {
        if let Some(t) = &mut store.bank.today {
            t.ticked.retain(|w| w != &word);
        }
    }
    store.save()?;
    Ok(today_view(&store.bank))
}

#[tauri::command]
fn due_words(state: tauri::State<'_, Mutex<Store>>) -> Result<Vec<Word>, String> {
    let now = today();
    let store = state.lock().unwrap();
    let mut due: Vec<Word> = store
        .bank
        .words
        .iter()
        .filter(|w| w.srs.due <= now)
        .cloned()
        .collect();
    due.sort_by(|a, b| a.srs.due.cmp(&b.srs.due));
    Ok(due)
}

#[tauri::command]
fn grade_word(
    state: tauri::State<'_, Mutex<Store>>,
    word: String,
    grade: String,
) -> Result<Word, String> {
    let g = srs::Grade::parse(&grade).ok_or("unknown grade")?;
    let now = today();
    let mut store = state.lock().unwrap();
    let entry = store.bank.find_mut(&word).ok_or("word not found")?;
    srs::apply(&mut entry.srs, g, now);
    let out = entry.clone();
    store.save()?;
    Ok(out)
}

#[tauri::command]
fn analyze_essay(
    state: tauri::State<'_, Mutex<Store>>,
    text: String,
) -> Result<essay::EssayReport, String> {
    let now = today();
    let store = state.lock().unwrap();
    let bank_words: Vec<String> = store.bank.words.iter().map(|w| w.word.clone()).collect();
    let today_words: Vec<String> = store
        .bank
        .today
        .as_ref()
        .filter(|t| t.date == now)
        .map(|t| t.words.clone())
        .unwrap_or_default();
    Ok(essay::analyze(&text, &bank_words, &today_words))
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
            app.manage(Mutex::new(Store::load(dir)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_word,
            list_words,
            delete_word,
            today_list,
            tick_word,
            due_words,
            grade_word,
            analyze_essay,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
