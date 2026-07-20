# lexis.

A minimalist word bank for essay writers. Type a word; lexis fetches a concise,
human-written definition, suggests sophisticated synonyms suited to analytical
writing, and then makes sure the word actually ends up in your essays — not
just in a list.

Built for VCE English, useful anywhere precise vocabulary matters.

## How it works

**Bank.** Type a word — say *demise* — and lexis looks it up in Wiktionary
(via [dictionaryapi.dev](https://dictionaryapi.dev), falling back to the
Wiktionary REST API). Definitions are written by human editors, never
generated. Entries render like a print dictionary: headword, IPA, part of
speech, numbered senses.

**Synonyms for essays.** Each word also gets a short run of synonyms drawn
from [Datamuse](https://www.datamuse.com/api/) (corpus statistics, not AI) and
ranked by an on-device scorer that favours the formal register — uncommon but
usable words, Latinate endings, some length. They're suggestions for your
writing, deliberately *not* added to the bank.

**Today.** Every day lexis picks about ten words — most overdue first — and
asks you to work them into that day's writing. Ticking a word counts as a
successful review.

**Review.** Classic flashcards over the same schedule: see the word, recall
the meaning, grade yourself *again / hard / good / easy*. Scheduling is SM-2,
the algorithm behind Anki, simplified to whole days.

**Essay check.** Paste a draft (or open a `.txt` file) and lexis reads it
entirely on this device: which bank words you used, in which sentences,
what's overused, and what's still waiting on today's list. One click marks
the used words as practised.

## Privacy

The only network requests are dictionary and thesaurus lookups when you add a
word. Your bank, your review history, and every essay you check stay on your
machine, in a single JSON file in the app data directory.

## Development

Prerequisites: [Rust](https://rustup.rs) and Node. Then:

```sh
npm install
npm run tauri dev    # run the app
npm run tauri build  # build installers
cargo test --manifest-path src-tauri/Cargo.toml
```

The frontend is plain HTML/CSS/JS — no framework, no bundler. The backend is
Rust (Tauri 2).

## Releases

Every push to `main` compiles the app for macOS, Windows, and Linux via
GitHub Actions (bundles are attached as workflow artifacts). Pushing a tag
like `v0.1.0` publishes a GitHub release with installers.
