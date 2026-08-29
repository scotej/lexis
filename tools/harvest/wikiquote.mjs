/**
 * Harvests quotes from English Wikiquote.
 *
 *   node tools/harvest/wikiquote.mjs [--only films|shows|books|people|speeches|topics]
 *
 * Wikiquote is the right source for this because it is *curated*: a line is on
 * a page because a person decided it was worth writing down. That is the one
 * property a scrape of novels or a dump of subtitles can never have, and it is
 * the whole difference between a corpus of quotes and a corpus of sentences.
 *
 * What it is not is uniform. Film pages, television season pages, author pages
 * and topic pages are four different documents wearing the same wiki markup,
 * so most of this file is knowing which one it is holding.
 *
 * Output: one `.quote-cache/wikiquote-<shelf>.json` per shelf, as a flat array
 * of `{ text, speaker, work, author, kind }`. tools/build-quotes.mjs decides
 * what ships; this only goes and gets it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { english } from "../build-quotes.mjs";
import { BOOKS, FILMS, PEOPLE, SHOWS, SPEECHES, TOPICS } from "./shelves.mjs";

const CACHE = new URL("../../.quote-cache/", import.meta.url).pathname;
const RAW = `${CACHE}raw/`;
const API = "https://en.wikiquote.org/w/api.php";
const UA = "lexis-quote-harvester/1.0 (https://github.com/scotej/lexis)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- fetching ---- */

/**
 * Wikitext for up to fifty pages at a time.
 *
 * Fifty is the anonymous API's own limit, and it is worth using in full: the
 * request is the expensive part, not the bytes. Responses are cached on disk
 * so a re-run after a parser change costs nothing and Wikiquote is asked once.
 */
async function fetchBatch(titles) {
  const params = new URLSearchParams({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    format: "json",
    formatversion: "2",
    redirects: "1",
    titles: titles.join("|"),
  });

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const resp = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const out = new Map();
      for (const page of data?.query?.pages ?? []) {
        const text = page?.revisions?.[0]?.slots?.main?.content;
        if (typeof text === "string" && !page.missing) out.set(page.title, text);
      }
      return out;
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(700 * attempt);
    }
  }
  return new Map();
}

async function fetchPages(titles, label) {
  const cachePath = `${RAW}${label}.json`;
  let cached = {};
  try {
    cached = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    /* first run */
  }

  const wanted = titles.filter((title) => !(title in cached));
  for (let i = 0; i < wanted.length; i += 50) {
    const batch = wanted.slice(i, i + 50);
    const got = await fetchBatch(batch);
    for (const title of batch) cached[title] = got.get(title) ?? null;
    // Also file anything a redirect landed on under its own name.
    for (const [title, text] of got) cached[title] ??= text;
    process.stderr.write(`\r  ${label}: ${Math.min(i + 50, wanted.length)}/${wanted.length} fetched`);
    await sleep(120); // Wikiquote is a charity; this is politeness, not a limit
  }
  if (wanted.length) process.stderr.write("\n");

  await mkdir(RAW, { recursive: true });
  await writeFile(cachePath, JSON.stringify(cached));
  return cached;
}

/**
 * The season and episode subpages a series page links to.
 *
 * There are at least four naming conventions in live use — "Breaking Bad
 * (season 5)", "The Simpsons/Season 5", "The Sopranos: Season 1", "Blackadder
 * II (series 2)" — so these are never guessed. They are read off the links the
 * series page itself makes, which is the only thing that is always right.
 */
function subpagesOf(title, wikitext) {
  const found = new Set();
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`\\[\\[(${escaped}[^\\]|#]*)(?:\\|[^\\]]*)?\\]\\]`, "g");
  for (const match of wikitext.matchAll(link)) {
    const target = match[1].trim();
    if (target === title) continue;
    if (!/season|series|\/|episode/i.test(target)) continue;
    found.add(target);
  }
  return [...found].slice(0, 30); // a long-running show is not worth 200 pages
}

/**
 * The page a disambiguation stub actually meant.
 *
 * "Frankenstein" and "To Kill a Mockingbird" are not quote pages at all — they
 * are nine-hundred-character stubs listing the novel, the 1931 film and the
 * 2025 film. Harvested as-is they contribute nothing, which is how two set
 * texts came to be missing from a corpus built for an English student.
 *
 * `prefer` is tried in order, so the book shelf follows the novel and the film
 * shelf follows the film.
 */
function disambiguationTarget(title, wikitext, prefer) {
  if (!/\{\{\s*disambig/i.test(wikitext) && wikitext.length > 2000) return null;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const links = [...wikitext.matchAll(new RegExp(`\\[\\[(${escaped} \\([^)\\]]+\\))(?:\\|[^\\]]*)?\\]\\]`, "g"))].map(
    (match) => match[1]
  );
  if (!links.length) return null;
  for (const want of prefer) {
    const hit = links.find((link) => link.toLowerCase().includes(`(${want}`));
    if (hit) return hit;
  }
  return null;
}

/* ---- wikitext ---- */

const SKIP_SECTION =
  /^(external links?|see also|references?|notes?|sources?|bibliograph|further reading|cast|credits|voice cast|about|quotes about|misattributed|disputed|unsourced|attributed|external|contents|categories|see|other|links)/i;

/**
 * Does this heading name a person who could have said the line?
 *
 * Film and television pages group quotes under the character who speaks them,
 * which is where most of the speaker attribution comes from — but they also
 * group them under "Dialogue", "Taglines", and "Frank Herbert novels", and a
 * heading is only a speaker if it reads like a name. One to four capitalised
 * words, allowing the particles real names contain.
 */
const PARTICLE = /^(de|del|della|da|van|von|der|the|of|and|bin|al|ibn|le|la|du|mac|mc|st\.?)$/i;

function looksLikeName(heading) {
  const text = heading.trim();
  if (!text || text.length > 42) return false;
  if (/^(quotes?|dialogue|dialog|taglines?|cast|plot|synopsis|songs?|lyrics|main|other|misc|trivia|production|reception|episodes?|season|series|part|act|scene|chapter|book|about|external)\b/i.test(text)) {
    return false;
  }
  // A heading naming a body of work, not a person.
  if (/\b(novels?|films?|series|quotes|works?|stories|books?|episodes?|seasons?|adaptations?)\b/i.test(text)) {
    return false;
  }
  const words = text.split(/\s+/);
  if (words.length > 4) return false;
  return words.every((word, i) => {
    const bare = word.replace(/[^A-Za-z.'-]/g, "");
    if (!bare) return false;
    if (i > 0 && PARTICLE.test(bare)) return true;
    return /^[A-Z]/.test(bare);
  });
}

function stripMarkup(raw) {
  return String(raw)
    .replace(/<ref[^>]*\/>/gi, " ")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:small|big|i|b|em|strong|span|div|poem|nowiki|blockquote|center|sup|sub)[^>]*>/gi, " ")
    // [[target|display]] and [[target]]
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    // [http://example.com display]
    .replace(/\[(?:https?|\/\/)[^\s\]]*\s+([^\]]*)\]/g, "$1")
    .replace(/\[(?:https?|\/\/)[^\]]*\]/g, " ")
    // {{template}}, innermost first so nested ones unwind
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/'''''|'''|''/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    // Stage directions: an aside written entirely in lower case is a note to
    // the reader, not part of the line. Capitalised parentheses are left alone,
    // because "(1949)" and "(New York)" are not directions.
    .replace(/\((?:[a-z][a-z' ,]{2,50})\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "'''Vito''': line", "Vito: line", "Vito Corleone: line". */
function splitSpeaker(text) {
  const match = /^([A-Z][A-Za-z.'’-]*(?: [A-Z][A-Za-z.'’-]*){0,3})\s*:\s+(.+)$/.exec(text);
  if (!match) return { speaker: "", text };
  const [, speaker, rest] = match;
  // "Note: ..." and "Warning: ..." are not people.
  if (/^(note|source|from|see|quote|translation|variant|also|cf|context|original)$/i.test(speaker)) {
    return { speaker: "", text };
  }
  if (rest.length < 20) return { speaker: "", text };
  return { speaker, text: rest };
}

/** A page's own idea of who wrote the work, from its opening sentence. */
function authorFromIntro(wikitext) {
  const intro = stripMarkup(wikitext.slice(0, 1200));
  const match =
    /\bby (?:the )?(?:English|American|Irish|Scottish|Australian|French|German|Russian|Nigerian|Canadian|Japanese|Italian|Spanish|Indian|Chilean|Colombian)?\s*(?:novelist|writer|author|poet|playwright|philosopher|essayist|dramatist|journalist)?\s*((?:[A-Z][A-Za-z'-]*\.?)(?: [A-Z][A-Za-z'-]*\.?){0,3})/.exec(
      intro
    );
  if (!match) return "";
  // A name may contain initials ("W. E. B. Du Bois") but not a full stop that
  // ends a sentence — without this, "by Aldous Huxley. Set in London" is read
  // as an author called "Aldous Huxley. Set".
  const words = match[1].trim().split(/\s+/);
  const kept = [];
  for (const word of words) {
    kept.push(word);
    if (word.endsWith(".") && word.replace(/[^A-Za-z]/g, "").length > 1) {
      kept[kept.length - 1] = word.slice(0, -1);
      break;
    }
  }
  return kept.join(" ").trim();
}

/**
 * Every quote on one page.
 *
 * A quote is a top-level bullet. Deeper bullets are the citation beneath it —
 * which is exactly where an author page keeps the name of the book a line came
 * from, so they are read rather than discarded.
 */
export function parseQuotePage({
  title,
  wikitext,
  kind,
  work,
  author,
  speakerFromSection = false,
  allowIndented = false,
}) {
  const out = [];
  let section = "";
  let subsection = "";
  let skipping = false;
  // On a person's page the page is the author — which sounds obvious and was
  // not being done, so every quote from Oscar Wilde's page arrived credited to
  // the play it came from and to nobody at all.
  const pageAuthor =
    author || (kind === "person" ? title : kind === "book" ? authorFromIntro(wikitext) : "");

  const lines = wikitext.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const name = stripMarkup(heading[2]);
      if (level === 2) {
        section = name;
        subsection = "";
      } else {
        subsection = name;
      }
      skipping = SKIP_SECTION.test(section) || SKIP_SECTION.test(subsection);
      continue;
    }
    if (skipping) continue;

    // Two markup traditions live side by side on Wikiquote, and a parser that
    // knows only one of them silently loses whole shelves. Prose pages bullet
    // their quotes with "*"; television episode pages indent dialogue with ":"
    // and put the character in bold. Reading only bullets returned a thousand
    // television quotes where there were sixty thousand — which looks like a
    // thin source rather than like a bug, which is what makes it worth a note.
    const bullet = /^\*[^*]/.test(line);
    const dialogue = /^:+\s*'''/.test(line) || (allowIndented && /^:[^:*]/.test(line));
    if (!bullet && !dialogue) continue;

    // An image caption is not a quote, however quotable the caption is.
    if (/^\s*\[\[(?:File|Image):/i.test(line)) continue;

    const cleaned = stripMarkup(line.replace(/^[:*]+\s*/, ""));
    if (cleaned.length < 20) continue;

    // The indented bullets under this one are its citation — and sometimes
    // the quote itself.
    let citation = "";
    const notes = [];
    for (let j = i + 1; j < lines.length && /^\*{2,}/.test(lines[j]); j++) {
      const note = stripMarkup(lines[j].replace(/^\*+\s*/, ""));
      if (!note) continue;
      notes.push(note);
      if (!citation) citation = note;
    }

    // Some pages are upside down. On "Latin proverbs" the bullet holds the
    // Latin and the English sits underneath as "English equivalent: ...", and
    // Voltaire, Marx, Ibsen and Spinoza are quoted in the original with the
    // translation indented below. Taking the bullet blindly means harvesting a
    // language nobody asked to type — and since the corpus builder then throws
    // out anything that is not English, the effect was not a page of Latin but
    // a page of nothing.
    let quoteText = cleaned;
    if (!english(cleaned)) {
      const translation = notes.find(
        (note) => /^(english|translation|trans\.?)\b/i.test(note) && english(note)
      );
      const fallback = translation ?? notes.find((note) => note.length > 25 && english(note));
      if (!fallback) continue;
      quoteText = fallback.replace(/^(?:english (?:equivalent|translation)|translation|trans\.?)\s*[:-]\s*/i, "");
    }

    const split = splitSpeaker(quoteText);
    let speaker = split.speaker;
    if (!speaker && speakerFromSection) {
      if (looksLikeName(subsection)) speaker = subsection;
      else if (looksLikeName(section)) speaker = section;
    }

    // On an author page the sub-heading is usually the work a quote is from,
    // and the citation beneath it names the work when the heading does not.
    let quoteWork = work;
    let quoteAuthor = pageAuthor;
    if (kind === "person") {
      const candidate = subsection && !/^(quotes?|sourced|misc)/i.test(subsection) ? subsection : "";
      quoteWork = candidate || workFromCitation(citation) || "";
    }

    // A topic page is a shelf of other people's lines about a theme, so the
    // theme is not the attribution — the citation under the quote is. Without
    // one there is nobody to credit, and an uncredited quote is a fortune
    // cookie however good it sounds.
    // A topic page is a shelf of other people's lines about a theme, so the
    // theme is not the attribution — the citation under the quote is. And once
    // a citation has named somebody, the quote is that person's, not a
    // proverb: filing Nietzsche on "Ambition" under "proverbs" would be wrong
    // in the corpus and wrong on the shelf filter.
    let quoteKind = kind;
    if (kind === "proverb") {
      quoteAuthor = authorFromCitation(citation);
      if (quoteAuthor) {
        quoteKind = "person";
        quoteWork = "";
      } else {
        if (!/proverb/i.test(title)) continue;
        quoteWork = title;
      }
    }

    out.push({
      text: split.text,
      speaker: speaker.slice(0, 60),
      // A topic page's title is a theme, not a work. Once the citation has
      // named an author, falling back to the theme would credit T. S. Eliot
      // with having written something called "Ambition".
      work: (quoteWork || (quoteKind === "person" && quoteAuthor ? "" : title)).slice(0, 90),
      author: quoteAuthor,
      kind: quoteKind,
    });
  }
  return out;
}

/**
 * A person's name out of a citation line.
 *
 * Topic pages cite as "Oscar Wilde, Lady Windermere's Fan (1892)" or
 * "Attributed to Mark Twain". Take the leading name-shaped run and nothing
 * else; a citation that opens with a title rather than a person yields
 * nothing, which is the right answer.
 */
function authorFromCitation(citation) {
  if (!citation) return "";
  const head = citation.replace(/^(?:attributed to|as quoted in|quoted in|in)\s+/i, "").trim();
  const match = /^([A-Z][A-Za-z.'-]+(?: (?:de|van|von|del|la|le))?(?: [A-Z][A-Za-z.'-]+){1,3})\b/.exec(head);
  if (!match) return "";
  const name = match[1].trim();
  if (name.length < 5 || name.length > 42) return "";
  // A run of capitalised words can just as easily be a title.
  if (/\b(the|a|an|of|and|for|in|on)\b/i.test(name)) return "";
  // "Napoleon I. Quotes" is a page name that wandered into a citation.
  if (/\b(quotes?|wikiquote|wikipedia|interview|letter|speech|essay)\b/i.test(name)) return "";
  return name;
}

/** A title out of a citation line: "The Sea and the Mirror (1944), part II". */
function workFromCitation(citation) {
  if (!citation) return "";
  const head = citation.split(/,| - |;/)[0].trim();
  if (head.length < 3 || head.length > 70) return "";
  if (!/^[A-Z"']/.test(head)) return "";
  if (/^\d/.test(head)) return "";
  return head;
}

/* ---- shelves ---- */

async function harvestShelf({
  label,
  titles,
  kind,
  speakerFromSection = false,
  expand = false,
  allowIndented = false,
  claimed = new Set(),
  prefer = ["novel", "book", "play", "film"],
}) {
  process.stderr.write(`${label}: ${titles.length} pages\n`);
  let pages = await fetchPages(titles, label);

  // A disambiguation stub is a signpost, not a page. Follow it.
  const redirects = new Map();
  for (const [title, text] of Object.entries(pages)) {
    if (!text) continue;
    const target = disambiguationTarget(title, text, prefer);
    if (target && !(target in pages)) redirects.set(title, target);
  }
  if (redirects.size) {
    process.stderr.write(`  + ${redirects.size} disambiguation pages followed\n`);
    const resolved = await fetchPages([...redirects.values()], `${label}-disambig`);
    pages = { ...pages, ...resolved };
    // The stub itself has nothing on it worth keeping.
    for (const stub of redirects.keys()) delete pages[stub];
  }

  // Television lives on season subpages; the series page is mostly a table of
  // contents, so follow its own links to find them.
  if (expand) {
    const extra = new Set();
    for (const [title, text] of Object.entries(pages)) {
      if (!text) continue;
      for (const sub of subpagesOf(title, text)) extra.add(sub);
    }
    const subs = [...extra].filter((title) => !(title in pages));
    if (subs.length) {
      process.stderr.write(`  + ${subs.length} season pages\n`);
      pages = { ...pages, ...(await fetchPages(subs, `${label}-seasons`)) };
    }
  }

  const quotes = [];
  let skipped = 0;
  for (const [title, wikitext] of Object.entries(pages)) {
    if (!wikitext) continue;
    if (claimed.has(title)) {
      skipped++;
      continue;
    }
    claimed.add(title);
    // A season page belongs to its series, not to itself.
    const work = title.replace(/\s*[(/:].*$/, "").trim();
    quotes.push(
      ...parseQuotePage({ title, wikitext, kind, work, speakerFromSection, allowIndented })
    );
  }

  await mkdir(CACHE, { recursive: true });
  await writeFile(`${CACHE}wikiquote-${label}.json`, JSON.stringify(quotes));
  process.stderr.write(
    `  → ${quotes.length} raw quotes${skipped ? ` (${skipped} pages already claimed by an earlier shelf)` : ""}\n\n`
  );
  return quotes.length;
}

/**
 * Order matters. A page can be reached from more than one shelf — "1984" on
 * the film shelf redirects to "Nineteen Eighty-Four", which is the novel — and
 * whichever shelf gets there first decides how every quote on it is filed. The
 * canonical shelves therefore go first and claim their pages, so Orwell is a
 * book rather than a film.
 */
const SHELVES = {
  books: { titles: BOOKS, kind: "book", speakerFromSection: false },
  people: { titles: PEOPLE, kind: "person", speakerFromSection: false },
  speeches: { titles: SPEECHES, kind: "speech", speakerFromSection: false },
  films: {
    titles: FILMS,
    kind: "film",
    speakerFromSection: true,
    allowIndented: true,
    prefer: ["film", "novel", "play"],
  },
  // Not speakerFromSection: a television section heading is an episode title,
  // so "Lessons" would become a character. Dialogue lines name their own
  // speaker, so insisting on that costs nothing here.
  shows: { titles: SHOWS, kind: "tv", expand: true, allowIndented: true },
  topics: { titles: TOPICS, kind: "proverb", speakerFromSection: false },
};

async function main() {
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : null;

  let total = 0;
  const claimed = new Set();
  for (const [label, shelf] of Object.entries(SHELVES)) {
    if (only && only !== label) continue;
    total += await harvestShelf({ label, ...shelf, claimed });
  }
  process.stderr.write(`${total} raw quotes harvested into ${CACHE}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
