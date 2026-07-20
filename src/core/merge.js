/**
 * Reconciling two copies of the bank.
 *
 * There is no server to arbitrate, so both devices merge the whole blob
 * locally. A vocabulary bank is small (kilobytes), so this stays cheap and
 * avoids an operation log entirely.
 *
 * The rules, in order of subtlety:
 *
 *   - A word present on both sides resolves to whichever copy was edited
 *     last (`updated`, epoch ms).
 *   - A delete leaves a tombstone. The word stays deleted only while the
 *     tombstone is newer than the surviving copy of the word — so deleting
 *     on one device wins over an older edit on the other, but *re-adding*
 *     a word later wins over the old delete.
 *   - Today's checklist is derived state, not a source of truth: the later
 *     date wins outright, and within the same day the two tick-lists are
 *     unioned. Union rather than last-write-wins because ticking is
 *     monotonic — a tick represents writing you actually did, and losing it
 *     would silently undo a review.
 *
 * Clock skew between devices can misorder edits made within seconds of each
 * other on the same record. For a single user moving between their own
 * machines this is acceptable; nothing is ever lost, at worst one of two
 * near-simultaneous edits to the *same word* is superseded.
 */

import { migrate, pruneTombstones, SCHEMA_VERSION } from "./bank.js";
import { todayISO } from "./srs.js";

/** A word that has never been reviewed or used carries no history to lose. */
function pristine(w) {
  const s = w.srs ?? {};
  return !s.last && (s.reps ?? 0) === 0 && (s.lapses ?? 0) === 0 && (w.times_used ?? 0) === 0;
}

/**
 * Order-independent comparison of two copies of the same word: does `a`
 * replace `b`?
 *
 * Three rules, in order:
 *
 *  1. A copy with review history beats a pristine one. Re-typing a word that
 *     another device already knows mints a brand-new record whose `updated` is
 *     "now", which would otherwise win on recency and wipe out months of
 *     scheduling. Note this tests "never reviewed at all", not "reps === 0" —
 *     a lapsed word graded *again* has reps 0 but real history (lapses, last),
 *     and must not be treated as disposable.
 *  2. Otherwise the most recently edited copy wins.
 *  3. Ties fall back to a stable serialisation. Two devices can genuinely tie —
 *     an upgraded v1 bank derives `updated` from the date the word was added,
 *     so untouched words tie exactly. Without a deterministic tiebreak each
 *     device keeps its own copy forever, the banks never converge, and both
 *     push a fresh commit on every poll.
 */
function beats(a, b) {
  const ap = pristine(a);
  const bp = pristine(b);
  if (ap !== bp) return bp;
  const au = a.updated ?? 0;
  const bu = b.updated ?? 0;
  if (au !== bu) return au > bu;
  return stable(a) > stable(b);
}

/** Canonical, key-order-independent serialisation. Also used to skip no-op pushes. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function latestTombstones(a, b) {
  const map = new Map();
  for (const d of [...(a.deleted ?? []), ...(b.deleted ?? [])]) {
    const prev = map.get(d.word);
    if (!prev || d.at > prev.at) map.set(d.word, { word: d.word, at: d.at });
  }
  return map;
}

export function mergeBanks(localRaw, remoteRaw, today = todayISO()) {
  const local = migrate(localRaw);
  const remote = migrate(remoteRaw);

  const tombs = latestTombstones(local, remote);

  // Winning copy of each word.
  const words = new Map();
  for (const w of [...local.words, ...remote.words]) {
    const prev = words.get(w.word);
    if (!prev || beats(w, prev)) words.set(w.word, w);
  }

  // Apply tombstones, and drop the ones the word has outlived (re-added).
  //
  // The comparison is against `created`, not `updated`. Reviewing a word bumps
  // `updated`, so comparing against it would read "deleted on my laptop,
  // reviewed on my phone" as a deliberate re-add — silently undoing the delete
  // and, worse, discarding the tombstone so no later merge could re-apply it.
  // Only a genuine re-add moves `created`.
  const survivors = [];
  for (const [key, w] of words) {
    const tomb = tombs.get(key);
    if (tomb && tomb.at > (w.created ?? 0)) continue; // still deleted
    if (tomb) tombs.delete(key); // re-added after the delete
    survivors.push(w);
  }
  survivors.sort((a, b) =>
    a.added > b.added ? -1 : a.added < b.added ? 1 : a.word < b.word ? -1 : 1
  );

  // Today's checklist.
  let todayList = null;
  const lt = local.today;
  const rt = remote.today;
  if (lt && rt) {
    if (lt.date === rt.date) {
      todayList = {
        date: lt.date,
        words: [...new Set([...lt.words, ...rt.words])],
        ticked: [...new Set([...lt.ticked, ...rt.ticked])],
        updated: Math.max(lt.updated ?? 0, rt.updated ?? 0),
      };
    } else {
      todayList = lt.date > rt.date ? lt : rt;
    }
  } else {
    todayList = lt ?? rt ?? null;
  }

  // A checklist can only reference words that survived the merge.
  if (todayList) {
    const alive = new Set(survivors.map((w) => w.word));
    todayList = {
      ...todayList,
      words: todayList.words.filter((w) => alive.has(w)),
      ticked: todayList.ticked.filter((w) => alive.has(w)),
    };
  }

  const merged = {
    version: SCHEMA_VERSION,
    words: survivors,
    deleted: [...tombs.values()],
    today: todayList,
  };
  pruneTombstones(merged, today);
  return merged;
}
