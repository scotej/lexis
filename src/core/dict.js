/**
 * Dictionary and thesaurus lookups. All three upstream APIs send permissive
 * CORS headers, so the browser can call them directly — the desktop app and
 * the web build share this exact code path.
 *
 * Ported from the original Rust implementation.
 */

const TIMEOUT_MS = 12000;

/**
 * How long the primary dictionary gets on its own before the fallback is
 * started alongside it.
 *
 * dictionaryapi.dev is a free community service and answers in a couple of
 * hundred milliseconds when it is well — and in eight seconds, or not at all,
 * when it is not. Waiting out its full timeout before so much as asking
 * Wiktionary is what made a bad afternoon on one host into a bad afternoon in
 * lexis. So the fallback is *hedged* rather than sequential: after this long
 * the second request goes out in parallel and the first usable answer wins.
 * Short enough that a slow day is barely felt; long enough that a healthy
 * dictionaryapi.dev is never double-asked.
 */
const HEDGE_AFTER_MS = 900;

async function getJSON(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`${new URL(url).host} returned ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---- a small, bounded, time-limited memo ----
 *
 * Shared by the three lookups below. A definition is not volatile — Wiktionary
 * does not rewrite an entry between one keystroke and the next — and the app
 * asks for the same one twice as a matter of course: the quick-lookup panel
 * fetches a word, and "add it to the bank after all" fetched it again from
 * scratch, a whole round trip to learn what was already on screen.
 *
 * Failures are never cached, so a lookup that failed because the tab was
 * briefly offline can succeed a second later.
 */
function createRequestCache({ limit, ttlMs }) {
  const entries = new Map();

  return {
    /** The cached promise for `key`, or `make()`'s, remembered. */
    run(key, make) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.expires > now) return hit.promise;
      if (hit) entries.delete(key);

      if (entries.size >= limit) entries.delete(entries.keys().next().value);
      const promise = Promise.resolve()
        .then(make)
        .catch((err) => {
          // Never let one bad minute poison the word for the session.
          if (entries.get(key)?.promise === promise) entries.delete(key);
          throw err;
        });
      entries.set(key, { expires: now + ttlMs, promise });
      return promise;
    },

    clear() {
      entries.clear();
    },
  };
}

const DEFINITION_CACHE_LIMIT = 64;
const DEFINITION_CACHE_TTL_MS = 30 * 60 * 1000;
const definitionCache = createRequestCache({
  limit: DEFINITION_CACHE_LIMIT,
  ttlMs: DEFINITION_CACHE_TTL_MS,
});
const synonymCache = createRequestCache({
  limit: DEFINITION_CACHE_LIMIT,
  ttlMs: DEFINITION_CACHE_TTL_MS,
});

/** Everything remembered from this session's lookups. Exported for tests. */
export function clearLookupCaches() {
  definitionCache.clear();
  synonymCache.clear();
  datamuseCache.clear();
}

// ---- Primary source: dictionaryapi.dev (definitions written by Wiktionary editors) ----

async function fetchDictionaryApi(word) {
  const entries = await getJSON(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
  );
  const entry = Array.isArray(entries) ? entries[0] : null;
  if (!entry) throw new Error("empty response");

  const phonetic =
    (entry.phonetic && entry.phonetic.length ? entry.phonetic : null) ??
    (entry.phonetics ?? []).map((p) => p.text).find((t) => t && t.length) ??
    null;

  // Keep it concise: at most three parts of speech, two senses for the
  // first and one for the rest.
  const senses = [];
  (entry.meanings ?? []).slice(0, 3).forEach((meaning, i) => {
    const keep = i === 0 ? 2 : 1;
    (meaning.definitions ?? []).slice(0, keep).forEach((d) => {
      senses.push({
        pos: meaning.partOfSpeech,
        def: (d.definition ?? "").trim(),
        example: d.example?.trim() || null,
      });
    });
  });
  if (!senses.length) throw new Error("no definitions in response");

  return {
    phonetic,
    senses,
    source: "Wiktionary via dictionaryapi.dev",
    source_url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
  };
}

// ---- Fallback source: Wiktionary REST API ----

export function stripHtml(s) {
  let out = "";
  let inTag = false;
  for (const c of s) {
    if (c === "<") inTag = true;
    else if (c === ">") inTag = false;
    else if (!inTag) out += c;
  }
  return out
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

async function fetchWiktionary(word) {
  const body = await getJSON(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`
  );
  const usages = body?.en;
  if (!usages) throw new Error("no English entry");

  const senses = [];
  usages.slice(0, 3).forEach((usage, i) => {
    const keep = i === 0 ? 2 : 1;
    const pos = (usage.partOfSpeech ?? "").toLowerCase();
    for (const d of usage.definitions ?? []) {
      const text = stripHtml(d.definition ?? "");
      if (!text) continue;
      senses.push({ pos, def: text, example: null });
      if (senses.filter((s) => s.pos === pos).length >= keep) break;
    }
  });
  if (!senses.length) throw new Error("no definitions found");

  return {
    phonetic: null,
    senses,
    source: "Wiktionary",
    source_url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
  };
}

/**
 * The definition, from whichever source answers usably first.
 *
 * dictionaryapi.dev still leads — its entries carry pronunciation and worked
 * examples that the REST fallback does not — so a healthy one is never raced.
 * It is only joined, after HEDGE_AFTER_MS, by a Wiktionary request that was
 * going to be made anyway the moment the first one failed. Whichever lands
 * first with a real entry is the answer; the loser is left to settle
 * unobserved rather than cancelled, so its result still warms nothing and
 * costs nothing.
 *
 * The failure message keeps both causes, because "the primary 404ed and the
 * fallback had no English section" and "both hosts are unreachable" are
 * different problems wearing the same sentence.
 */
async function fetchRawDefinition(word) {
  const primary = fetchDictionaryApi(word);
  let hedgeTimer = null;
  let fallback = null;

  const startFallback = () => (fallback ??= fetchWiktionary(word));
  const hedge = new Promise((resolve) => {
    hedgeTimer = setTimeout(resolve, HEDGE_AFTER_MS);
  });

  try {
    const first = await Promise.race([
      primary.then((entry) => ({ entry })),
      hedge.then(() => null),
    ]);
    if (first?.entry) return first.entry;
  } catch {
    /* the primary failed; the fallback below is exactly the old behaviour */
  } finally {
    clearTimeout(hedgeTimer);
  }

  // Either the primary is slow (both now run) or it has already failed. The
  // first *usable* answer wins — waiting for the loser as well would hand the
  // stalled host back the veto this whole arrangement exists to take from it.
  try {
    return await Promise.any([primary, startFallback()]);
  } catch (err) {
    const [why1, why2] = (err?.errors ?? [err]).map((reason) =>
      String(reason?.message ?? reason)
    );
    throw new Error(`no dictionary entry found for "${word}" (${why1}; ${why2})`);
  }
}

// Wiktionary sometimes defines a derived adverb only through its adjective:
// "fervently" is merely "In a fervent manner." Looking up the adjective's
// first sense is unsafe: for example, the first gloss of "strict" is the old
// physical sense "strained; drawn close; tight", not the ordinary meaning of
// "strictly". Cross-check two independent lexical relations instead: a result
// must be both means-like the queried adverb and derived from an exact synonym
// of the referenced adjective. This rejects sense leakage such as "purely" for
// "strictly" while retaining "rigorously", "rigidly", and "sternly". If that
// evidence is weak or unavailable, preserve the original editor-written text.

const OPAQUE_ADVERB = /^in an? ([a-z][a-z'-]*) manner[.!]?$/i;
const MIN_CLARIFICATION_FREQ = 0.05;
const MAX_CLARIFICATION_WORDS = 3;

function referencedAdjective(sense) {
  if ((sense.pos ?? "").toLowerCase() !== "adverb") return null;
  return sense.def?.trim().match(OPAQUE_ADVERB)?.[1]?.toLowerCase() ?? null;
}

/** Whether a stored entry can benefit from the derived-adverb clarification. */
export function needsDerivativeClarification(dictionary) {
  return (dictionary?.senses ?? []).some((sense) => referencedAdjective(sense));
}

/** Plausible adjective lemmas for a regular English -ly adverb. */
export function adjectiveFormsForAdverb(word) {
  const value = word.trim().toLowerCase();
  const forms = new Set();
  if (!value.endsWith("ly") || value.length <= 2) return forms;

  const stem = value.slice(0, -2);
  forms.add(stem);
  forms.add(`${stem}e`); // truly -> true; wholly -> whole
  forms.add(`${stem}le`); // gently -> gentle; idly -> idle
  if (stem.endsWith("l")) forms.add(`${stem}l`); // fully -> full
  if (value.endsWith("ily")) forms.add(`${value.slice(0, -3)}y`); // happily -> happy
  if (value.endsWith("bly")) forms.add(`${value.slice(0, -3)}ble`); // terribly -> terrible
  if (value.endsWith("ically")) forms.add(`${value.slice(0, -6)}ic`); // basically -> basic
  return forms;
}

/** Build a concise clarification supported by both Datamuse relations. */
export function adverbClarification(word, candidates, adjectiveSynonyms) {
  const original = word.trim().toLowerCase();
  const exactAdjectives = new Set();
  for (const candidate of adjectiveSynonyms ?? []) {
    const value =
      typeof candidate?.word === "string" ? candidate.word.trim().toLowerCase() : "";
    const tags = Array.isArray(candidate?.tags) ? candidate.tags : [];
    if (value && tags.includes("adj") && /^[a-z][a-z'-]*$/.test(value)) {
      exactAdjectives.add(value);
    }
  }

  const words = [];

  for (const candidate of candidates ?? []) {
    const value =
      typeof candidate?.word === "string" ? candidate.word.trim().toLowerCase() : "";
    const tags = Array.isArray(candidate?.tags) ? candidate.tags : [];
    if (
      !value ||
      value === original ||
      !tags.includes("adv") ||
      parseFreq(tags) < MIN_CLARIFICATION_FREQ ||
      !/^[a-z][a-z'-]*$/.test(value) ||
      ![...adjectiveFormsForAdverb(value)].some((form) => exactAdjectives.has(form)) ||
      words.includes(value)
    ) {
      continue;
    }
    words.push(value);
    if (words.length === MAX_CLARIFICATION_WORDS) break;
  }

  // One nearby word is too fragile to replace a human-edited definition.
  if (words.length < 2) return null;
  if (words.length === 2) {
    return `Depending on context: ${words[0]} or ${words[1]}.`;
  }
  return `Depending on context: ${words[0]}, ${words[1]}, or ${words[2]}.`;
}

/**
 * Replace only completely opaque adverb formulas. `lookup` is injected so the
 * semantic filtering and failure behaviour can be tested without the network.
 */
export async function expandDerivativeDefinitions(
  word,
  dictionary,
  lookupRelatedAdverbs,
  lookupAdjectiveSynonyms
) {
  const bases = [
    ...new Set((dictionary.senses ?? []).map(referencedAdjective).filter(Boolean)),
  ];
  if (!bases.length) return dictionary;

  const relatedPromise = Promise.resolve()
    .then(() => lookupRelatedAdverbs(word))
    .catch(() => []);
  const synonymPromises = new Map(
    bases.map((base) => [
      base,
      Promise.resolve()
        .then(() => lookupAdjectiveSynonyms(base))
        .catch(() => []),
    ])
  );
  const relatedAdverbs = await relatedPromise;
  const synonymsByBase = new Map(
    await Promise.all(
      [...synonymPromises].map(async ([base, request]) => [base, await request])
    )
  );

  let changed = false;
  const senses = (dictionary.senses ?? []).map((sense) => {
    const base = referencedAdjective(sense);
    if (!base) return sense;
    let clarification;
    try {
      clarification = adverbClarification(
        word,
        relatedAdverbs,
        synonymsByBase.get(base)
      );
    } catch {
      return sense;
    }
    if (!clarification) return sense;
    changed = true;
    return { ...sense, def: clarification };
  });
  if (!changed) return dictionary;

  return {
    ...dictionary,
    senses,
    source: "Wiktionary · clarification via Datamuse",
    clarification_url: datamuseUrl("ml", word),
  };
}

/**
 * A word's entry, looked up once per word per half hour.
 *
 * The repeat is not hypothetical: reading a word in the quick-lookup panel and
 * then pressing "add it to the bank" asked both APIs the same question twice
 * over, and the second answer was always the first one. Memoized, the add is
 * instant and the panel is what paid for it.
 */
export async function fetchDefinition(word) {
  const key = String(word ?? "").trim().toLowerCase();
  const entry = await definitionCache.run(key, async () => {
    const dictionary = await fetchRawDefinition(word);
    return await clarifyDerivativeDefinitions(word, dictionary);
  });
  // A copy, because the caller stores what it is given straight into the bank
  // and a cache that hands the same array to two callers has stopped being a
  // cache and started being shared mutable state.
  return { ...entry, senses: entry.senses.map((sense) => ({ ...sense })) };
}

/** Apply the live lexical cross-check to an already-stored dictionary entry. */
export async function clarifyDerivativeDefinitions(word, dictionary) {
  return await expandDerivativeDefinitions(
    word,
    dictionary,
    (query) => datamuse(`ml=${encodeURIComponent(query)}`),
    (adjective) => datamuse(`rel_syn=${encodeURIComponent(adjective)}`)
  );
}

// ---- Synonyms: Datamuse (corpus statistics, not AI) + local sophistication scoring ----

function parseFreq(tags) {
  // Datamuse's `f:` tag is occurrences per million words of corpus text.
  for (const t of tags ?? []) {
    if (t.startsWith("f:")) {
      const v = Number.parseFloat(t.slice(2));
      if (!Number.isNaN(v)) return v;
    }
  }
  return 0;
}

/**
 * Scores a candidate synonym for how well it suits formal analytical
 * writing (VCE-style metalanguage). Entirely local: favours words that are
 * uncommon in everyday text but not vanishingly obscure, have some length
 * to them, and carry Latinate endings typical of the formal register.
 */
export function sophisticationScore(word, freq) {
  let score = 0;

  // Rarity: the sweet spot is roughly 0.05–15 occurrences per million.
  if (freq <= 0) score += 1.0; // unknown frequency: mildly interesting
  else if (freq < 0.02) score += 0.5; // probably too obscure to use safely
  else if (freq < 1.0) score += 3.0;
  else if (freq < 15.0) score += 2.0;
  else if (freq < 60.0) score += 0.8;
  else score += -1.0; // everyday word; not an upgrade

  // Length: longer words tend toward the formal register.
  const len = [...word].length;
  if (len <= 4) score += -1.0;
  else if (len <= 6) score += 0.3;
  else if (len <= 9) score += 1.2;
  else score += 1.5;

  // Latinate/Greek endings common in analytical prose.
  const FORMAL_SUFFIXES = [
    "tion", "sion", "ment", "ance", "ence", "ity", "ism", "esce",
    "escence", "ate", "ify", "ise", "ize", "ous",
  ];
  if (FORMAL_SUFFIXES.some((s) => word.endsWith(s))) score += 0.8;

  return score;
}

const DATAMUSE_CACHE_LIMIT = 64;
const DATAMUSE_CACHE_TTL_MS = 10 * 60 * 1000;
const datamuseCache = new Map();

function datamuseUrl(relation, word) {
  return `https://api.datamuse.com/words?${relation}=${encodeURIComponent(word)}&md=pf&max=40`;
}

async function datamuse(query) {
  const now = Date.now();
  let cached = datamuseCache.get(query);
  if (cached && cached.expires <= now) {
    datamuseCache.delete(query);
    cached = null;
  }
  if (!cached) {
    if (datamuseCache.size >= DATAMUSE_CACHE_LIMIT) {
      datamuseCache.delete(datamuseCache.keys().next().value);
    }
    cached = {
      expires: now + DATAMUSE_CACHE_TTL_MS,
      request: getJSON(`https://api.datamuse.com/words?${query}&md=pf&max=40`).catch(
        () => []
      ),
    };
    datamuseCache.set(query, cached);
  }
  const response = await cached.request;
  const result = Array.isArray(response) ? response : [];
  // Do not let a transient outage poison this word for the rest of the session.
  if (!result.length && datamuseCache.get(query) === cached) datamuseCache.delete(query);
  return result;
}

export async function fetchSynonyms(word) {
  const key = String(word ?? "").trim().toLowerCase();
  const ranked = await synonymCache.run(key, () => rankSynonyms(word));
  return ranked.map((row) => ({ ...row })); // see fetchDefinition: never share the stored copy
}

async function rankSynonyms(word) {
  // Both questions at once. Strict synonym lists run thin for most words, so
  // the means-like padding below is needed more often than not — and asking
  // for it only after the first answer came back made every one of those
  // words cost two round trips in a row. Datamuse answers the same request
  // once per session either way (see the cache above), and the adverb
  // clarification asks this very question for `ml`, so the second request is
  // usually one already paid for.
  const [strict, related] = await Promise.all([
    datamuse(`rel_syn=${encodeURIComponent(word)}`),
    datamuse(`ml=${encodeURIComponent(word)}`),
  ]);

  // The padding rule itself is unchanged: a generous strict list stands on its
  // own, and only a thin one is topped up.
  let candidates = strict;
  if (candidates.length < 6) {
    candidates = candidates.concat(
      related.filter((r) => !candidates.some((c) => c.word === r.word))
    );
  }

  const ranked = candidates
    .filter(
      (w) =>
        w.word !== word &&
        !w.word.includes(" ") &&
        /^[A-Za-z-]+$/.test(w.word)
    )
    .map((w) => {
      const freq = parseFreq(w.tags);
      return { word: w.word, freq, score: sophisticationScore(w.word, freq) };
    });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 8);
}
