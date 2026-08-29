/**
 * Builds `src/data/quotes.js` from harvested quote sources.
 *
 *   node tools/harvest-all.mjs          # fetch and cache the sources
 *   node tools/build-quotes.mjs         # assemble them into src/data/quotes.js
 *
 * The harvesters in `tools/harvest/` each go and get raw material from one
 * place and write `<name>.json` into `.quote-cache/`, as a flat array of
 * `{ text, speaker, work, author, kind }`. This file does everything after
 * that: cleaning, judging, de-duplicating, and choosing which of them ship.
 *
 * The split matters. Harvesting is I/O and per-source quirks; selection is a
 * single set of standards applied to everything equally, so a line from a film
 * and a line from a philosopher are held to the same bar. Keeping them apart
 * is what stops the standards drifting per source.
 *
 * What ships is committed, so building lexis never touches the network.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CACHE = flag("cache", new URL("../.quote-cache/", import.meta.url).pathname);
const OUT_QUOTES = flag("out", new URL("../src/data/quotes.js", import.meta.url).pathname);
const MAX_QUOTES = Number(flag("max", 20000));
const VERBOSE = args.includes("--verbose");

/* ---- what a quote has to be ---- */

const KINDS = new Set(["film", "tv", "book", "speech", "person", "proverb", "prose"]);

/** Hard bounds. Below the floor it is a fragment; above the ceiling nobody types it. */
const MIN_CHARS = 24;
const MAX_CHARS = 1100;

const LIGATURES = new Map([
  ["æ", "ae"], ["Æ", "Ae"], ["œ", "oe"], ["Œ", "Oe"], ["ß", "ss"],
  ["ﬁ", "fi"], ["ﬂ", "fl"], ["…", "..."], ["№", "No."],
]);

/**
 * Everything a standard keyboard can actually produce, and nothing else.
 *
 * A curly apostrophe in a typing test is an error the typist cannot correct —
 * the key simply is not there — so accents are folded and every flavour of
 * quote, dash and ellipsis is flattened to its ASCII ancestor before anything
 * else looks at the text.
 */
export function toTypeable(raw) {
  let text = String(raw ?? "");
  for (const [from, to] of LIGATURES) text = text.split(from).join(to);
  text = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return text
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[—―]/g, " - ")
    .replace(/[–‐‑−]/g, "-")
    .replace(/[    ]/g, " ")
    .replace(/[§¶†‡•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markup and editorial furniture that survives a harvester's first pass. */
function stripResidue(text) {
  return text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2") // wiki links
    .replace(/'''?/g, "") // wiki bold/italic
    .replace(/<[^>]{1,80}>/g, " ") // stray tags
    .replace(/&[a-z]+;|&#\d+;/gi, " ") // entities a harvester missed
    .replace(/\{\{[^}]*\}\}/g, " ") // templates
    .replace(/\[\d+\]/g, "") // footnote markers
    // A trailing citation is the editor talking, not the author: "(p17)",
    // "(157-158)", "(Preface)". It is also the commonest reason a quote stops
    // looking like a sentence, which is how it was noticed.
    .replace(
      /\s*\((?:(?:p{1,2}\.?|pages?)\s?)?(?:\d+(?:\s*[-\u2013]\s*\d+)?|preface|introduction|foreword|prologue|epilogue|afterword|ch\.?\s?\d+|act\s+[ivxl]+(?:,?\s*sc\.?\s*[ivxl\d]+)?)\)\s*$/i,
      ""
    )
    // Stage directions in square brackets, at any length: "[Amanda happily
    // takes a forkful of the cream tart]" is a note to the reader that a
    // sixty-character limit was letting through whole.
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s*\((?:laughs?|laughing|beat|pause|sighs?|cont'd|off screen|o\.s\.|v\.o\.)\)\s*/gi, " ")
    // A space that has drifted in front of a closing quote, which is what makes
    // "be careful! '" look like it stops mid-air.
    .replace(/\s+(["')\]]+)\s*$/, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const JUNK = [
  /\b(wikipedia|wikiquote|wikisource|retrieved|isbn|http|www\.)\b/i,
  /^(external links?|see also|references?|notes?|sources?|cast|plot|synopsis|about|quotes about)\b/i,
  /^(chapter|book|part|act|scene|canto|volume|episode|season|序)\b/i,
  /\b(p{1,2}\.\s?\d+|pp\.\s?\d+|vol\.\s?\d+|ch\.\s?\d+)\b/i,
  /\{\{|\}\}|\[\[|\]\]|\|\s*$/,
  /^[\d\W]+$/,
  /\b(citation needed|dead link|full citation)\b/i,
  // A "quote" that is only a name and a date is a caption.
  /^[A-Z][a-z]+ [A-Z][a-z]+,? \(?\d{4}\)?\.?$/,
];

/**
 * What must never reach a student's screen.
 *
 * Some of the richest sources are exhaustive rather than curated — Wikiquote
 * transcribes whole episodes of *South Park* the same way it records
 * Shakespeare — so this is not hypothetical. A typing test is used at school,
 * on a shared screen, by someone practising for an English exam; explicit
 * material has no business in it whatever its provenance.
 *
 * The line is drawn at explicit sexual content, slurs, and strong profanity —
 * NOT at every rude word. "Frankly, my dear, I don't give a damn" is one of
 * the most famous lines in cinema, Shakespeare is full of bastards, and a
 * filter that ate them would be failing at the actual job, which is to keep
 * the corpus worth reading.
 */
const FORBIDDEN = [
  /\b(fuck|f\*+k|motherf\w*|cunt|cocksuck\w*|blowjob|rimjob|handjob)\w*\b/i,
  /\b(dick|cock|prick|balls|tits|boobs|titties|penis|vagina|rectum|anus|asshole|arsehole)\b/i,
  /\b(sodom\w+|masturbat\w+|orgasm\w*|ejaculat\w+|erection|pornograph\w+|whore|slut)\b/i,
  /\b(nigg\w+|fagg?\w*|retard\w*|tranny|kike|spic|chink|wetback|paki)\b/i,
  /\b(have sex|make love to|screw you|blow me|suck my|jerk off|get laid)\b/i,
  /\b(rape|raping|rapist|incest|paedophil\w+|pedophil\w+|bestiality)\b/i,
  /\b(fart|farting|turd|crotch|boner|douchebag)\b/i,
  /\b(shit|bullshit|piss|bitch|bastard)\b.{0,40}\b(shit|piss|bitch|bastard|damn)\b/i, // a pile-on, not a single word
];

export function forbidden(text) {
  return FORBIDDEN.some((re) => re.test(text));
}

/**
 * Is this English?
 *
 * Wikiquote quotes the original alongside the translation, so a page on Mozart
 * hands over German and a page on Seneca hands over Latin — and stripped of
 * their accents both are perfectly good ASCII, which is why the typeability
 * check does not catch them. Function words are the cheap, reliable tell: no
 * English sentence of any length avoids all of them, and no German one hits
 * several.
 */
const FUNCTION_WORDS = new Set([
  "the", "of", "and", "to", "in", "a", "is", "that", "it", "for", "was", "with",
  "as", "on", "be", "at", "by", "not", "this", "but", "from", "have", "are",
  "you", "we", "he", "she", "they", "his", "her", "all", "there", "what",
  "who", "when", "which", "or", "if", "so", "an", "no", "do", "will", "can",
  "has", "had", "were", "been", "would", "their", "them", "our", "your", "my",
]);

/**
 * Function words of the languages Wikiquote prints alongside the English.
 *
 * A positive check alone is not enough, because the short English words it
 * looks for — "a", "on", "de" — occur in French and German too, and a long
 * passage of Hugo collects three of them by accident. A language is better
 * identified by the words only it uses.
 */
const FOREIGN_WORDS = new Set([
  "der", "und", "nicht", "ich", "aber", "sich", "werden", "dass", "von", "mit",
  "auf", "sind", "sein", "ihr", "wenn", "oder", "eine", "einen", "zum", "zur",
  "quod", "enim", "atque", "autem", "nihil", "ipsum", "esse", "cum", "tamen",
  "dans", "pour", "avec", "nous", "les", "cette", "comme", "mais", "tout",
  "leur", "sont", "plus", "dieu", "vous", "etre", "aux",
  "para", "del", "por", "una", "como", "pero", "todo", "muy", "sus",
]);

export function english(text) {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (!words.length) return false;
  let hits = 0;
  let foreign = 0;
  for (const word of words) {
    if (FUNCTION_WORDS.has(word)) hits++;
    if (FOREIGN_WORDS.has(word)) foreign++;
  }
  // Three words that belong to another language outweigh any number of the
  // short ones English happens to share with it.
  if (foreign >= 3) return false;
  return hits >= (text.length >= 120 ? 3 : 1);
}

/** Known acronyms, so shouting can be told from initialisms. */
const ACRONYM = /^(?:[A-Z]{2,5}|OK|TV|USA|UK|FBI|CIA|NASA|IBM|MIT|DNA|AI|UN|EU|US)$/;

/** Is this line SHOUTING? Emphasis is fine; a wall of capitals is not. */
function shouty(text) {
  const words = text.split(/\s+/);
  let yelled = 0;
  for (const word of words) {
    const bare = word.replace(/[^A-Za-z]/g, "");
    if (bare.length >= 4 && bare === bare.toUpperCase() && !ACRONYM.test(bare)) yelled++;
  }
  return yelled;
}

function balanced(text) {
  if ((text.match(/"/g) ?? []).length % 2 !== 0) return false;
  const pairs = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of pairs) {
    let depth = 0;
    for (const ch of text) {
      if (ch === open) depth++;
      else if (ch === close && --depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  return true;
}

/**
 * Is this something a person would want to type?
 *
 * Deliberately more permissive than the sieve this file used to run over
 * novels. That one had to guess whether a random sentence was worth reading;
 * these have already been chosen by somebody who thought them worth writing
 * down. The job here is only to throw out what is broken — markup debris,
 * half-lines, captions — not to second-guess the choosing.
 *
 * In particular there is no rule against opening on a pronoun. "You can't
 * handle the truth" opens on a pronoun, and dropping it would say everything
 * about how well the filter understood its job.
 */
export function usable(text) {
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return false;
  if (!/^["'(]?[A-Z0-9]/.test(text)) return false;
  // Must end on a real sentence ending, allowing the one or two closing marks
  // a quotation inside a quotation needs. Accepting any closing bracket on its
  // own let through lines that simply stopped, mid-thought, wherever whoever
  // typed the wiki page happened to stop.
  if (!/[.!?]["')\]]{0,2}$/.test(text)) return false;
  if (!/^[\x20-\x7e]+$/.test(text)) return false;
  if (!balanced(text)) return false;
  if (JUNK.some((re) => re.test(text))) return false;
  if (forbidden(text)) return false;
  // An editor's elisions. One "..." is a pause; three is a quote that has been
  // cut to pieces, and typing it means typing the gaps.
  if ((text.match(/\.\.\./g) ?? []).length >= 3) return false;
  if (!english(text)) return false;
  if (shouty(text) >= 2) return false;

  const words = text.split(" ").filter(Boolean);
  if (words.length < 4) return false;

  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters / text.length < 0.62) return false;

  // A word that is not a word — markup that survived, or a run-on.
  if (words.some((word) => word.replace(/[^A-Za-z'-]/g, "").length > 22)) return false;

  // ALL CAPS is a heading or someone shouting a title.
  const upper = (text.match(/[A-Z]/g) ?? []).length;
  if (letters > 20 && upper / letters > 0.6) return false;
  return true;
}

/* ---- how good is it ---- */

/**
 * Word frequencies over everything harvested, used two ways below: to spot
 * markup debris that survived (a "word" seen once in the whole corpus) and to
 * reward the uncommon-but-real vocabulary this app exists to teach.
 */
function countWords(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const word of entry.text.toLowerCase().match(/[a-z']{2,}/g) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Dialogue that only means anything if you were watching at the time.
 *
 * "Did Chef seem a little trippy to you?" is a real line from a real show and
 * completely worthless out of context, while "You can't handle the truth" is
 * the same length and endures. The difference is not the pronouns — it is
 * whether the line carries its own situation. These are the tells that it does
 * not: characters addressed by name, interjections, an unanswered question
 * about something on screen, a reply to a line you cannot see.
 */
const SITUATIONAL = [
  /^(uh|um|er|hey|oh|wow|yeah|yes|no|well|so|okay|ok|hi|hello|what|huh|wait|hold on)\b[,!?. ]/i,
  /\b(you guys|come on|shut up|over here|right there|look at (that|this)|check (it|this) out)\b/i,
  /^(i|you|he|she|we|they|it)('| a|'v|'r| i| w)?\w* (just|already|never|really) /i,
];

function situational(entry) {
  const { text } = entry;
  let penalty = 0;
  if (SITUATIONAL.some((re) => re.test(text))) penalty += 26;

  // Character names: a line stuffed with them is a scene, not a quote. The
  // speaker's own name does not count against it.
  const speaker = (entry.speaker ?? "").toLowerCase();
  const words = text.split(" ");
  let names = 0;
  for (let i = 1; i < words.length; i++) {
    const bare = words[i].replace(/[^A-Za-z]/g, "");
    if (!/^[A-Z][a-z]{2,}$/.test(bare)) continue;
    if (/[.!?]["')]?$/.test(words[i - 1])) continue; // sentence start
    if (speaker.includes(bare.toLowerCase())) continue;
    names++;
  }
  penalty += names * 7;

  // A question with no answer attached is usually half an exchange.
  if (/\?$/.test(text) && text.length < 90) penalty += 12;

  // Ellipses and dashes mid-line are the sound of someone being interrupted.
  if (/\.\.\..{0,30}$/.test(text)) penalty += 8;
  return penalty;
}

/**
 * How selective the source that supplied a quote is.
 *
 * Wikiquote's film and author pages are curated — somebody decided each line
 * was worth recording. Its per-season television pages are transcripts, where
 * nobody decided anything. Both are useful, but they cannot compete on equal
 * terms, or the transcripts win on volume alone and drown the corpus in
 * dialogue that meant something only to whoever was watching.
 */
const CURATION = [
  [/quotable|famous|monkeytype|curated|proverb|speech/i, 34],
  [/film|movie/i, 24],
  [/author|people|person|literature|book/i, 22],
  [/wikisource/i, 18],
  [/tv|television|episode|season/i, 10],
  [/prose|gutenberg/i, 6],
];

function curation(file) {
  for (const [re, bonus] of CURATION) if (re.test(file)) return bonus;
  return 10;
}

/**
 * Preference, not admissibility.
 *
 * Everything scored here has already passed `usable`. This only decides the
 * order things get picked in when there is more material than room — and the
 * single most important term is the last one, because the whole point of
 * putting a typing test inside a vocabulary app is that the passages contain
 * words worth learning.
 */
function score(entry, counts) {
  let points = 0;
  const { text } = entry;
  const words = text.split(" ").filter(Boolean);
  const bare = words.map((w) => w.replace(/[^A-Za-z']/g, "")).filter(Boolean);

  // Attribution is part of the value: an unsourced line is a fortune cookie.
  if (entry.speaker) points += 4;
  if (entry.work) points += 4;
  if (entry.author) points += 2;

  // Uncommon-but-real words: the band just below common, which is exactly the
  // register a student banks. This is what makes "only quotes using my words"
  // find anything at all — and it is the single reason to prefer one otherwise
  // equal quote over another.
  //
  // Note what is NOT here: a penalty for words the corpus has seen only once.
  // That was tried, and it threw out "The unexamined life is not worth living"
  // — because *unexamined* is rare, which is precisely why the word is worth
  // meeting. Markup debris is caught by `usable`, on its shape, where it
  // belongs; rarity on its own is a recommendation, not a suspicion.
  let rich = 0;
  for (const word of bare) {
    if (word.length < 5) continue;
    const count = counts.get(word.toLowerCase()) ?? 0;
    if (count > 0 && count <= 400) rich++;
  }
  points += Math.min(6, rich) * 7;

  // Complete thoughts read better than clauses, but a famous fragment is still
  // famous, so this is a nudge rather than a gate.
  if (/[.!?]["')\]]?$/.test(text)) points += 3;
  if (/^[a-z]/.test(text)) points -= 10;

  // Length: prefer the middle of whichever bucket it lands in.
  const centre = { short: 70, medium: 180, long: 430, thicc: 780 }[bucketOf(text.length)];
  points -= Math.abs(text.length - centre) / 40;

  points += curation(entry.file ?? "");
  points -= situational(entry);

  return points;
}

/**
 * Below this, a quote is not worth the bytes however much room is left.
 *
 * Set low on purpose. The floor exists to catch the clearly bad — a line whose
 * situational penalties outweigh everything good about it — while the real
 * work of choosing is done by ranking and the per-work caps. A high floor
 * silently throws away whole categories, and a corpus that quietly lost every
 * television quote would look like it was working.
 */
const SCORE_FLOOR = 6;

/* ---- buckets ---- */

export function bucketOf(length) {
  if (length <= 100) return "short";
  if (length <= 300) return "medium";
  if (length <= 600) return "long";
  return "thicc";
}

const BUCKETS = ["short", "medium", "long", "thicc"];

/* ---- de-duplication ---- */

function fingerprint(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---- assembly ---- */

async function loadHarvests() {
  let files = [];
  try {
    files = (await readdir(CACHE)).filter((name) => name.endsWith(".json"));
  } catch {
    throw new Error(
      `no harvested sources in ${CACHE} — run "node tools/harvest-all.mjs" first`
    );
  }

  const entries = [];
  for (const file of files.sort()) {
    let rows;
    try {
      rows = JSON.parse(await readFile(`${CACHE}/${file}`, "utf8"));
    } catch (err) {
      process.stderr.write(`  ! ${file} is not readable JSON — skipped (${err.message})\n`);
      continue;
    }
    if (!Array.isArray(rows)) continue;

    let kept = 0;
    for (const row of rows) {
      const text = stripResidue(toTypeable(row?.text));
      if (!usable(text)) continue;
      const kind = KINDS.has(row?.kind) ? row.kind : "prose";
      let work = toTypeable(row?.work ?? "").slice(0, 90);
      if (SECTION_TITLE.test(work)) work = "";
      entries.push({
        text,
        speaker: toTypeable(row?.speaker ?? "").slice(0, 60),
        work,
        author: toTypeable(row?.author ?? "").slice(0, 60),
        kind,
        file,
      });
      kept++;
    }
    process.stderr.write(`  ${file.padEnd(28)} ${String(rows.length).padStart(7)} in → ${String(kept).padStart(6)} usable\n`);
  }
  return entries;
}

/**
 * Choose what ships.
 *
 * Three things are balanced here, and none of them can be left to chance.
 *
 * Length, because the four length settings are a promise: without an explicit
 * quota the short bucket wins on sheer supply — there are ninety-five thousand
 * short quotes and six thousand long ones — and "thicc" silently becomes an
 * option that matches nothing.
 *
 * Kind, because the same is true one level down. Television alone offers
 * sixty-five thousand short lines; taken on merit it would be most of the
 * corpus, and a student who asked for films and books would be reading
 * dialogue.
 *
 * And source, because Wikiquote's coverage is wildly uneven. A per-work cap
 * plus a round-robin is what stops one exhaustively-documented series filling
 * a bucket on its own.
 */
const BUCKET_SHARE = { short: 0.3, medium: 0.34, long: 0.22, thicc: 0.14 };

/**
 * How many quotes one work may contribute to one bucket.
 *
 * Long-form single works are treated differently on purpose. A cap of twelve
 * is right for a film, where a dozen memorable lines is a generous share of
 * what a film has; it is wrong for the Gettysburg Address, where every
 * paragraph is distinct argued prose and there are only a handful of famous
 * speeches in existence. Holding oratory to the film's cap left the speech
 * shelf with two hundred entries when a thousand were available.
 *
 * A page of proverbs is the same problem in miniature: "English proverbs" is
 * one page and several hundred unrelated sayings, and capping it like a film
 * left forty proverbs in the whole corpus.
 */
const WORK_CAP = { short: 8, medium: 10, long: 12, thicc: 14 };
const LONGFORM_CAP = { short: 8, medium: 14, long: 40, thicc: 45 };
const COLLECTION_CAP = { short: 90, medium: 90, long: 40, thicc: 20 };

function workCap(kind, bucket) {
  if (kind === "proverb") return COLLECTION_CAP[bucket];
  return kind === "speech" || kind === "book" ? LONGFORM_CAP[bucket] : WORK_CAP[bucket];
}

function choose(entries, counts) {
  const scored = entries
    .map((entry) => ({ ...entry, score: score(entry, counts), bucket: bucketOf(entry.text.length) }))
    .filter((entry) => entry.score >= SCORE_FLOOR)
    .sort((a, b) => b.score - a.score);
  process.stderr.write(`${scored.length} clear the quality floor\n`);

  const seen = new Set();
  const chosen = [];

  for (const bucket of BUCKETS) {
    const target = Math.round(MAX_QUOTES * BUCKET_SHARE[bucket]);

    // kind -> work -> queue of that work's best, in score order.
    const byKind = new Map();
    for (const entry of scored) {
      if (entry.bucket !== bucket) continue;
      if (!byKind.has(entry.kind)) byKind.set(entry.kind, new Map());
      const works = byKind.get(entry.kind);
      const workKey = entry.work || entry.author || entry.file;
      if (!works.has(workKey)) works.set(workKey, []);
      const queue = works.get(workKey);
      if (queue.length < workCap(entry.kind, bucket)) queue.push(entry);
    }

    const kinds = [...byKind.entries()].map(([kind, works]) => ({
      kind,
      works: [...works.values()],
      at: 0,
    }));

    let taken = 0;
    let kindIndex = 0;
    let barren = 0;
    while (taken < target && barren < kinds.length && kinds.length) {
      const lane = kinds[kindIndex % kinds.length];
      kindIndex++;

      // One from the next work in this kind, so breadth comes before depth.
      let picked = null;
      for (let tries = 0; tries < lane.works.length && !picked; tries++) {
        const queue = lane.works[lane.at % lane.works.length];
        lane.at++;
        const candidate = queue.shift();
        if (!candidate) continue;
        const key = fingerprint(candidate.text);
        if (!key || seen.has(key)) {
          tries--; // a duplicate cost us nothing; keep looking in this kind
          continue;
        }
        seen.add(key);
        picked = candidate;
      }

      if (!picked) {
        barren++;
        continue;
      }
      barren = 0;
      chosen.push(picked);
      taken++;
    }

    process.stderr.write(
      `  ${bucket.padEnd(7)} ${String(taken).padStart(5)} / ${String(target).padStart(5)} wanted\n`
    );
  }

  return chosen;
}

/* ---- emitting ---- */

/** "Book X", "Part II", "Chapter 3" name a place in a work, not a work. */
const SECTION_TITLE = /^(book|part|chapter|section|volume|act|scene|canto|letter|essay|ch|vol)\.?\s+[ivxlcdm\d]+$/i;

function sourceKey(entry) {
  return `${entry.kind} ${entry.work} ${entry.author}`;
}

async function build() {
  process.stderr.write(`reading harvests from ${CACHE}\n`);
  const entries = await loadHarvests();
  if (!entries.length) throw new Error("nothing usable was harvested");
  process.stderr.write(`\n${entries.length} usable quotes before de-duplication\n`);

  const counts = countWords(entries);
  const chosen = choose(entries, counts);

  // Sort for a readable, stable diff: by kind, then work, then text. The
  // runtime shuffles at selection time, so file order is for humans only.
  chosen.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.work || "").localeCompare(b.work || "") ||
      a.text.localeCompare(b.text)
  );

  const sources = [];
  const sourceIndex = new Map();
  for (const entry of chosen) {
    const key = sourceKey(entry);
    if (!sourceIndex.has(key)) {
      sourceIndex.set(key, sources.length);
      sources.push([entry.work, entry.author, entry.kind]);
    }
  }

  const rows = chosen.map((entry) => {
    const index = sourceIndex.get(sourceKey(entry));
    // The speaker is only carried when there is one; two thirds of the corpus
    // has no character to name, and an empty third element in every row is
    // sixty thousand wasted bytes.
    return entry.speaker ? [entry.text, index, entry.speaker] : [entry.text, index];
  });

  const byBucket = {};
  const byKind = {};
  for (const entry of chosen) {
    byBucket[entry.bucket] = (byBucket[entry.bucket] ?? 0) + 1;
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }

  const kindLine = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
  const bucketLine = BUCKETS.map((name) => `${byBucket[name] ?? 0} ${name}`).join(", ");

  const header = `/**
 * The quote corpus: ${rows.length} quotes from ${sources.length} sources.
 *
 * ${kindLine}.
 * By length: ${bucketLine}.
 *
 * Generated by tools/build-quotes.mjs from the harvesters in tools/harvest/ —
 * edit those, not this. Every quote is plain ASCII with straight quotes, so it
 * can be typed on any keyboard without a dead-key detour.
 *
 * SOURCES holds [work, author, kind]; each row of QUOTES is
 * [text, sourceIndex] or [text, sourceIndex, speaker]. The indirection is not
 * premature: repeating "The Godfather" a dozen times would cost more than the
 * quotes themselves.
 */\n\n`;

  await mkdir(new URL("../src/data/", import.meta.url).pathname, { recursive: true });
  await writeFile(
    OUT_QUOTES,
    `${header}export const SOURCES = [\n${sources.map((s) => `  ${JSON.stringify(s)},`).join("\n")}\n];\n\nexport const QUOTES = [\n${rows.map((r) => `  ${JSON.stringify(r)},`).join("\n")}\n];\n`
  );

  await writeWordList(chosen);

  process.stderr.write(`\n${rows.length} quotes from ${sources.length} sources\n`);
  process.stderr.write(`  by kind:   ${kindLine}\n`);
  process.stderr.write(`  by length: ${bucketLine}\n`);
  if (VERBOSE) {
    for (const bucket of BUCKETS) {
      const sample = chosen.filter((entry) => entry.bucket === bucket).slice(0, 3);
      process.stderr.write(`\n  ${bucket}:\n`);
      for (const entry of sample) {
        process.stderr.write(`    · ${entry.text.slice(0, 110)}\n      ~ ${entry.speaker || entry.author || entry.work}\n`);
      }
    }
  }
}

/**
 * The thousand commonest words in the corpus that actually ships, for the
 * timed and word-count modes.
 *
 * Drawn from the quotes rather than from a general frequency table on purpose:
 * these are the words that surround the sentences a lexis typist is already
 * practising, so the two modes share a register instead of feeling like two
 * different apps.
 */
async function writeWordList(chosen) {
  const counts = new Map();
  for (const entry of chosen) {
    for (const word of entry.text.toLowerCase().match(/[a-z']+/g) ?? []) {
      const clean = word.replace(/^'+|'+$/g, "");
      if (clean.length >= 2) counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
  }
  const stopShort = new Set(["s", "t", "d", "ll", "re", "ve", "m"]);
  const words = [...counts.entries()]
    .filter(([word, n]) => n >= 12 && /^[a-z][a-z']*[a-z]$/.test(word) && !stopShort.has(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 1000)
    .map(([word]) => word);

  await writeFile(
    new URL("../src/data/words.js", import.meta.url).pathname,
    `/**
 * The thousand commonest words in the shipped quote corpus, most frequent
 * first. Generated by tools/build-quotes.mjs.
 *
 * Taken from the quotes themselves rather than from a general frequency list:
 * the timed and word-count modes should read like the same app as the quote
 * mode, and a word list for a vocabulary app may as well share its register.
 */

export const COMMON_WORDS = [
${words.map((word) => `  ${JSON.stringify(word)},`).join("\n")}
];
`
  );
  process.stderr.write(`  ${words.length} common words\n`);
}

// Importable for tests; runs when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) await build();
