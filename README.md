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

## Two ends, one app

lexis runs as a desktop app and as a web app, with the same features in both.
That isn't a promise to keep two codebases in step — it's structural. All the
logic (scheduling, lookups, essay analysis, merging) lives in one shared
JavaScript core under `src/core`, which both ends run unchanged. The only
difference is where the bank is kept: a JSON file on the desktop, encrypted
browser storage on the web.

The web version lives on GitHub Pages and is optional. The desktop app works
on its own, offline, exactly as before.

## Sync

Sync is opt-in and costs nothing to run: GitHub hosts the page, and your bank
lives as a single encrypted file in a private repository of your own.

**Setting it up**

1. Create a private repository — say `lexis-data`. It can be empty.
2. Make a [fine-grained personal access
   token](https://github.com/settings/tokens?type=beta) scoped to *only* that
   repository, with **Contents: Read and write**. Nothing else.
3. Open lexis (web or desktop), go to **sync**, and enter the owner, the
   repository, the token, and a password.
4. Do the same on your other device, with **the same password**.

From then on both ends pull on launch and push a few seconds after you change
anything. Add a word on your laptop, tick it off in the browser at school.

**How conflicts resolve.** Each word carries the time it was last edited, and
deletions leave a tombstone, so two devices reconcile without a server: the
most recent edit of a word wins, a delete beats an older edit, re-adding a
word beats an older delete, and ticks made on both devices the same day are
merged rather than overwritten. Writes use the file's blob SHA, so a device
that committed while you were offline is never silently clobbered.

## Privacy

**On the desktop, nothing changes.** Without sync, the only network requests
are dictionary and thesaurus lookups when you add a word. Your bank, your
review history, and every essay you check stay on your machine in a single
JSON file in the app data directory.

**With sync on**, your bank — and only your bank — is copied to the private
GitHub repository you nominate. It is encrypted on your device first, with a
key derived from your password (PBKDF2-SHA256, then AES-256-GCM). GitHub
stores ciphertext and never holds the key. Essays are never synced or
uploaded; they are analysed locally and never leave the device.

**About the password, honestly.** GitHub Pages on a free account cannot serve
a private page — the HTML and JavaScript are public no matter what, so a login
that merely hid the interface could be walked straight past with view-source.
So the password here is not a curtain over the UI; it is the encryption key.
Someone who reads the page source learns nothing about your bank, and the
token that reaches GitHub is itself stored encrypted on your device, never
committed and never baked into the build.

The cost of that design: **a forgotten password cannot be reset.** Nothing,
anywhere, can decrypt without it.

## Development

Prerequisites: [Rust](https://rustup.rs) and Node. Then:

```sh
npm install
npm test             # the shared core (logic, merge, crypto, sync)
npm run web          # serve the web build at localhost:5173
npm run tauri dev    # run the desktop app
npm run tauri build  # build installers
cargo test --manifest-path src-tauri/Cargo.toml
```

The frontend is plain HTML/CSS/JS — no framework, no bundler, so "building"
the web app is copying `src/`. The Rust backend (Tauri 2) is now a thin shell:
it stores bytes and runs the updater, and everything else is the shared core.

Web Crypto needs a secure context, so the web build requires `https://` or
`localhost` — opening `index.html` as a `file://` URL won't work.

## Releases

Every push to `main` compiles the app for macOS, Windows, and Linux via
GitHub Actions (bundles are attached as workflow artifacts). Pushing a tag
like `v0.1.0` publishes a GitHub release with installers.

The same push deploys the web build to GitHub Pages. To turn that on once:
**Settings → Pages → Source → GitHub Actions**. The workflow runs the test
suite first and deploys only if it passes. No secrets are involved — the sync
token is typed into the running page, never into the repository.

### "lexis is damaged" on macOS

The app isn't damaged — it's unsigned (signing requires a paid Apple
Developer account), and macOS quarantines unsigned apps downloaded from the
internet. After copying `lexis.app` to Applications, clear the flag once:

```sh
xattr -cr /Applications/lexis.app
```

Building locally with `npm run tauri build` avoids this entirely — apps you
build on your own machine are never quarantined.
