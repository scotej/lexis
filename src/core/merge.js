/**
 * Reconciling two copies of the bank.
 *
 * There is no server to arbitrate, so both devices merge the whole blob
 * locally. A vocabulary bank is small (kilobytes), so this stays cheap and
 * avoids an operation log entirely.
 *
 * The rules, in order of subtlety:
 *
 *   - Review/base state for a word resolves by `updated` recency.
 *   - Dictionary fields resolve independently by `definition_updated`, so an
 *     automatic clarification cannot make stale review history win a merge.
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
 * near-simultaneous edits to the *same field group* is superseded.
 */

import { migrate, pruneTombstones, SCHEMA_VERSION, TODAY_TARGET } from "./bank.js";
import {
  archiveWordHistory,
  mergeActivityArchives,
  validActivityDate,
} from "./activity.js";
import { todayISO } from "./srs.js";

/** A word that has never been reviewed carries no scheduling history to lose. */
function pristine(w) {
  const s = w.srs ?? {};
  return (
    !s.last &&
    (s.reps ?? 0) === 0 &&
    (s.lapses ?? 0) === 0 &&
    (w.times_used ?? 0) === 0 &&
    Object.keys(w.review_events ?? {}).length === 0
  );
}

function mergeEssayUseEvents(a, b) {
  const ids = [...new Set([
    ...Object.keys(a.essay_use_events ?? {}),
    ...Object.keys(b.essay_use_events ?? {}),
  ])].sort();
  const events = {};
  for (const id of ids) {
    events[id] = Math.max(a.essay_use_events?.[id] ?? 0, b.essay_use_events?.[id] ?? 0);
  }
  return events;
}

function reviewMarker(word) {
  return Number.isFinite(word?.review_events_updated) ? word.review_events_updated : null;
}

function reviewSnapshot(word, peerMarker = 0) {
  const events = { ...(word.review_events ?? {}) };
  const updated = Number.isFinite(word.updated) ? word.updated : 0;
  const marker = reviewMarker(word);
  const last = word.srs?.last;
  let coveredThrough = marker ?? 0;

  // Upgraded clients stamp the word after every review. An older client keeps
  // that unknown marker when it loads the word, but its legacy grade/tick code
  // moves `updated` without moving the marker. That gap is therefore a review
  // we can recover deterministically, including another review on the same day.
  const baseline = marker ?? (Number.isFinite(peerMarker) ? peerMarker : 0);
  if (baseline > 0 && updated > baseline && validActivityDate(last)) {
    events[`compat:${Math.trunc(updated)}:${last}`] = last;
    coveredThrough = updated;
  } else if (
    marker === null &&
    updated > 0 &&
    validActivityDate(last) &&
    Object.values(events).some((date) => date === last)
  ) {
    // First upgraded observation of a legacy/pre-marker record: migrate() has
    // already represented the latest known review, so establish the baseline.
    coveredThrough = updated;
  }

  return { events, coveredThrough };
}

function mergeReviewEvents(a, b) {
  const local = reviewSnapshot(a, reviewMarker(b) ?? 0);
  const remote = reviewSnapshot(b, reviewMarker(a) ?? 0);
  const ids = [...new Set([...Object.keys(local.events), ...Object.keys(remote.events)])].sort();
  const events = {};
  for (const id of ids) {
    const localDate = local.events[id];
    const remoteDate = remote.events[id];
    events[id] = !localDate
      ? remoteDate
      : !remoteDate
        ? localDate
        : localDate >= remoteDate
          ? localDate
          : remoteDate;
  }
  return {
    events,
    coveredThrough: Math.max(local.coveredThrough, remote.coveredThrough),
  };
}

function normalizeReviewHistory(word) {
  const snapshot = reviewSnapshot(word);
  return {
    ...word,
    review_events: snapshot.events,
    ...(snapshot.coveredThrough > 0
      ? { review_events_updated: snapshot.coveredThrough }
      : {}),
  };
}

function dictionaryFields(w) {
  return {
    phonetic: w.phonetic ?? null,
    senses: w.senses,
    source: w.source,
    source_url: w.source_url,
    clarification_url: w.clarification_url ?? null,
  };
}

/** Order-independent comparison for independently versioned dictionary state. */
function definitionBeats(a, b) {
  const au = a.definition_updated ?? a.created ?? 0;
  const bu = b.definition_updated ?? b.created ?? 0;
  if (au !== bu) return au > bu;
  return stable(dictionaryFields(a)) > stable(dictionaryFields(b));
}

/** Stable, bounded union for derived checklist state. */
function mergeChecklistWords(a, b) {
  const [first, second] = stable(a) >= stable(b) ? [a, b] : [b, a];
  return [...new Set([...first, ...second])].slice(0, TODAY_TARGET);
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
  let activityArchive = mergeActivityArchives(
    localRaw?.activity_archive,
    remoteRaw?.activity_archive
  );

  const tombs = latestTombstones(local, remote);

  // Winning copy of each word.
  const words = new Map();
  for (const w of [...local.words, ...remote.words]) {
    const prev = words.get(w.word);
    if (!prev) {
      words.set(w.word, normalizeReviewHistory(w));
      continue;
    }
    const winner = beats(w, prev) ? w : prev;
    const definitionWinner = definitionBeats(w, prev) ? w : prev;
    // Dictionary state, essay usage, and review activity merge independently.
    // This keeps stale definition refreshes or metadata-only writes from
    // replacing a newer review schedule wholesale.
    const essayEvents = mergeEssayUseEvents(w, prev);
    const reviewHistory = mergeReviewEvents(w, prev);
    words.set(w.word, {
      ...winner,
      ...dictionaryFields(definitionWinner),
      definition_updated: definitionWinner.definition_updated,
      essay_use_events: essayEvents,
      essay_uses: Object.values(essayEvents).reduce((sum, count) => sum + count, 0),
      review_events: reviewHistory.events,
      ...(reviewHistory.coveredThrough > 0
        ? { review_events_updated: reviewHistory.coveredThrough }
        : {}),
    });
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
    if (tomb && tomb.at > (w.created ?? 0)) {
      // A delete changes inventory, not history. This also protects history
      // when the deletion came from an older client that did not archive it.
      activityArchive = archiveWordHistory(activityArchive, w);
      continue;
    }
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
      const localRefresh = lt.refreshed ?? 0;
      const remoteRefresh = rt.refreshed ?? 0;
      const words =
        localRefresh === remoteRefresh
          ? mergeChecklistWords(lt.words, rt.words)
          : localRefresh > remoteRefresh
            ? [...lt.words]
            : [...rt.words];
      const localPreferred = stable(lt.words) >= stable(rt.words);
      const cursor =
        localRefresh === remoteRefresh
          ? stable(lt.words) === stable(rt.words)
            ? Math.max(lt.cursor ?? 0, rt.cursor ?? 0)
            : localPreferred
              ? lt.cursor ?? 0
              : rt.cursor ?? 0
          : localRefresh > remoteRefresh
            ? lt.cursor ?? 0
            : rt.cursor ?? 0;
      todayList = {
        date: lt.date,
        words,
        ticked: [...new Set([...lt.ticked, ...rt.ticked])].sort(),
        updated: Math.max(lt.updated ?? 0, rt.updated ?? 0),
        refreshed: Math.max(localRefresh, remoteRefresh),
        cursor,
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
    activity_archive: activityArchive,
  };
  pruneTombstones(merged, today);
  return merged;
}
