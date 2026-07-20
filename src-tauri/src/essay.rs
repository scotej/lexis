use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Serialize)]
pub struct UsedWord {
    pub word: String,
    pub count: u32,
    pub sentences: Vec<String>,
    pub overused: bool,
    pub in_today: bool,
}

#[derive(Debug, Serialize)]
pub struct EssayReport {
    pub essay_words: usize,
    pub bank_size: usize,
    pub used: Vec<UsedWord>,
    pub unused_today: Vec<String>,
    pub notes: Vec<String>,
}

/// Inflected forms a bank word might take in running text. Small,
/// rule-based, and entirely on-device — enough for regular English
/// morphology (demise → demises; vilify → vilifies, vilified; run →
/// running is out of scope for -ing doubling beyond simple cases).
pub fn variants(word: &str) -> HashSet<String> {
    let w = word.to_lowercase();
    let mut set = HashSet::new();
    set.insert(w.clone());
    set.insert(format!("{}s", w));
    set.insert(format!("{}es", w));
    set.insert(format!("{}ed", w));
    set.insert(format!("{}d", w));
    set.insert(format!("{}ing", w));
    set.insert(format!("{}ly", w));
    if let Some(stem) = w.strip_suffix('e') {
        set.insert(format!("{}ing", stem));
        set.insert(format!("{}ed", stem));
    }
    if let Some(stem) = w.strip_suffix('y') {
        set.insert(format!("{}ies", stem));
        set.insert(format!("{}ied", stem));
        set.insert(format!("{}ily", stem));
    }
    if let Some(last) = w.chars().last() {
        if !"aeiouy".contains(last) {
            set.insert(format!("{}{}ing", w, last));
            set.insert(format!("{}{}ed", w, last));
        }
    }
    set
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-')
        .filter(|t| !t.is_empty())
        .map(|t| t.trim_matches(|c: char| c == '\'' || c == '-').to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

fn sentences(text: &str) -> Vec<String> {
    text.split_inclusive(|c| c == '.' || c == '!' || c == '?')
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn analyze(text: &str, bank_words: &[String], today_words: &[String]) -> EssayReport {
    let tokens = tokenize(text);
    let sents = sentences(text);
    let today: HashSet<&str> = today_words.iter().map(|s| s.as_str()).collect();

    let mut used = Vec::new();
    for word in bank_words {
        let forms = variants(word);
        let count = tokens.iter().filter(|t| forms.contains(t.as_str())).count() as u32;
        if count == 0 {
            continue;
        }
        let mut examples: Vec<String> = sents
            .iter()
            .filter(|s| tokenize(s).iter().any(|t| forms.contains(t.as_str())))
            .cloned()
            .collect();
        examples.truncate(3);
        used.push(UsedWord {
            word: word.clone(),
            count,
            sentences: examples,
            overused: count >= 3,
            in_today: today.contains(word.as_str()),
        });
    }
    used.sort_by(|a, b| b.count.cmp(&a.count));

    let used_set: HashSet<&str> = used.iter().map(|u| u.word.as_str()).collect();
    let unused_today: Vec<String> = today_words
        .iter()
        .filter(|w| !used_set.contains(w.as_str()))
        .cloned()
        .collect();

    let mut notes = Vec::new();
    for u in &used {
        if u.overused {
            notes.push(format!(
                "\u{201c}{}\u{201d} appears {} times — consider varying it.",
                u.word, u.count
            ));
        }
        for s in &u.sentences {
            let words_in_sentence = tokenize(s);
            let forms = variants(&u.word);
            if words_in_sentence.iter().filter(|t| forms.contains(t.as_str())).count() >= 2 {
                notes.push(format!(
                    "\u{201c}{}\u{201d} is repeated within a single sentence.",
                    u.word
                ));
                break;
            }
        }
    }
    if !used.is_empty() && used.iter().all(|u| u.sentences.iter().all(|s| tokenize(s).len() < 8)) {
        notes.push("Your bank words mostly sit in short sentences — try weaving them into developed analysis.".into());
    }

    EssayReport {
        essay_words: tokens.len(),
        bank_size: bank_words.len(),
        used,
        unused_today,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_inflected_forms() {
        let bank = vec!["demise".to_string(), "vilify".to_string()];
        let report = analyze(
            "The author vilifies the outsider. This foreshadows the town's demise.",
            &bank,
            &[],
        );
        let words: Vec<&str> = report.used.iter().map(|u| u.word.as_str()).collect();
        assert!(words.contains(&"demise"));
        assert!(words.contains(&"vilify"));
    }

    #[test]
    fn flags_overuse() {
        let bank = vec!["demise".to_string()];
        let report = analyze(
            "The demise came early. Their demise was slow. A demise foretold.",
            &bank,
            &[],
        );
        assert!(report.used[0].overused);
    }

    #[test]
    fn tracks_unused_today_words() {
        let bank = vec!["demise".to_string(), "cessation".to_string()];
        let today = vec!["cessation".to_string()];
        let report = analyze("Nothing relevant here.", &bank, &today);
        assert_eq!(report.unused_today, vec!["cessation".to_string()]);
    }
}
