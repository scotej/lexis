# lexis.

A minimalist word bank for essay writers. Type a word; lexis fetches a concise,
human-written definition, suggests sophisticated synonyms suited to analytical
writing, and then makes sure the word actually ends up in your essays — not
just in a list.

Built for VCE English, useful anywhere precise vocabulary matters.

## How it works

**Bank.** Type a word — say *demise* — and lexis looks it up in Wiktionary
(via [dictionaryapi.dev](https://dictionaryapi.dev), falling back to the
Wiktionary REST API). Definitions come from human-edited entries, never a
language model. When an entry only restates an adverb as “in a … manner”,
lexis clarifies it with common same-part-of-speech results from Datamuse
instead of guessing which of the adjective's senses applies. Entries render
like a print dictionary: headword, IPA, part of speech, numbered senses. Add
several words in one go by separating them with spaces; lexis looks them up a
few at a time and adds them — or, if one of them cannot be found, none of
them — as a single change to the bank. As the bank grows, sort it by date
added, alphabetically, by due date, or by how much you've practised or used a
word in essays.

**Synonyms for essays.** Each word also gets a short run of synonyms drawn
from [Datamuse](https://www.datamuse.com/api/) (corpus statistics, not AI) and
ranked by an on-device scorer that favours the formal register — uncommon but
usable words, Latinate endings, some length. They're suggestions for your
writing, deliberately *not* added to the bank.

**Today.** Every day lexis picks a batch of words — ten by default, most
overdue first — and asks you to work them into that day's writing. Ticking a
word counts as a successful review. If you want a different selection,
**refresh list** rotates in the next due words without erasing anything you
have already practised, and once a batch is done you can pull in another
without resetting it. The batch size is yours to change in **settings**.
When an older stored adverb reaches Today, its opaque definition is upgraded
with the same lexical clarification used for newly added words.

**Review.** Classic flashcards over the same schedule: see the word, recall
the meaning, grade yourself *again / hard / good / easy*. Scheduling is SM-2,
the algorithm behind Anki, simplified to whole days.

**Essay check.** Paste a draft (or open a `.txt` file) and lexis reads it
entirely on this device: which bank words you used, in which sentences,
what's overused, and what's still waiting on today's list. Logging the checked
draft adds every matched occurrence — including bank words outside today's
list — to that word's separate essay-use total. Matches from today's list are
also marked as practised and scheduled to return.

**Type.** A typing test, in the shape typists already know — but built out of
quotes worth typing. Sixteen thousand of them, from about 4,700 sources: film
and television dialogue, novels and plays, philosophy and science, oratory and
proverbs. Every one is attributed, so you always know who said it and where.
Sorted by length (*short*, *medium*, *long*, *thicc*), and filterable by
shelf — films, television, books, speeches, people, proverbs — alongside timed
and word-count runs and a blank page for zen. Everything monkeytype puts in
its settings is here: difficulty, stop-on-error, confidence and freedom modes,
strict space, lazy mode, caret styles, tape mode, blind mode, minimum-speed
floors, live wpm.

What it adds is the filter only a word bank can offer: **only quotes using a
word from my bank** — or from today's list, or from what is due for review.
Meeting *demise* in a line of Dickens, at speed, is a different kind of
practice from turning over a card with *demise* on it, and it is the kind that
survives into an essay. The result screen names which of your words you just
typed, and how many tests you have now met each of them in. In the timed and
word-count modes your bank can *be* the word list.

The corpus is chosen to make that filter work. Eight hundred thousand words,
weighted towards the uncommon-but-real vocabulary a student actually banks: a
representative VCE word list turns up in 94% of cases, at a median of nine
quotes per word. Where the shelf still runs out, AI carries on (below).

Speeds, personal bests and preferences stay on the device — they are facts
about a keyboard as much as about a typist — so they are never synced,
uploaded, or sent to a model.

**Stats.** A dedicated view charts your activity — words added and reviews
done per day — alongside running totals for bank size, reviews, streak, and
essay uses. Recorded activity stays in these statistics even after a word is
later removed.

**Quick lookup.** Press `/` (or `⌘K`) anywhere for a definition without
commitment: type a word, read its senses, `esc` to close — or add it to the
bank after all. The eight views answer to the keys `1`–`8` — except while the
typing test has the keyboard, which it needs in order to be a typing test;
`esc` hands it back.

## AI assist (optional, via OpenRouter)

Everything above works offline and always will. On top of it, lexis offers a
layer of AI help for the parts a dictionary can't answer — and it stays off
until you hand it a key.

Paste an [OpenRouter](https://openrouter.ai) API key into **settings → ai
assist** (any model works; leave the model blank for OpenRouter's automatic
routing). That unlocks three things:

- **Essay feedback.** A second button beside *check essay* sends the draft
  for structured feedback: what already works, the few changes that would
  lift it most, and what to practise next — with your bank's headwords in
  view so it can point out where your own vocabulary belongs.
- **Similar words.** Each entry and lookup grows two links. *similar words*
  asks for near-neighbours suited to analytical writing, each with a note on
  what makes it different from the headword; any row's **vs** splits the pair
  apart properly — which word implies what, where each would feel wrong, and
  which to prefer in an essay.
- **Example sentences.** The second link writes three sentences using the
  word the way an analytical essay would — drawing on your open draft when
  there is one, so the examples speak about your text rather than a generic
  novel.
- **Passages to type.** In **type**, set *written by* to **ai** (or **both**)
  and the model writes passages built around your bank words, at whichever
  length you asked for. They are written *ahead* of being wanted — three sit
  ready at all times, and taking one starts the next — so a test still begins
  the moment you press a key. There is one wait, when the queue first fills,
  and the view says so while it happens. If the key is missing or the model
  fails, the library carries on and the bar says which.

The key is a credential like the sync token: stored only as ciphertext on the
device that holds it, never synced to GitHub or the backup folder, never
baked into any build, and sent nowhere except to `openrouter.ai`. Requests go
straight from the app to OpenRouter — there is no lexis server in between.
What you send is what the feature needs, and no more: essay feedback sends the
draft along with your bank's headwords; example sentences send the word and the
opening of whatever draft is in the essay view, so they can speak about your
text; passages to type send your bank's headwords and a length; similar words
and **vs** send the words alone. Nothing you type *into* the typing test is
sent anywhere — the scoring is arithmetic, done here.

**Know what leaves the device.** Everything else in lexis is analysed here;
these four features are not, and cannot be. Your draft goes to OpenRouter,
which forwards it to whichever provider serves the model you chose — and some
providers keep what they are sent, or train on it.

So **strict privacy** is on by default, and every request carries it:
providers that collect or retain prompts are excluded from the routing, and
lexis would rather fail to find a model than quietly use one of them. A
narrowly-hosted model — free ones especially — may have no provider that
qualifies; when that happens the error says exactly that and points at the
checkbox, so turning it off is a decision you make rather than a default you
fall into. Your own account settings at
[openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy)
still apply on top. Worth reading before you send work that is being
assessed. The settings panel also shows what this session has spent, so the
cost of asking never comes as a surprise either.

## Two ends, one app

lexis runs as a desktop app and as a web app, with the same features in both.
That isn't a promise to keep two codebases in step — it's structural. All the
logic (scheduling, lookups, essay analysis, merging) lives in one shared
JavaScript core under `src/core`, which both ends run unchanged. The only
difference is where the bank is kept: a JSON file on the desktop, encrypted
browser storage on the web.

The web version lives on GitHub Pages and is optional. The desktop app works
on its own, offline, exactly as before.

## CachyOS / Arch Linux

Use the signed `amd64.AppImage` from the
[latest release](https://github.com/scotej/lexis/releases/latest). The AppImage
is the cross-distribution build and keeps in-app updates working when it is
stored in a user-writable location. CachyOS is currently supported on x86_64.

```sh
sudo pacman -S --needed fuse2
install -Dm755 lexis_*_amd64.AppImage ~/.local/bin/lexis.AppImage
~/.local/bin/lexis.AppImage
```

`fuse2` is only needed to mount AppImages; skip the first command if it is
already installed.

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

**A second copy, on your own network.** lexis can also keep an encrypted copy
in a folder you already sync between machines — a Syncthing folder, or anything
else that carries a directory across. (lexis looks for Syncthing's `.stfolder`
marker and says so if it can't find one; that notice is informational and can
be silenced.)

Set it up per machine, after GitHub sync is connected on that machine — the
folder section only appears once it is, because it is sealed with the same
password-derived key:

1. Connect GitHub sync as above, with **the same password** as your other device.
2. Go to **sync → local backup** and nominate the folder *on this machine*: the
   desktop app takes a path (say `~/Documents/Crossing`); a browser opens a
   folder picker instead, because a page can be handed a directory but cannot
   open one by name.
3. Repeat on the other machine. The path is usually different there; take it
   from that machine's own Syncthing, not from this one.

From then on every change is written there as well as to GitHub.

**The browser can do this too.** Chrome and Edge let a page hold onto a folder
you give it — choose *Allow on every visit* at the prompt (or install lexis as
an app) and it reconnects by itself from then on. If a browser revokes that
access, which Chrome does to backgrounded tabs, the panel says so and offers a
button rather than failing quietly. Safari and Firefox ship no picker at all;
there the same file travels by hand.

**By hand, anywhere.** **sync → by hand** saves the identical encrypted
envelope as a file, and opens files back. It is the fallback for browsers with
no picker, and the way to read a backup the folder itself considers too old —
a file taken out of the folder and a file saved here are the same format, so
either can be fed to the other. Keep the filename lexis gives it: a browser's
`… (1).json` copy is not one lexis will read.

It is a genuine second channel, not a mirror of the first. Two machines on the
same desk reconcile through the folder with no internet at all, and they do it
in seconds rather than minutes: the folder is checked every eight seconds for
the price of a directory listing, where GitHub is polled every five minutes. If GitHub
is unreachable your work still crosses; if the folder is unreachable — an
unmounted drive, a machine that is off — GitHub still carries it. Turn the
folder off and nothing else changes.

**One file per device.** Each machine writes only `bank.<device>.lexis.json`
inside a `lexis` subfolder, and reads everyone else's. That is deliberate: one
shared file with two writers is exactly what Syncthing cannot resolve, and
would sprout `.sync-conflict-…` copies every time both machines were edited
while apart. With a single writer per file there is nothing to conflict over.
Conflict copies are still handled if they do appear — they are decrypted,
merged in like any other peer, and removed only once their contents are safely
in your bank. A peer file older than six months is left alone rather than
merged, since it may hold words every live machine has since deleted.

**How conflicts resolve.** Each word carries the time it was last edited, and
deletions leave a tombstone, so devices reconcile without a server: the most
recent edit of a word wins, a copy with review history beats a freshly retyped
one, a delete beats an older edit, re-adding a word beats an older delete, and
ticks made on both devices the same day are merged rather than overwritten.
Writes to GitHub use the file's blob SHA, so a device that committed while you
were offline is never silently clobbered.

**And when resolving costs something, it says so.** A merge always produces an
answer, but sometimes the answer discards real work — a definition you edited
on one machine, a fortnight of reviews on the other. Those are listed under
**sync → conflicts**, naming which copy was kept, which channel it came from,
and in broad terms what the discarded one held: a further-along review
schedule, more practice, different synonyms, or a different definition.

A word's dictionary and its review schedule are resolved on separate clocks, so
the two can be kept from *different* machines — and they are listed, and undone,
separately. Each entry offers the discarded copy back: *use the other copy*
reinstates the record, *use the other definition* replaces only the dictionary
entry. Either is applied as an edit made now, so it propagates through GitHub
and the folder by the ordinary rules.

Undoing never costs you scheduling. Whichever copy is further along keeps the
review history, because the schedule is not what a restore is for and it is the
one thing that cannot be recovered once dropped — so *use the other copy* takes
the discarded definition, synonyms, and practice count without rewinding
spaced repetition.

## Privacy

**On the desktop, nothing changes.** Without sync and without an AI key, the
only network requests are dictionary and thesaurus lookups when you add a
word. Your bank, your review history, and every essay you check stay on your
machine in a single JSON file in the app data directory.

**With sync on**, your bank — and only your bank — is copied to the private
GitHub repository you nominate. It is encrypted on your device first, with a
key derived from your password (PBKDF2-SHA256, then AES-256-GCM). GitHub
stores ciphertext and never holds the key. Essays are never synced or
uploaded; they are analysed locally and never leave the device. Neither are
typing speeds, personal bests, or typing preferences: those stay on the
device that made them.

**With an AI key saved**, your work leaves for OpenRouter only when you ask
for essay feedback or the vocabulary tools, and only with what that feature
needs (see *AI assist* above). The typing test asks on its own account, but
only once you have set *quotes from* to **ai**, and only ever for passages
built from your bank's headwords — never for anything you have typed. Because that includes your draft, it is held to
the same standard as everything else here: strict privacy is on by default,
and every request tells OpenRouter to route only to providers that neither
collect nor retain what they are sent. The one other request the app makes on its own account
is a balance and model-catalogue check when you open **settings → ai assist** —
it carries the key and nothing else, and it happens when you open that panel,
not when the app starts.

The key itself is stored encrypted at rest: sealed under your
password-derived session key on the web, and under a random per-device key
held in a `0600` file beside the bank on the desktop. That protects it from
other accounts on the machine and from file copies; nothing stored on your
behalf can protect it from malware already running as you, on this or any
app. Removing the key in settings erases the stored ciphertext entirely — and
so, on the web, do *use a different account* and *disconnect this device*,
since both discard the session key that sealed it at the same moment. On the
desktop neither touches it: the device key it is sealed under has nothing to
do with sync.

**The local backup folder is held to the same standard**, and for the same
reason: a synced folder is a plain directory on two machines with possibly an
untrusted relay in between. It gets the identical envelope under the identical
key, so it holds ciphertext and a README explaining as much — Syncthing carries
bytes it cannot read, and neither can anyone who copies the folder.

What the folder does *not* hide is metadata: anyone who can see the directory
learns that you use lexis, how many devices you sync, each device's random id,
and roughly how often and how much you write, from the file names, sizes, and
timestamps. Only the contents are encrypted.

In a browser, the folder you nominate is remembered as a handle in this
origin's storage, and the folder's name is not encrypted the way the bank is —
a handle cannot be. **Disconnect this device** and the gate's **start over**
both drop it, so nothing that can reach your disk outlives them.

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
npm test             # the shared core (logic, merge, crypto, sync, typing)
npm run web          # serve the web build at localhost:5173
npm run tauri dev    # run the desktop app
npm run tauri build  # build installers
cargo test --manifest-path src-tauri/Cargo.toml
```

The quote corpus in `src/data/` is generated and committed, so nothing about a
normal build touches the network:

```sh
node tools/harvest/wikiquote.mjs    # fetch the shelves into .quote-cache/
node tools/harvest/wikisource.mjs   # speeches and essays, for the long lengths
node tools/build-quotes.mjs         # assemble them into src/data/quotes.js
```

Harvesting and choosing are deliberately separate. The harvesters know one
source each and its quirks; `build-quotes.mjs` applies one set of standards to
everything they return, so a line from a film and a line from a philosopher are
held to the same bar.

What to fetch lives in `tools/harvest/shelves.mjs`, and it is a curated list
rather than a crawl — that is the single biggest lever on quality. Wikiquote
will hand over eight hundred thousand television lines, and the large majority
are scene filler from shows nobody has heard of; naming ~700 works instead
yields 170,000 candidates worth choosing between. Adding a title to that file
is how the corpus grows.

The selection stage then balances three things that will not balance
themselves — length, kind, and source — because supply is wildly uneven (there
are 95,000 short quotes available and 6,000 long ones), rejects anything that
is not typeable, not English, not a whole sentence, or not fit for a school
screen, and caps how much any one work may contribute.

The frontend is plain HTML/CSS/JS — no framework, no bundler, so "building"
the web app is copying `src/`. The Rust backend (Tauri 2) is now a thin shell:
it stores bytes, lends the backup folder a filesystem, keeps the per-device
key that seals AI settings, and runs the updater. Everything else — including
what goes into that folder and how it is sealed — is the shared core.

Web Crypto needs a secure context, so the web build requires `https://` or
`localhost` — opening `index.html` as a `file://` URL won't work.

## Releases

Every push to `main` compiles the app for macOS, Windows, and Linux via
GitHub Actions (bundles are attached as workflow artifacts). A version commit
whose subject matches the version in `package.json` (for example `v0.4.2`)
is tested, tagged, and published automatically. Pushing a matching tag also
publishes a release.

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
