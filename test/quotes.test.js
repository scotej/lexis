/**
 * The quote corpus and the filters over it.
 *
 * The corpus itself is generated and committed, so it is worth asserting on
 * directly: a build that silently produced two hundred quotes, or let a curly
 * apostrophe through, would otherwise only be discovered by someone typing a
 * character their keyboard cannot make.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_KINDS,
  QUOTE_LENGTHS,
  attribution,
  attributionText,
  bankWordsIn,
  createBankMatcher,
  createQuotePool,
  filterQuotes,
  loadCorpus,
  quoteLength,
} from "../src/core/quotes.js";

const corpus = await loadCorpus();

/* ---- the corpus ---- */

test("the corpus is large, attributed, and covers every length", () => {
  assert.ok(corpus.length >= 12000, `only ${corpus.length} quotes`);
  for (const name of QUOTE_LENGTHS) {
    const count = corpus.filter((q) => q.length === name).length;
    assert.ok(count >= 1500, `only ${count} ${name} quotes`);
  }
  assert.ok(corpus.every((q) => attributionText(q)), "every quote says where it came from");
  assert.ok(corpus.every((q) => QUOTE_KINDS.includes(q.kind)), "every quote has a known kind");
});

test("every shelf has enough on it to be worth choosing", () => {
  // The shelf filter is a promise too: an option that matches four quotes is
  // worse than no option, because it looks like the feature is broken.
  const counts = {};
  for (const quote of corpus) counts[quote.kind] = (counts[quote.kind] ?? 0) + 1;
  for (const kind of ["film", "tv", "book", "person"]) {
    assert.ok(counts[kind] >= 1000, `${kind} shelf has only ${counts[kind] ?? 0}`);
  }
  assert.ok(counts.speech >= 100, `speech shelf has only ${counts.speech ?? 0}`);
});

test("it is drawn from a very wide shelf, and no one work dominates", () => {
  const works = new Map();
  for (const quote of corpus) {
    const key = `${quote.kind}:${quote.work || quote.author}`;
    works.set(key, (works.get(key) ?? 0) + 1);
  }
  assert.ok(works.size >= 2000, `only ${works.size} distinct sources`);
  const biggest = Math.max(...works.values());
  assert.ok(biggest <= corpus.length * 0.02, `one source supplies ${biggest} quotes`);
});

test("screen quotes name who said them", () => {
  const screen = corpus.filter((q) => q.kind === "film" || q.kind === "tv");
  const named = screen.filter((q) => q.speaker).length;
  assert.ok(named / screen.length > 0.5, `only ${Math.round((named / screen.length) * 100)}% name a speaker`);
  // A speaker is a character, not a section heading that wandered in.
  const suspect = screen.filter((q) => /\b(quotes?|dialogue|novels?|series|cast)\b/i.test(q.speaker));
  assert.deepEqual(suspect.slice(0, 3).map((q) => q.speaker), []);
});

test("nothing in it is a stage direction, a citation, or another language", () => {
  const directions = corpus.filter((q) => /\[[^\]]+\]/.test(q.text));
  assert.deepEqual(directions.slice(0, 3).map((q) => q.text), [], "square-bracket stage directions");

  const citations = corpus.filter((q) => /\((?:pp?\.?\s?)?\d+(?:\s*[-\u2013]\s*\d+)?\)$/.test(q.text));
  assert.deepEqual(citations.slice(0, 3).map((q) => q.text), [], "trailing page citations");

  // Independent of how the builder decides this, so the two cannot drift into
  // agreeing with each other and being wrong together: Wikiquote prints the
  // original beside the translation, and stripped of its accents German is
  // perfectly good ASCII. Look for the other language's own function words.
  // Only words English does not also use: "die" and "est" and "con" are all
  // perfectly good English, and a list containing them flags Cormac McCarthy.
  const FOREIGN =
    /\b(der|und|nicht|ich|aber|sich|werden|dass|von|mit|auf|sind|wenn|oder|einen|quod|enim|atque|autem|nihil|ipsum|dans|pour|avec|nous|cette|comme|mais|leur|sont|vous|para|del|por|una|como|pero)\b/i;
  // A single such word can be a loan; three is another language.
  const foreign = corpus.filter((q) => (q.text.match(new RegExp(FOREIGN, "gi")) ?? []).length >= 3);
  assert.deepEqual(foreign.slice(0, 3).map((q) => q.text), [], "not English");
});

test("every passage can be typed on a plain keyboard", () => {
  const offenders = corpus.filter((q) => !/^[\x20-\x7e]+$/.test(q.text));
  assert.deepEqual(offenders.slice(0, 3).map((q) => q.text), [], "non-ASCII passages");

  const curly = corpus.filter((q) => /[“”‘’—…]/.test(q.text));
  assert.equal(curly.length, 0, "typographic punctuation nobody can type");
});

test("no passage is repeated, and none is a fragment", () => {
  const seen = new Set(corpus.map((q) => q.text.toLowerCase()));
  assert.equal(seen.size, corpus.length, "duplicate passages");
  // Two closing marks, because a quotation inside a quotation legitimately
  // ends `..."'` and stopping at one would call that a fragment.
  assert.ok(
    corpus.every((q) => /^["'(]?[A-Z0-9]/.test(q.text) && /[.!?]["')\]]{0,2}$/.test(q.text)),
    "every passage is a whole sentence or more"
  );
});

test("length classes are the advertised character counts", () => {
  assert.equal(quoteLength("x".repeat(100)), "short");
  assert.equal(quoteLength("x".repeat(101)), "medium");
  assert.equal(quoteLength("x".repeat(300)), "medium");
  assert.equal(quoteLength("x".repeat(301)), "long");
  assert.equal(quoteLength("x".repeat(600)), "long");
  assert.equal(quoteLength("x".repeat(601)), "thicc");
  assert.ok(corpus.every((q) => q.length === quoteLength(q.text)));
});

/* ---- the bank filter ---- */

const quote = (text, id = text) => ({ id, text, length: quoteLength(text), work: "", author: "", kind: "prose" });

test("a bank word is found through its ordinary inflections", () => {
  const matcher = createBankMatcher(["demise", "vilify"]);
  assert.deepEqual([...matcher.match("The demise of the house.")], ["demise"]);
  assert.deepEqual([...matcher.match("Papers that vilified him.")], ["vilify"]);
  assert.deepEqual([...matcher.match("Nothing of the sort.")], []);
});

test("a token belongs to one headword, the way the essay checker assigns it", () => {
  const matcher = createBankMatcher(["fervent", "fervently"]);
  assert.deepEqual([...matcher.match("She argued fervently.")], ["fervently"]);
});

test("filtering by my words keeps only passages that use them", () => {
  const matcher = createBankMatcher(["whale"]);
  const quotes = [quote("The whale surfaced beside us."), quote("Nothing happened at all.")];
  const kept = filterQuotes(quotes, { bankMatcher: matcher, minBankWords: 1 });
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].bankWords, ["whale"]);
});

test("asking for two of my words excludes a passage that only has one", () => {
  const matcher = createBankMatcher(["whale", "harpoon"]);
  const one = quote("The whale surfaced beside us.");
  const two = quote("The harpoon found the whale at last.");
  assert.deepEqual(
    filterQuotes([one, two], { bankMatcher: matcher, minBankWords: 2 }).map((q) => q.text),
    [two.text]
  );
});

test("with the filter off, matches are worked out for the one quote that needs them", () => {
  const matcher = createBankMatcher(["whale"]);
  const kept = filterQuotes([quote("The whale surfaced.")], { bankMatcher: matcher, minBankWords: 0 });
  // Deliberately unanswered for the whole corpus: the result screen asks about
  // the single passage that was typed, not about the twenty thousand that
  // weren't.
  assert.equal(kept[0].bankWords, null);
  assert.deepEqual(bankWordsIn(kept[0], matcher), ["whale"]);
});

test("a quote the filter already answered for is not worked out twice", () => {
  const matcher = createBankMatcher(["whale"]);
  const [kept] = filterQuotes([quote("The whale surfaced.")], { bankMatcher: matcher, minBankWords: 1 });
  assert.deepEqual(kept.bankWords, ["whale"]);
  assert.equal(bankWordsIn(kept, matcher), kept.bankWords, "the same array, not a fresh scan");
});

test("asking about a bankless matcher is not an error", () => {
  assert.deepEqual(bankWordsIn(quote("Anything."), createBankMatcher([])), []);
  assert.deepEqual(bankWordsIn(null, createBankMatcher(["whale"])), []);
});

test("length and bank filters compose", () => {
  const matcher = createBankMatcher(["whale"]);
  const short = quote("The whale surfaced.");
  const medium = quote(`The whale surfaced beside us. ${"It was vast. ".repeat(9)}`);
  const kept = filterQuotes([short, medium], {
    lengths: ["medium"],
    bankMatcher: matcher,
    minBankWords: 1,
  });
  assert.deepEqual(kept.map((q) => q.length), ["medium"]);
});

test("an empty bank does not filter everything away", () => {
  const matcher = createBankMatcher([]);
  const quotes = [quote("One."), quote("Two.")];
  assert.equal(filterQuotes(quotes, { bankMatcher: matcher, minBankWords: 1 }).length, 2);
});

test("a real bank finds a usable run of passages in the corpus", () => {
  // Two hundred thousand words of prose is a lot of typing and not much of a
  // concordance: an individual word turns up a handful of times, so the filter
  // is worth having at twenty words and thin below that. That is the honest
  // ceiling of a shipped corpus, and precisely what AI generation is for.
  const bank = [
    "demise", "solitude", "ambition", "resolve", "candour", "fervent", "austere",
    "profound", "vindicate", "lament", "sombre", "tenuous", "pervade", "discern",
    "render", "convey", "embody", "evoke", "undermine", "futile",
  ];
  const kept = filterQuotes(corpus, { bankMatcher: createBankMatcher(bank), minBankWords: 1 });
  assert.ok(kept.length >= 60, `only ${kept.length} passages use a twenty-word bank`);
});

/* ---- the shuffle bag ---- */

test("every passage is served before any is served twice", () => {
  const quotes = [quote("a"), quote("b"), quote("c"), quote("d")];
  const pool = createQuotePool(quotes, () => 0.5);
  const first = [pool.next(), pool.next(), pool.next(), pool.next()].map((q) => q.id);
  assert.deepEqual([...first].sort(), ["a", "b", "c", "d"]);
});

test("a new bag never opens with the passage that closed the last one", () => {
  const quotes = [quote("a"), quote("b"), quote("c")];
  const pool = createQuotePool(quotes, () => 0.99);
  let previous = null;
  for (let i = 0; i < 30; i++) {
    const next = pool.next();
    assert.notEqual(next.id, previous, "the same passage twice in a row");
    previous = next.id;
  }
});

test("an empty pool answers null instead of throwing", () => {
  assert.equal(createQuotePool([]).next(), null);
});

test("replacing the pool takes effect at the next draw", () => {
  const pool = createQuotePool([quote("a")]);
  pool.next();
  pool.replace([quote("z")]);
  assert.equal(pool.next().id, "z");
});


/* ---- saying where it came from ---- */

test("a film line belongs to its character first and its film second", () => {
  const line = {
    kind: "film",
    speaker: "Vito Corleone",
    work: "The Godfather",
    author: "Francis Ford Coppola",
  };
  assert.deepEqual(attribution(line), [
    { text: "Vito Corleone", style: "plain" },
    { text: "The Godfather", style: "work" },
  ]);
  assert.equal(attributionText(line), "Vito Corleone, The Godfather");
});

test("a book belongs to its title first and its author second", () => {
  assert.deepEqual(attribution({ kind: "book", work: "Nineteen Eighty-Four", author: "George Orwell" }), [
    { text: "Nineteen Eighty-Four", style: "work" },
    { text: "George Orwell", style: "plain" },
  ]);
});

test("a speech belongs to whoever stood up and gave it", () => {
  assert.equal(
    attributionText({ kind: "speech", speaker: "Martin Luther King Jr.", work: "I Have a Dream" }),
    "Martin Luther King Jr., I Have a Dream"
  );
});

test("a person needs no work, and is not credited twice when the work is their name", () => {
  assert.equal(attributionText({ kind: "person", author: "Oscar Wilde" }), "Oscar Wilde");
  assert.equal(attributionText({ kind: "person", author: "Oscar Wilde", work: "Oscar Wilde" }), "Oscar Wilde");
});

test("a proverb says so when it has nothing else to say", () => {
  assert.equal(attributionText({ kind: "proverb", work: "" }), "proverb");
  assert.equal(attributionText({ kind: "proverb", work: "English proverbs" }), "English proverbs");
});

test("an unattributed passage produces no credit rather than a stray comma", () => {
  assert.deepEqual(attribution({ kind: "prose" }), []);
  assert.equal(attributionText(null), "");
});

test("titles are marked for italics and names are not", () => {
  const styles = attribution({ kind: "tv", speaker: "Omar Little", work: "The Wire" }).map((s) => s.style);
  assert.deepEqual(styles, ["plain", "work"]);
});

/* ---- filtering by shelf ---- */

const shelved = (text, kind) => ({ ...quote(text, `${kind}:${text}`), kind });

test("the shelf filter keeps only the kinds asked for", () => {
  const quotes = [
    shelved("A line from a film.", "film"),
    shelved("A line from a show.", "tv"),
    shelved("A line from a book.", "book"),
  ];
  assert.deepEqual(
    filterQuotes(quotes, { kinds: ["film", "book"] }).map((q) => q.kind),
    ["film", "book"]
  );
});

test("no shelves named means every shelf, not none", () => {
  const quotes = [shelved("One.", "film"), shelved("Two.", "tv")];
  assert.equal(filterQuotes(quotes, { kinds: [] }).length, 2);
  assert.equal(filterQuotes(quotes, {}).length, 2);
});

test("shelf and length and bank filters all compose", () => {
  const matcher = createBankMatcher(["whale"]);
  const shortFilm = shelved("The whale surfaced.", "film");
  const mediumFilm = { ...shelved(`The whale surfaced beside us. ${"It was vast. ".repeat(9)}`, "film") };
  const mediumBook = { ...shelved(`The whale surfaced beside us. ${"It was huge. ".repeat(9)}`, "book") };
  const kept = filterQuotes([shortFilm, mediumFilm, mediumBook], {
    lengths: ["medium"],
    kinds: ["film"],
    bankMatcher: matcher,
    minBankWords: 1,
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kind, "film");
});
