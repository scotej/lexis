use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sense {
    pub pos: String,
    pub def: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Synonym {
    pub word: String,
    /// Occurrences per million words (Datamuse corpus frequency).
    pub freq: f64,
    /// Local sophistication score — higher reads as more formal/analytical.
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Srs {
    pub reps: u32,
    pub lapses: u32,
    pub ease: f64,
    pub interval: u32,
    pub due: NaiveDate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<NaiveDate>,
}

impl Srs {
    pub fn new(today: NaiveDate) -> Self {
        Srs { reps: 0, lapses: 0, ease: 2.5, interval: 0, due: today, last: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    /// Lowercased key, unique within the bank.
    pub word: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phonetic: Option<String>,
    pub senses: Vec<Sense>,
    pub synonyms: Vec<Synonym>,
    pub source: String,
    pub source_url: String,
    pub added: NaiveDate,
    pub srs: Srs,
    #[serde(default)]
    pub times_used: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodayList {
    pub date: NaiveDate,
    pub words: Vec<String>,
    pub ticked: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Bank {
    #[serde(default)]
    pub words: Vec<Word>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub today: Option<TodayList>,
}

impl Bank {
    pub fn find(&self, word: &str) -> Option<&Word> {
        self.words.iter().find(|w| w.word == word)
    }

    pub fn find_mut(&mut self, word: &str) -> Option<&mut Word> {
        self.words.iter_mut().find(|w| w.word == word)
    }
}

pub struct Store {
    path: PathBuf,
    pub bank: Bank,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("bank.json");
        let bank = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Store { path, bank }
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&self.bank).map_err(|e| e.to_string())?;
        fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}
