import { aiEmbedWords } from './ai.js';

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

/** A global nearest-neighbour path; batches only bound HTTP payloads. */
export async function relatedWords(words, settings, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  if (words.length < 2) return [...words];
  const vectors = [];
  for (let start = 0; start < words.length; start += 32) {
    signal?.throwIfAborted();
    onProgress(`comparing meanings · ${start} of ${words.length} words`);
    const batch = await aiEmbedWords(settings, words.slice(start, start + 32).map(embeddingText), { signal });
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
