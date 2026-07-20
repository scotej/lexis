/**
 * Essay analysis — which bank words appear in a draft, where, and how often.
 * Runs entirely on the device (or in the browser tab); no text is ever sent
 * anywhere. Ported from the original Rust implementation.
 */

/**
 * Inflected forms a bank word might take in running text. Small,
 * rule-based, and entirely local — enough for regular English morphology
 * (demise → demises; vilify → vilifies, vilified).
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

  const used = [];
  for (const word of bankWords) {
    const forms = variants(word);
    const count = tokens.filter((t) => forms.has(t)).length;
    if (count === 0) continue;
    const examples = sents
      .filter((s) => tokenize(s).some((t) => forms.has(t)))
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
    const forms = variants(u.word);
    for (const s of u.sentences) {
      if (tokenize(s).filter((t) => forms.has(t)).length >= 2) {
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
