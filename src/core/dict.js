/**
 * Dictionary and thesaurus lookups. All three upstream APIs send permissive
 * CORS headers, so the browser can call them directly — the desktop app and
 * the web build share this exact code path.
 *
 * Ported from the original Rust implementation.
 */

const TIMEOUT_MS = 12000;

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

async function fetchRawDefinition(word) {
  try {
    return await fetchDictionaryApi(word);
  } catch (first) {
    try {
      return await fetchWiktionary(word);
    } catch (second) {
      throw new Error(
        `no dictionary entry found for "${word}" (${first.message}; ${second.message})`
      );
    }
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

export async function fetchDefinition(word) {
  const dictionary = await fetchRawDefinition(word);
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
  let candidates = await datamuse(`rel_syn=${encodeURIComponent(word)}`);
  // Strict synonym lists run thin for many words; pad with Datamuse's
  // means-like results, which stay corpus-driven rather than generative.
  if (candidates.length < 6) {
    const related = await datamuse(`ml=${encodeURIComponent(word)}`);
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
