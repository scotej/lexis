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

export async function fetchDefinition(word) {
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

async function datamuse(query) {
  try {
    return await getJSON(`https://api.datamuse.com/words?${query}&md=f&max=40`);
  } catch {
    return [];
  }
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
