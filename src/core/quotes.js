/**
 * The quote corpus, and the two questions the typing test asks of it: how long
 * is this passage, and does it contain words the student is trying to learn.
 *
 * The corpus itself is a generated data file (see tools/build-quotes.mjs) and
 * is imported lazily — a megabyte of nineteenth-century prose has no business
 * loading for someone who only came to add a word to their bank.
 *
 * The bank filter is the part that makes this lexis rather than a typing test
 * bolted onto lexis. Practising *demise* on a flashcard and meeting it inside a
 * sentence of Dickens are different kinds of learning, and the second one is
 * the one that ends up in an essay.
 */

import { tokenize, variants } from "./essay.js";

/** The four length classes, by character count — the same cuts monkeytype uses. */
export const QUOTE_LENGTHS = ["short", "medium", "long", "thicc"];

/**
 * Where a passage came from, which is not decoration.
 *
 * A line from a film is remembered differently from a sentence in a novel, and
 * a student who wants to drill on speeches should not have to wade through
 * sitcom dialogue to find one. It is also the honest answer to "why am I
 * typing this" — a quote worth typing is a quote worth attributing.
 */
export const QUOTE_KINDS = ["film", "tv", "book", "speech", "person", "proverb", "prose"];

const KIND_LABELS = {
  film: "films",
  tv: "television",
  book: "books",
  speech: "speeches",
  person: "people",
  proverb: "proverbs",
  prose: "literature",
};

export function describeKind(kind) {
  return KIND_LABELS[kind] ?? kind;
}

const LENGTH_MAX = { short: 100, medium: 300, long: 600, thicc: Infinity };

export function quoteLength(text) {
  const length = String(text ?? "").length;
  if (length <= LENGTH_MAX.short) return "short";
  if (length <= LENGTH_MAX.medium) return "medium";
  if (length <= LENGTH_MAX.long) return "long";
  return "thicc";
}

/* ---- loading ---- */

let corpusPromise = null;

/**
 * The corpus, as objects, loaded once per session.
 *
 * The rejection is deliberately not cached: a chunk that failed to load
 * because the tab went offline mid-navigation should be retried the next time
 * the view is opened, not written off for the life of the session.
 */
export function loadCorpus() {
  if (!corpusPromise) {
    corpusPromise = import("../data/quotes.js")
      .then(({ QUOTES, SOURCES }) =>
        QUOTES.map(([text, source, speaker], index) => ({
          id: `corpus:${index}`,
          text,
          // Who said it, when that is a different question from where it is
          // from: Vito Corleone said it, The Godfather is where.
          speaker: speaker ?? "",
          work: SOURCES[source]?.[0] ?? "",
          author: SOURCES[source]?.[1] ?? "",
          kind: SOURCES[source]?.[2] ?? "prose",
          origin: "corpus",
          length: quoteLength(text),
        }))
      )
      .catch((err) => {
        corpusPromise = null;
        throw err;
      });
  }
  return corpusPromise;
}

/* ---- the bank filter ---- */

/**
 * Maps every inflected form of every bank word back to its headword.
 *
 * The ownership rules match essay.js exactly — an exact headword beats a
 * generated inflection, and the longer lemma wins a tie — because the two
 * features are answering the same question about the same bank, and a typist
 * who filters for “quotes containing *fervent*” should get the sentences the
 * essay checker would also credit to *fervent*.
 */
export function createBankMatcher(bankWords = []) {
  const words = [...new Set(bankWords.map((word) => String(word ?? "").toLowerCase()))].filter(
    Boolean
  );
  const exact = new Set(words);
  const owners = new Map();

  const better = (candidate, current) =>
    !current || candidate.length > current.length || (candidate.length === current.length && candidate < current);

  for (const word of words) {
    for (const form of variants(word)) {
      if (exact.has(form) && form !== word) continue; // another headword owns it outright
      const current = owners.get(form);
      if (exact.has(form) || better(word, current)) owners.set(form, word);
    }
  }
  for (const word of words) owners.set(word, word);

  return {
    words,
    /** The headwords this text contains, each named once. */
    match(text) {
      const found = new Set();
      if (!owners.size) return found;
      for (const token of tokenize(text)) {
        const owner = owners.get(token);
        if (owner) found.add(owner);
      }
      return found;
    },
    /** The same, over words already split — the corpus filter's hot path. */
    matchTokens(tokens) {
      if (!owners.size) return [];
      let found = null;
      for (const token of tokens) {
        const owner = owners.get(token);
        if (!owner) continue;
        found ??= new Set();
        found.add(owner);
      }
      // Most quotes contain none of your words, and allocating a Set for each
      // of them is most of the work when the filter runs over the whole corpus.
      return found ? [...found] : EMPTY;
    },
  };
}

/** Shared, and never mutated: the answer for a quote with no bank word in it. */
const EMPTY = Object.freeze([]);

/**
 * The words of a quote, lowercased, cached on it for good.
 *
 * Splitting twenty thousand quotes into words is the expensive half of the
 * bank filter and — crucially — it does not depend on the bank. Caching it
 * separately from the match result is what makes the *second* bank change
 * cheap: adding a word to your bank re-runs a map lookup per token, not a
 * regular expression over a megabyte of text.
 */
function tokensOf(quote) {
  quote._tokens ??= tokenize(quote.text);
  return quote._tokens;
}

/**
 * How many distinct bank words a quote contains, cached on the quote.
 *
 * The cache is keyed by which bank was asked about, so adding a word to the
 * bank invalidates it by itself.
 */
function bankHits(quote, matcher, key) {
  if (quote._bankKey !== key) {
    quote._bankKey = key;
    quote._bankWords = matcher.matchTokens(tokensOf(quote));
  }
  return quote._bankWords;
}

/** A stable identity for a bank, so the hit cache can tell one from another. */
function bankKey(matcher) {
  return matcher.words.length ? `${matcher.words.length}:${[...matcher.words].sort().join(",")}` : "";
}

/**
 * Which of your bank words a single quote uses, worked out on demand.
 *
 * The companion to filterQuotes leaving `bankWords` null when the filter is
 * off: this is the one quote it turned out to matter for.
 */
export function bankWordsIn(quote, bankMatcher) {
  if (!quote || !bankMatcher?.words.length) return [];
  if (Array.isArray(quote.bankWords)) return quote.bankWords;
  return bankMatcher.matchTokens(tokensOf(quote));
}

/**
 * The passages a given set of filters allows.
 *
 * `minBankWords` of 0 turns the bank filter off entirely; 1 means "must use at
 * least one word I am learning", which is the setting that actually gets used.
 */
export function filterQuotes(quotes, { lengths, kinds, bankMatcher, minBankWords = 0 } = {}) {
  const allowed = lengths ? new Set(lengths) : null;
  // An empty kind list means "no preference", not "nothing" — the settings
  // panel cannot get into that state, but a hand-edited stored blob can.
  const allowedKinds = kinds && kinds.length ? new Set(kinds) : null;
  const key = bankMatcher ? bankKey(bankMatcher) : "";
  const wantsBank = minBankWords > 0 && bankMatcher && bankMatcher.words.length > 0;

  const out = [];
  for (const quote of quotes) {
    if (allowed && !allowed.has(quote.length)) continue;
    if (allowedKinds && !allowedKinds.has(quote.kind ?? "prose")) continue;
    if (wantsBank) {
      const hits = bankHits(quote, bankMatcher, key);
      if (hits.length < minBankWords) continue;
      quote.bankWords = hits;
    } else {
      // Not filtering: leave it unanswered. The result screen wants to know
      // which of your words the passage used, but it wants that for the one
      // passage you typed — working it out for twenty thousand you did not is
      // a second of tokenizing to serve a single line of text.
      quote.bankWords = null;
    }
    out.push(quote);
  }
  return out;
}

/* ---- serving them up ---- */

/**
 * A shuffle bag: every passage in the pool is served once before any is served
 * twice.
 *
 * Drawing at random instead would hand out the same quote twice in five tests
 * often enough to be irritating — the birthday problem applies to typing tests
 * as much as to birthdays.
 */
export function createQuotePool(quotes = [], random = Math.random) {
  let bag = [];
  let source = [...quotes];

  function refill(exclude) {
    bag = [...source];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // Never open a fresh bag with the passage that closed the last one.
    if (bag.length > 1 && exclude && bag.at(-1)?.id === exclude) {
      [bag[0], bag[bag.length - 1]] = [bag.at(-1), bag[0]];
    }
  }

  let last = null;
  return {
    get size() {
      return source.length;
    },
    get remaining() {
      return bag.length;
    },
    replace(next) {
      source = [...next];
      bag = [];
    },
    next() {
      if (!source.length) return null;
      if (!bag.length) refill(last?.id);
      const quote = bag.pop() ?? null;
      last = quote;
      return quote;
    },
  };
}

/* ---- saying where it came from ---- */

/**
 * The attribution line, as segments the view can style.
 *
 * One function rather than a rendering rule per screen, because a quote is
 * credited in three places (under the passage, on the result screen, and in
 * the record book) and they must agree. `work` segments are the ones a
 * typographer would italicise — a title — and `plain` ones are names.
 *
 * The shape of a credit genuinely differs by kind. A film line belongs to a
 * character first and the film second; a novel belongs to its title first and
 * its author second; a speech belongs to the person who stood up and gave it.
 * Flattening all three into "title, author" is how attribution starts reading
 * like a citation nobody checks.
 */
export function attribution(quote) {
  if (!quote) return [];
  const speaker = String(quote.speaker ?? "").trim();
  const work = String(quote.work ?? "").trim();
  const author = String(quote.author ?? "").trim();
  const segments = [];
  const plain = (text) => segments.push({ text, style: "plain" });
  const titled = (text) => segments.push({ text, style: "work" });

  switch (quote.kind) {
    case "film":
    case "tv":
      if (speaker) plain(speaker);
      if (work) titled(work);
      break;
    case "speech":
      if (speaker || author) plain(speaker || author);
      if (work) titled(work);
      break;
    case "person":
      if (speaker || author) plain(speaker || author);
      // A person's page still names the book a line came from when it has one.
      if (work && work !== (speaker || author)) titled(work);
      break;
    case "proverb":
      plain(work || "proverb");
      break;
    default:
      // Books and literary prose: the work leads, the author follows.
      if (work) titled(work);
      if (author) plain(author);
      if (!work && !author && speaker) plain(speaker);
  }
  return segments.filter((segment) => segment.text);
}

/** The same credit as one plain string, for places that cannot style it. */
export function attributionText(quote) {
  return attribution(quote)
    .map((segment) => segment.text)
    .join(", ");
}
