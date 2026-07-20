use crate::bank::{Sense, Synonym};
use serde::Deserialize;
use std::time::Duration;

const UA: &str = "lexis/0.1 (minimalist word bank; https://github.com/scotej/lexis)";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())
}

pub struct DictResult {
    pub phonetic: Option<String>,
    pub senses: Vec<Sense>,
    pub source: String,
    pub source_url: String,
}

// ---- Primary source: dictionaryapi.dev (definitions written by Wiktionary editors) ----

#[derive(Deserialize)]
struct FdEntry {
    #[serde(default)]
    phonetic: Option<String>,
    #[serde(default)]
    phonetics: Vec<FdPhonetic>,
    #[serde(default)]
    meanings: Vec<FdMeaning>,
}

#[derive(Deserialize)]
struct FdPhonetic {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct FdMeaning {
    #[serde(rename = "partOfSpeech")]
    part_of_speech: String,
    #[serde(default)]
    definitions: Vec<FdDefinition>,
}

#[derive(Deserialize)]
struct FdDefinition {
    definition: String,
    #[serde(default)]
    example: Option<String>,
}

async fn fetch_dictionaryapi(word: &str) -> Result<DictResult, String> {
    let url = format!("https://api.dictionaryapi.dev/api/v2/entries/en/{}", word);
    let resp = client()?.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("dictionaryapi.dev returned {}", resp.status()));
    }
    let entries: Vec<FdEntry> = resp.json().await.map_err(|e| e.to_string())?;
    let entry = entries.into_iter().next().ok_or("empty response")?;

    let phonetic = entry
        .phonetic
        .filter(|p| !p.is_empty())
        .or_else(|| entry.phonetics.into_iter().find_map(|p| p.text.filter(|t| !t.is_empty())));

    // Keep it concise: at most three parts of speech, two senses for the
    // first and one for the rest.
    let mut senses = Vec::new();
    for (i, meaning) in entry.meanings.iter().take(3).enumerate() {
        let keep = if i == 0 { 2 } else { 1 };
        for d in meaning.definitions.iter().take(keep) {
            senses.push(Sense {
                pos: meaning.part_of_speech.clone(),
                def: d.definition.trim().to_string(),
                example: d.example.as_ref().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()),
            });
        }
    }
    if senses.is_empty() {
        return Err("no definitions in response".into());
    }

    Ok(DictResult {
        phonetic,
        senses,
        source: "Wiktionary via dictionaryapi.dev".into(),
        source_url: format!("https://en.wiktionary.org/wiki/{}", word),
    })
}

// ---- Fallback source: Wiktionary REST API ----

#[derive(Deserialize)]
struct WkUsage {
    #[serde(rename = "partOfSpeech")]
    part_of_speech: String,
    #[serde(default)]
    definitions: Vec<WkDefinition>,
}

#[derive(Deserialize)]
struct WkDefinition {
    #[serde(default)]
    definition: String,
}

fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn fetch_wiktionary(word: &str) -> Result<DictResult, String> {
    let url = format!("https://en.wiktionary.org/api/rest_v1/page/definition/{}", word);
    let resp = client()?.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("wiktionary returned {}", resp.status()));
    }
    let body: std::collections::HashMap<String, Vec<WkUsage>> =
        resp.json().await.map_err(|e| e.to_string())?;
    let usages = body.get("en").ok_or("no English entry")?;

    let mut senses = Vec::new();
    for (i, usage) in usages.iter().take(3).enumerate() {
        let keep = if i == 0 { 2 } else { 1 };
        for d in usage.definitions.iter() {
            let text = strip_html(&d.definition);
            if text.is_empty() {
                continue;
            }
            senses.push(Sense {
                pos: usage.part_of_speech.to_lowercase(),
                def: text,
                example: None,
            });
            if senses.iter().filter(|s| s.pos == usage.part_of_speech.to_lowercase()).count() >= keep {
                break;
            }
        }
    }
    if senses.is_empty() {
        return Err("no definitions found".into());
    }

    Ok(DictResult {
        phonetic: None,
        senses,
        source: "Wiktionary".into(),
        source_url: format!("https://en.wiktionary.org/wiki/{}", word),
    })
}

pub async fn fetch_definition(word: &str) -> Result<DictResult, String> {
    match fetch_dictionaryapi(word).await {
        Ok(r) => Ok(r),
        Err(first) => fetch_wiktionary(word).await.map_err(|second| {
            format!("no dictionary entry found for \"{}\" ({}; {})", word, first, second)
        }),
    }
}

// ---- Synonyms: Datamuse (corpus statistics, not AI) + local sophistication scoring ----

#[derive(Deserialize)]
struct DmWord {
    word: String,
    #[serde(default)]
    tags: Vec<String>,
}

fn parse_freq(tags: &[String]) -> f64 {
    // Datamuse's `f:` tag is occurrences per million words of corpus text.
    tags.iter()
        .find_map(|t| t.strip_prefix("f:").and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

/// Scores a candidate synonym for how well it suits formal analytical
/// writing (VCE-style metalanguage). Entirely on-device: favours words
/// that are uncommon in everyday text but not vanishingly obscure, have
/// some length to them, and carry Latinate endings typical of the formal
/// register.
pub fn sophistication_score(word: &str, freq: f64) -> f64 {
    let mut score = 0.0;

    // Rarity: the sweet spot is roughly 0.05–15 occurrences per million.
    score += if freq <= 0.0 {
        1.0 // unknown frequency: mildly interesting
    } else if freq < 0.02 {
        0.5 // probably too obscure to use safely
    } else if freq < 1.0 {
        3.0
    } else if freq < 15.0 {
        2.0
    } else if freq < 60.0 {
        0.8
    } else {
        -1.0 // everyday word; not an upgrade
    };

    // Length: longer words tend toward the formal register.
    let len = word.chars().count();
    score += match len {
        0..=4 => -1.0,
        5..=6 => 0.3,
        7..=9 => 1.2,
        _ => 1.5,
    };

    // Latinate/Greek endings common in analytical prose.
    const FORMAL_SUFFIXES: [&str; 14] = [
        "tion", "sion", "ment", "ance", "ence", "ity", "ism", "esce", "escence",
        "ate", "ify", "ise", "ize", "ous",
    ];
    if FORMAL_SUFFIXES.iter().any(|s| word.ends_with(s)) {
        score += 0.8;
    }

    score
}

pub async fn fetch_synonyms(word: &str) -> Vec<Synonym> {
    let url = format!("https://api.datamuse.com/words?rel_syn={}&md=f&max=40", word);
    let Ok(client) = client() else { return Vec::new() };
    let Ok(resp) = client.get(&url).send().await else { return Vec::new() };
    let Ok(words) = resp.json::<Vec<DmWord>>().await else { return Vec::new() };

    let mut ranked: Vec<Synonym> = words
        .into_iter()
        .filter(|w| {
            w.word != word
                && !w.word.contains(' ')
                && w.word.chars().all(|c| c.is_ascii_alphabetic() || c == '-')
        })
        .map(|w| {
            let freq = parse_freq(&w.tags);
            let score = sophistication_score(&w.word, freq);
            Synonym { word: w.word, freq, score }
        })
        .collect();

    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(8);
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formal_words_outscore_plain_ones() {
        // "cessation" (rare, Latinate) should beat "end" (short, everyday).
        let cessation = sophistication_score("cessation", 2.1);
        let end = sophistication_score("end", 320.0);
        assert!(cessation > end);
    }

    #[test]
    fn strip_html_removes_tags_and_entities() {
        assert_eq!(
            strip_html("<span>Death</span> or <i>ruin</i> &amp; decline"),
            "Death or ruin & decline"
        );
    }
}
