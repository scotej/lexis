/**
 * Naming the merges that cost something.
 *
 * `merge.js` never fails: every reconciliation produces an answer, because a
 * word bank with no server has to. But "produced an answer" and "lost nothing"
 * are different claims. When two devices edited the same word while apart, one
 * copy wins and the other is discarded — silently, and possibly along with a
 * fortnight of review history.
 *
 * This module is the audit trail for exactly those moments. It runs *beside*
 * the merge rather than inside it: the merge stays a total function with the
 * semantics it always had, and this reports what that function had to throw
 * away so the interface can offer the losing copy back.
 *
 * The definition of a conflict here is deliberately narrow — **the merge
 * discarded something the loser had that the winner does not**. Two copies
 * that differ only in fields the merge unions (essay-use events, today's
 * ticks) are not a conflict, because nothing was lost. Two identical copies
 * are not a conflict either. Anything reported here is a real choice with a
 * real cost, which is what makes the list short enough to be worth reading.
 *
 * There is no common ancestor to diff against — no operation log, no base
 * revision — and inventing one would mean storing a third copy of the bank
 * forever. "What did the loser have that the winner lacks" needs no ancestor
 * and answers the only question a person actually asks.
 */

import { beats, stable } from "./merge.js";
import { encryptJSON, decryptJSON } from "./crypto.js";
import { storeGet, storeSet, storeRemove } from "../platform/store.js";

/** Plenty to look through, small enough that the log can never bloat storage. */
export const CONFLICT_LOG_LIMIT = 40;

const LOG_KEY = "lexis-conflicts";

/* ---- what a losing copy took with it ---- */

function srsOf(w) {
  return w?.srs ?? {};
}

/**
 * The reasons this particular loser mattered. Empty means the merge cost
 * nothing and there is no conflict to report.
 *
 * Only fields the merge resolves by *choosing* are considered. Essay-use
 * events are unioned in `mergeBanks`, so a difference there survives both
 * ways and is not a loss; `essay_uses` is derived from them and likewise
 * excluded.
 */
function losses(winner, loser) {
  const out = [];

  if (stable(winner.senses ?? []) !== stable(loser.senses ?? [])) {
    out.push("a different definition");
  } else if ((winner.phonetic ?? null) !== (loser.phonetic ?? null)) {
    out.push("a different pronunciation");
  }

  if (stable(winner.synonyms ?? []) !== stable(loser.synonyms ?? [])) {
    out.push("different synonyms");
  }

  const ws = srsOf(winner);
  const ls = srsOf(loser);
  if (
    (ls.reps ?? 0) > (ws.reps ?? 0) ||
    (ls.lapses ?? 0) > (ws.lapses ?? 0) ||
    (ls.last ?? "") > (ws.last ?? "")
  ) {
    out.push(`more review history (${ls.reps ?? 0} reps vs ${ws.reps ?? 0})`);
  }

  if ((loser.times_used ?? 0) > (winner.times_used ?? 0)) {
    out.push(`more practice (${loser.times_used ?? 0}× vs ${winner.times_used ?? 0}×)`);
  }

  return out;
}

/** FNV-1a over the canonical form — just enough to recognise the same pair twice. */
function digest(value) {
  const s = stable(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function tombstoneMap(bank) {
  const map = new Map();
  for (const d of bank?.deleted ?? []) {
    const prev = map.get(d.word);
    if (!prev || d.at > prev.at) map.set(d.word, d);
  }
  return map;
}

function wordMap(bank) {
  const map = new Map();
  for (const w of bank?.words ?? []) map.set(w.word, w);
  return map;
}

/**
 * Compares two banks the way `mergeBanks` will, and reports every word where
 * the merge has to discard something.
 *
 * `mine` and `theirs` are human labels for the two channels ("this device",
 * "the Syncthing folder", "GitHub"), carried through to the interface so the
 * report can say where each copy came from.
 *
 * Two shapes are reported:
 *
 *   - **edit vs edit** — both sides hold the word, the merge keeps one.
 *   - **delete vs edit** — one side deleted the word, the other edited it
 *     *after* that delete, and the tombstone still wins. The edit vanishes,
 *     which is the single most surprising outcome the merge can produce.
 *
 * A re-add that beats an old delete is not reported: nothing is lost there,
 * the word simply comes back.
 */
export function detectConflicts(mineBank, theirsBank, { mine, theirs, at = Date.now() } = {}) {
  const mineWords = wordMap(mineBank);
  const theirsWords = wordMap(theirsBank);
  const mineTombs = tombstoneMap(mineBank);
  const theirsTombs = tombstoneMap(theirsBank);
  const found = [];

  for (const [word, a] of mineWords) {
    const b = theirsWords.get(word);
    if (!b) continue;
    if (stable(a) === stable(b)) continue;
    const aWins = beats(a, b);
    const kept = aWins ? a : b;
    const lost = aWins ? b : a;
    const reasons = losses(kept, lost);
    if (!reasons.length) continue;
    found.push({
      word,
      kind: "edit",
      keptSide: aWins ? mine : theirs,
      lostSide: aWins ? theirs : mine,
      kept,
      lost,
      reasons,
      at,
      id: `${word}:${digest(kept)}:${digest(lost)}`,
    });
  }

  // A delete on one side that swallows a later edit on the other.
  for (const [tombs, words, deletedSide, editedSide] of [
    [mineTombs, theirsWords, mine, theirs],
    [theirsTombs, mineWords, theirs, mine],
  ]) {
    for (const [word, tomb] of tombs) {
      const survivor = words.get(word);
      if (!survivor) continue;
      if (tomb.at <= (survivor.created ?? 0)) continue; // re-added; the delete lost
      if ((survivor.updated ?? 0) <= tomb.at) continue; // the edit predates the delete
      found.push({
        word,
        kind: "delete",
        keptSide: deletedSide,
        lostSide: editedSide,
        kept: null,
        lost: survivor,
        reasons: [`deleted on ${deletedSide} after it was edited on ${editedSide}`],
        at,
        id: `${word}:deleted:${tomb.at}:${digest(survivor)}`,
      });
    }
  }

  found.sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : 0));
  return found;
}

/* ---- the log ---- */

/**
 * Folds fresh detections into the existing log, newest first.
 *
 * Deduplication is by `id`, which folds in the two copies' content: the same
 * unresolved conflict seen on every five-minute poll stays one entry, while a
 * genuinely new divergence of the same word is a new one.
 *
 * A conflict that has been dealt with stays dealt with. Detection is
 * stateless and re-derives from whatever is on each channel, so a peer file
 * belonging to a machine that is off — or simply slow to write back — keeps
 * producing the identical finding every few seconds. Carrying `dismissed`
 * forward is what stops a resolved conflict reappearing until the two ends
 * genuinely converge.
 */
export function foldConflicts(existing, fresh, limit = CONFLICT_LOG_LIMIT) {
  const prior = new Map((existing ?? []).map((e) => [e.id, e]));
  const byId = new Map();
  for (const entry of fresh) {
    byId.set(entry.id, prior.get(entry.id)?.dismissed ? { ...entry, dismissed: true } : entry);
  }
  for (const [id, entry] of prior) {
    if (!byId.has(id)) byId.set(id, entry);
  }
  return [...byId.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
}

/**
 * The log holds word records, so it is stored the way everything else that
 * holds word records is stored: encrypted under the session key, and never
 * synced. A conflict is a fact about *this* device's reconciliation history;
 * shipping it to the other end would only create more of them.
 */
export async function loadConflictLog(key) {
  try {
    const envelope = await storeGet(LOG_KEY);
    if (!envelope) return [];
    const entries = await decryptJSON(key, envelope);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return []; // a different password, or nothing there — an empty log is correct
  }
}

export async function saveConflictLog(key, entries) {
  await storeSet(LOG_KEY, await encryptJSON(key, entries.slice(0, CONFLICT_LOG_LIMIT)));
}

export async function clearConflictLog() {
  await storeRemove(LOG_KEY);
}
