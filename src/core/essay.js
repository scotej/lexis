/**
 * Essay analysis — which bank words appear in a draft, where, and how often.
 * Runs entirely on the device (or in the browser tab); no text is ever sent
 * anywhere. Ported from the original Rust implementation.
 */

/**
 * Words that end in -our but are not -our/-or spellings.
 *
 * The rule below would otherwise turn "four" into "for" and "your" into "yor",
 * which is the sort of thing that looks fine until an essay is credited with a
 * word it never used.
 */
const NOT_OUR_OR = new Set([
  "four", "your", "hour", "tour", "pour", "sour", "flour", "scour", "dour",
  "our", "spour", "detour", "contour", "velour", "devour", "amour", "glamour",
]);

/**
 * The other side of the Atlantic's spelling of the same word.
 *
 * This matters here more than it would elsewhere: lexis is written for an
 * Australian student, who banks "recognise" and "colour", while most of the
 * quotable English ever written down was published in America. In the shipped
 * quote corpus "recognize" outnumbers "recognise" seven to one — so without
 * this, a student's own vocabulary would miss most of the sentences that
 * actually contain it, in both the typing test and the essay checker.
 *
 * Each rule is applied in both directions and constrained tightly enough that
 * it cannot fire on a word that merely looks similar.
 */
function spellingVariants(w) {
  const out = new Set();
  const add = (form) => {
    if (form && form !== w) out.add(form);
  };

  if (w.endsWith("ise")) add(`${w.slice(0, -3)}ize`);
  if (w.endsWith("ize")) add(`${w.slice(0, -3)}ise`);
  if (w.endsWith("isation")) add(`${w.slice(0, -7)}ization`);
  if (w.endsWith("ization")) add(`${w.slice(0, -7)}isation`);
  if (w.endsWith("yse")) add(`${w.slice(0, -3)}yze`);
  if (w.endsWith("yze")) add(`${w.slice(0, -3)}yse`);

  if (w.endsWith("our") && w.length >= 6 && !NOT_OUR_OR.has(w)) add(`${w.slice(0, -3)}or`);
  if (w.endsWith("or") && w.length >= 5) add(`${w.slice(0, -2)}our`);

  // Only the consonant clusters that actually take -re: centre, sombre, metre.
  if (/[bcgtvd]re$/.test(w) && w.length >= 5) add(`${w.slice(0, -2)}er`);
  if (/[bcgtvd]er$/.test(w) && w.length >= 5) add(`${w.slice(0, -2)}re`);

  if (w.endsWith("ence") && w.length >= 6) add(`${w.slice(0, -4)}ense`);
  if (w.endsWith("ense") && w.length >= 6) add(`${w.slice(0, -4)}ence`);

  if (w.endsWith("logue")) add(`${w.slice(0, -3)}g`);
  if (/[ao]log$/.test(w)) add(`${w}ue`);

  if (/ll(ed|ing|er|ous)$/.test(w)) add(w.replace(/ll(ed|ing|er|ous)$/, "l$1"));
  if (/[^l]l(ed|ing|er|ous)$/.test(w)) add(w.replace(/l(ed|ing|er|ous)$/, "ll$1"));

  return out;
}

/**
 * Inflected forms a bank word might take in running text. Small,
 * rule-based, and entirely local — enough for regular English morphology
 * (demise → demises; vilify → vilifies, vilified), plus the British and
 * American spellings of the same word.
 */
export function variants(word) {
  const w = word.toLowerCase();
  const set = new Set([
    w,
    `${w}s`,
    `${w}es`,
    `${w}ed`,
    `${w}d`,
    `${w}ing`,
    `${w}ly`,
  ]);
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    set.add(`${stem}ing`);
    set.add(`${stem}ed`);
  }
  if (w.endsWith("y")) {
    const stem = w.slice(0, -1);
    set.add(`${stem}ies`);
    set.add(`${stem}ied`);
    set.add(`${stem}ily`);
  }
  const last = w[w.length - 1];
  if (last && !"aeiouy".includes(last)) {
    set.add(`${w}${last}ing`);
    set.add(`${w}${last}ed`);
  }

  // Each spelling of the word gets the same inflections as the headword, so
  // "recognise" also finds "recognized" and not only "recognize".
  for (const spelling of spellingVariants(w)) {
    set.add(spelling);
    set.add(`${spelling}s`);
    set.add(`${spelling}es`);
    set.add(`${spelling}ed`);
    set.add(`${spelling}d`);
    set.add(`${spelling}ing`);
    if (spelling.endsWith("e")) {
      set.add(`${spelling.slice(0, -1)}ing`);
      set.add(`${spelling.slice(0, -1)}ed`);
    }
  }
  return set;
}

export function tokenize(text) {
  return text
    .split(/[^\p{L}\p{N}'-]+/u)
    .filter(Boolean)
    .map((t) => t.replace(/^['-]+|['-]+$/g, "").toLowerCase())
    .filter(Boolean);
}

export function sentences(text) {
  const parts = text.match(/[^.!?]*[.!?]|[^.!?]+$/gu) ?? [];
  return parts.map((s) => s.split(/\s+/).filter(Boolean).join(" ")).filter(Boolean);
}

export function analyze(text, bankWords, todayWords) {
  const tokens = tokenize(text);
  const sents = sentences(text);
  const today = new Set(todayWords);

  // A token belongs to at most one bank entry. Prefer an exact headword match
  // over a generated inflection, then the longest matching lemma. Without
  // ownership, a bank containing both "fervent" and "fervently" would count
  // the single token "fervently" once for each word and permanently inflate
  // both essay-use totals.
  const candidates = bankWords.map((word) => ({ word, key: word.toLowerCase(), forms: variants(word) }));
  const exact = new Map(candidates.map((candidate) => [candidate.key, candidate.word]));
  const ownerCache = new Map();
  function ownerOf(token) {
    if (ownerCache.has(token)) return ownerCache.get(token);
    let owner = exact.get(token) ?? null;
    if (!owner) {
      for (const candidate of candidates) {
        if (!candidate.forms.has(token)) continue;
        if (
          !owner ||
          candidate.key.length > owner.length ||
          (candidate.key.length === owner.length && candidate.word < owner)
        ) {
          owner = candidate.word;
        }
      }
    }
    ownerCache.set(token, owner);
    return owner;
  }

  const counts = new Map();
  for (const token of tokens) {
    const owner = ownerOf(token);
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  const used = [];
  for (const word of bankWords) {
    const count = counts.get(word) ?? 0;
    if (count === 0) continue;
    const examples = sents
      .filter((s) => tokenize(s).some((token) => ownerOf(token) === word))
      .slice(0, 3);
    used.push({
      word,
      count,
      sentences: examples,
      overused: count >= 3,
      in_today: today.has(word),
    });
  }
  used.sort((a, b) => b.count - a.count);

  const usedSet = new Set(used.map((u) => u.word));
  const unused_today = todayWords.filter((w) => !usedSet.has(w));

  const notes = [];
  for (const u of used) {
    if (u.overused) {
      notes.push(`“${u.word}” appears ${u.count} times — consider varying it.`);
    }
    for (const s of u.sentences) {
      if (tokenize(s).filter((token) => ownerOf(token) === u.word).length >= 2) {
        notes.push(`“${u.word}” is repeated within a single sentence.`);
        break;
      }
    }
  }
  if (
    used.length &&
    used.every((u) => u.sentences.every((s) => tokenize(s).length < 8))
  ) {
    notes.push(
      "Your bank words mostly sit in short sentences — try weaving them into developed analysis."
    );
  }

  return {
    essay_words: tokens.length,
    bank_size: bankWords.length,
    used,
    unused_today,
    notes,
  };
}
