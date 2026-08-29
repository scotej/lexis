/**
 * Personal bests and the last few results.
 *
 * Kept per device, alongside the settings and for the same reason: a speed is
 * a fact about a keyboard as much as about a typist, and a best set on a
 * mechanical board at home does not belong on the school laptop's leaderboard.
 *
 * The history is capped hard. This is a practice record, not a database, and
 * an unbounded array in local storage is a slow leak that only ever shows up
 * on the machine with the least room to spare.
 */

/** How many finished tests are kept, newest first. */
export const HISTORY_LIMIT = 200;

export function emptyRecords() {
  return { version: 1, bests: {}, history: [] };
}

export function normalizeRecords(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const bests = {};
  if (source.bests && typeof source.bests === "object") {
    for (const [key, value] of Object.entries(source.bests)) {
      const best = normalizeEntry(value);
      if (best) bests[key] = best;
    }
  }
  const history = Array.isArray(source.history)
    ? source.history.map(normalizeEntry).filter(Boolean).slice(0, HISTORY_LIMIT)
    : [];
  return { version: 1, bests, history };
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") return null;
  const wpm = Number(value.wpm);
  const accuracy = Number(value.accuracy);
  if (!Number.isFinite(wpm) || !Number.isFinite(accuracy)) return null;
  return {
    key: String(value.key ?? ""),
    label: String(value.label ?? ""),
    wpm,
    raw: Number.isFinite(Number(value.raw)) ? Number(value.raw) : wpm,
    accuracy,
    consistency: Number.isFinite(Number(value.consistency)) ? Number(value.consistency) : 0,
    at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0,
    bankWords: Array.isArray(value.bankWords) ? value.bankWords.filter((w) => typeof w === "string") : [],
  };
}

/**
 * Files a finished test.
 *
 * Only a completed run counts. A test abandoned halfway, or failed on a
 * threshold, would otherwise set a personal best out of its fastest ten
 * seconds — which is exactly the number a practice record must not flatter.
 *
 * Returns the updated records and whether this was a new best, so the result
 * screen can say so.
 */
export function recordResult(records, { key, label, result, bankWords = [], at = Date.now() }) {
  const next = normalizeRecords(records);
  if (result?.status !== "done") return { records: next, best: false, previous: next.bests[key] ?? null };

  const entry = {
    key,
    label,
    wpm: round(result.wpm),
    raw: round(result.raw),
    accuracy: round(result.accuracy),
    consistency: round(result.consistency),
    at,
    bankWords: [...bankWords],
  };

  const previous = next.bests[key] ?? null;
  // A faster run with worse accuracy is still the faster run — but a run
  // scraping 60% accuracy is a different activity, and letting it stand as a
  // personal best turns the record into a measure of how hard you can mash.
  const eligible = entry.accuracy >= 75;
  const best = eligible && (!previous || entry.wpm > previous.wpm);
  if (best) next.bests[key] = entry;

  next.history = [entry, ...next.history].slice(0, HISTORY_LIMIT);
  return { records: next, best, previous };
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** The running averages the result screen shows under the headline figure. */
export function summarize(records, key, limit = 10) {
  const rows = normalizeRecords(records).history.filter((entry) => !key || entry.key === key);
  const recent = rows.slice(0, limit);
  if (!recent.length) return { tests: 0, averageWpm: 0, averageAccuracy: 0, allTests: rows.length };
  return {
    tests: recent.length,
    allTests: rows.length,
    averageWpm: round(recent.reduce((sum, entry) => sum + entry.wpm, 0) / recent.length),
    averageAccuracy: round(recent.reduce((sum, entry) => sum + entry.accuracy, 0) / recent.length),
  };
}

/**
 * Which bank words have been typed, and how often.
 *
 * This is the number that makes the typing test part of lexis rather than a
 * diversion inside it: it says which of the words you are learning you have
 * now met at speed, in a sentence, rather than on the front of a card.
 */
export function bankWordTotals(records) {
  const totals = new Map();
  for (const entry of normalizeRecords(records).history) {
    for (const word of entry.bankWords) totals.set(word, (totals.get(word) ?? 0) + 1);
  }
  return totals;
}
