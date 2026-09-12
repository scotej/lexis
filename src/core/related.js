import { aiEmbedWords, aiGroupWordsByTheme } from './ai.js';

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
function lexicalData(word) {
  return {
    word: word.word,
    senses: (word.senses ?? []).map(s => ({ pos: s.pos, def: s.def })),
    synonyms: (word.synonyms ?? []).map(s => typeof s === 'string' ? s : s.word),
  };
}

export function relatedFingerprint(words) {
  return JSON.stringify(words.map(lexicalData).sort((a, b) => a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
}

function embeddingText(word) {
  const data = lexicalData(word);
  return `${data.word}\n${data.senses.map(s => `${s.pos ?? ''}: ${s.def ?? ''}`).join('\n')}\nSynonyms: ${data.synonyms.join(', ')}`.slice(0, 6000);
}

function similarity(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** How many words one grouping request carries; aiGroupWordsByTheme sets the ceiling. */
const THEME_BATCH = 60;

/** The bucket for words the model passed over, kept last so it reads as a remainder. */
const UNGROUPED = 'other words';

function bucket(themes, name) {
  let group = themes.get(name);
  if (!group) themes.set(name, (group = []));
  return group;
}

/**
 * The same job done by a chat model, for a key that cannot buy embeddings.
 *
 * Not as good, and not pretending to be: themes are coarser than distances,
 * and two groups sitting next to each other are neighbours only alphabetically.
 * What it is, is *available* — to a key holding nothing but free models, which
 * is the ordinary way a student arrives at OpenRouter.
 *
 * Every word in the bank comes out the other side exactly once, whatever the
 * reply does, because the reply only ever nominates: the model's names are
 * matched against this chunk and anything it left out is collected at the end.
 * That is what the caller's permutation check demands, and it is not a check
 * worth failing an export over when the fix is to put the stragglers together.
 */
async function themedWords(words, settings, { signal, onProgress }) {
  const themes = new Map();
  for (let start = 0; start < words.length; start += THEME_BATCH) {
    signal?.throwIfAborted();
    onProgress(`grouping meanings with your chat model · ${start} of ${words.length} words`);
    const slice = [];
    for (let i = start; i < Math.min(start + THEME_BATCH, words.length); i++) slice.push(i);
    const groups = await aiGroupWordsByTheme(
      settings,
      slice.map(i => ({ word: words[i].word, detail: themeDetail(words[i]) })),
      { signal, knownThemes: [...themes.keys()].filter(name => name !== UNGROUPED) }
    );
    signal?.throwIfAborted();
    const byName = new Map();
    for (const i of slice) if (!byName.has(words[i].word)) byName.set(words[i].word, i);
    const claimed = new Set();
    for (const group of groups) {
      for (const name of group.words) {
        const index = byName.get(name);
        if (index === undefined || claimed.has(index)) continue;
        claimed.add(index);
        bucket(themes, group.theme).push(index);
      }
    }
    for (const i of slice) if (!claimed.has(i)) bucket(themes, UNGROUPED).push(i);
  }
  const named = [...themes.keys()].filter(name => name !== UNGROUPED).sort(collator.compare);
  if (themes.has(UNGROUPED)) named.push(UNGROUPED);
  const order = [];
  for (const name of named) {
    const group = themes.get(name);
    group.sort((a, b) => collator.compare(words[a].word, words[b].word) || a - b);
    order.push(...group);
  }
  return order.map(index => words[index]);
}

/** What a word is about, for a model reading a list of them. */
function themeDetail(word) {
  const data = lexicalData(word);
  const senses = data.senses.map(s => `${s.pos ? `${s.pos} ` : ''}${s.def ?? ''}`.trim()).filter(Boolean).join('; ');
  const synonyms = data.synonyms.length ? ` (near: ${data.synonyms.slice(0, 6).join(', ')})` : '';
  return `${senses}${synonyms}`.slice(0, 400);
}

/** A global nearest-neighbour path; batches only bound HTTP payloads. */
export async function relatedWords(words, settings, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  if (words.length < 2) return [...words];
  const vectors = [];
  for (let start = 0; start < words.length; start += 32) {
    signal?.throwIfAborted();
    onProgress(`comparing meanings · ${start} of ${words.length} words`);
    let batch;
    try {
      batch = await aiEmbedWords(settings, words.slice(start, start + 32).map(embeddingText), { signal });
    } catch (error) {
      // Every embedding model OpenRouter carries is paid, so a key that only
      // ever buys free models is refused the very first of these outright.
      // That refusal is a 402, and a 402 reads as "you have run out" — which
      // is a false account of a key that has spent nothing and still has its
      // whole free allowance. Nothing has been billed at this point either,
      // so the chat model the student *did* choose gets the job instead.
      // A 402 later in the run is the plain meaning of the word: a balance
      // that ran out partway, and the honest error is the right answer.
      // The swap says itself in the progress line rather than in a note of
      // its own: a note here is replaced by that line before the interface
      // has painted either, which is how a method change goes unseen.
      if (error?.status !== 402 || start > 0) throw error;
      return themedWords(words, settings, { signal, onProgress });
    }
    signal?.throwIfAborted();
    if (vectors.length && vectors[0].length !== batch[0].length) {
      throw new Error('OpenRouter returned inconsistent embedding dimensions. Try again.');
    }
    vectors.push(...batch);
  }
  onProgress(`linking ${words.length} related words…`);
  // Start at the semantic edge of the bank, then repeatedly attach the most
  // similar unvisited word. Alphabetical ties make identical vectors stable.
  const pending = words.map((_, i) => i).sort((a, b) => collator.compare(words[a].word, words[b].word) || a - b);
  const centre = new Array(vectors[0].length).fill(0);
  for (const vector of vectors) for (let d = 0; d < centre.length; d++) centre[d] += vector[d] / vectors.length;
  let startAt = 0;
  for (let i = 1; i < pending.length; i++) {
    if (similarity(vectors[pending[i]], centre) < similarity(vectors[pending[startAt]], centre)) startAt = i;
  }
  const path = [pending.splice(startAt, 1)[0]];
  while (pending.length) {
    if (path.length % 16 === 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    const last = vectors[path.at(-1)];
    let best = 0;
    let score = -Infinity;
    for (let i = 0; i < pending.length; i++) {
      const candidate = similarity(last, vectors[pending[i]]);
      if (candidate > score + 1e-12) { score = candidate; best = i; }
    }
    path.push(pending.splice(best, 1)[0]);
  }
  signal?.throwIfAborted();
  return path.map(index => words[index]);
}
