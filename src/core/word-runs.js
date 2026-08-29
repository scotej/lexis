/**
 * The text for the modes that aren't quotes: a run of words, generated.
 *
 * Two word lists feed this. The default is the thousand commonest words in the
 * same public-domain shelf the quotes come from, so the register matches. The
 * other is the student's own bank — which is the whole point of putting a
 * typing test inside a vocabulary app. Typing *equivocate* forty times in two
 * minutes is not spaced repetition, but it is the kind of rote familiarity
 * that makes a word available when an essay needs it at speed.
 */

const SENTENCE_END = /[.!?]$/;

/**
 * A word run of the requested length.
 *
 * `random` is injected so the generator is testable and so a "repeat this
 * test" can replay the identical run rather than an equivalent-looking one.
 */
export function generateWords(
  pool,
  count,
  { punctuation = false, numbers = false, random = Math.random } = {}
) {
  const words = pool.filter(Boolean);
  if (!words.length || count <= 0) return [];

  const out = [];
  let previousRaw = "";
  let previousOut = "";
  while (out.length < count) {
    let raw = words[Math.floor(random() * words.length)];
    // Two words cannot be allowed to repeat back to back: with a short bank as
    // the pool it happens constantly, and typing "demise demise" teaches the
    // fingers a sequence that will never occur again.
    if (raw === previousRaw && words.length > 1) continue;

    let word = raw;
    if (numbers && random() < 0.1) {
      raw = String(Math.floor(random() * 10 ** (1 + Math.floor(random() * 4))));
      word = raw;
    } else if (punctuation) {
      word = punctuate(word, {
        first: out.length === 0 || SENTENCE_END.test(previousOut),
        last: out.length === count - 1,
        random,
      });
    }
    out.push(word);
    previousRaw = raw;
    previousOut = word;
  }
  return out;
}

/**
 * Punctuation, applied the way it falls in real prose rather than uniformly.
 *
 * The proportions are chosen so a run of fifty words reads like a paragraph
 * with a few sentences in it — full stops are common, semicolons are rare, and
 * everything that opens gets closed on the same word so a passage can never
 * end mid-bracket.
 */
function punctuate(raw, { first, last, random }) {
  let word = raw;
  if (first) word = word.charAt(0).toUpperCase() + word.slice(1);

  const roll = random();
  if (last) return SENTENCE_END.test(word) ? word : `${word}.`;
  if (roll < 0.1) return `${word}${pick([".", ".", ".", "?", "!"], random)}`;
  if (roll < 0.15) return `${word},`;
  if (roll < 0.17) return `${word};`;
  if (roll < 0.185) return `${word}:`;
  if (roll < 0.2) return `"${word}"`;
  if (roll < 0.21) return `(${word})`;
  if (roll < 0.22) return `${word}'s`;
  return word;
}

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

/**
 * Enough words to keep a timed test ahead of the typist.
 *
 * A timed test has no natural length, so the run is grown in chunks as the
 * typist approaches the end of what has been generated. Nobody has ever typed
 * two hundred words in the time it takes to generate the next hundred.
 */
export const TIMED_CHUNK = 100;
