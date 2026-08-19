/**
 * The bank model: words, today's checklist, and the sync bookkeeping that
 * lets two devices reconcile without a server.
 *
 * Every record carries an `updated` stamp (epoch milliseconds) and deletes
 * leave tombstones, so a merge can tell "changed here" from "deleted there"
 * without either side having to be online at the same time.
 */

import { newSrs, apply as applySrs, todayISO, daysBetween } from "./srs.js";

export const SCHEMA_VERSION = 3;
export const TODAY_TARGET = 10;

/** Tombstones older than this are pruned; well past any plausible offline gap. */
export const TOMBSTONE_TTL_DAYS = 180;

export function emptyBank() {
  return { version: SCHEMA_VERSION, words: [], deleted: [], today: null };
}

export function normalize(word) {
  const w = (word ?? "").trim().toLowerCase();
  if (!w) throw new Error("type a word first");
  if (!/^[\p{L}'-]+$/u.test(w) || [...w].length > 40) {
    throw new Error("that doesn't look like a single word");
  }
  return w;
}

/**
 * Brings any older bank shape up to the current schema. v1 banks (the
 * original desktop format) have no `updated`, no `deleted`, and no
 * `version`; we date their words from when they were added so a first
 * sync doesn't spuriously win or lose against the other device.
 */
export function migrate(raw) {
  const bank = raw && typeof raw === "object" ? raw : {};
  const out = {
    version: SCHEMA_VERSION,
    words: Array.isArray(bank.words) ? bank.words : [],
    deleted: Array.isArray(bank.deleted) ? bank.deleted : [],
    today: bank.today ?? null,
  };
  for (const w of out.words) {
    // Backfills are parsed as UTC, deliberately. These are sync timestamps
    // compared across devices, so they must not depend on the timezone the
    // reader happens to be in — otherwise the same untouched word looks
    // "newer" on whichever device sits further west. (Everything the user
    // sees still runs on local dates; see srs.js. Only these two are UTC.)
    const addedUTC = Date.parse(`${w.added}T00:00:00Z`) || 0;
    if (typeof w.updated !== "number") w.updated = addedUTC;
    // `created` moves only when a word is genuinely (re-)added, never when it
    // is reviewed. That distinction is what lets a merge tell "deleted, then
    // typed in again" from "deleted here, reviewed there" — see merge.js.
    if (typeof w.created !== "number") w.created = addedUTC;
    if (typeof w.times_used !== "number") w.times_used = 0;
    // Essay totals are derived from uniquely identified log events. Unioning
    // those events during sync preserves concurrent offline additions from two
    // devices; a scalar counter cannot (max under-counts, sum double-counts).
    const events = {};
    if (
      w.essay_use_events &&
      typeof w.essay_use_events === "object" &&
      !Array.isArray(w.essay_use_events)
    ) {
      for (const [id, rawCount] of Object.entries(w.essay_use_events)) {
        const count = Math.floor(Number(rawCount));
        if (id && Number.isFinite(count) && count > 0) events[id] = count;
      }
    } else if (typeof w.essay_uses === "number" && w.essay_uses > 0) {
      // Compatibility for any pre-release/schema-v3 data written before the
      // event representation existed. Both sides use the same key so sync
      // keeps the larger legacy snapshot without counting it twice.
      events.legacy = Math.floor(w.essay_uses);
    }
    w.essay_use_events = events;
    w.essay_uses = Object.values(events).reduce((sum, count) => sum + count, 0);
    if (!Array.isArray(w.synonyms)) w.synonyms = [];
    if (!Array.isArray(w.senses)) w.senses = [];
  }
  if (out.today && typeof out.today.updated !== "number") {
    const t = Date.parse(`${out.today.date}T00:00:00`);
    out.today.updated = Number.isNaN(t) ? 0 : t;
  }
  if (out.today && typeof out.today.refreshed !== "number") {
    // Only an explicit same-day refresh moves this stamp. Ordinary ticks and
    // automatic top-ups must not let an older selection win during sync.
    out.today.refreshed = 0;
  }
  if (out.today && (!Number.isInteger(out.today.cursor) || out.today.cursor < 0)) {
    out.today.cursor = 0;
  }
  return out;
}

export function find(bank, word) {
  return bank.words.find((w) => w.word === word) ?? null;
}

/** Records a delete so the other device doesn't resurrect the word. */
export function tombstone(bank, word, now = Date.now()) {
  bank.deleted = bank.deleted.filter((d) => d.word !== word);
  bank.deleted.push({ word, at: now });
}

export function pruneTombstones(bank, today = todayISO()) {
  bank.deleted = (bank.deleted ?? []).filter((d) => {
    const age = daysBetween(isoOf(d.at), today);
    return age <= TOMBSTONE_TTL_DAYS;
  });
}

function isoOf(epochMs) {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---- today's checklist ----

function compareSchedule(a, b) {
  return a.srs.due < b.srs.due
    ? -1
    : a.srs.due > b.srs.due
      ? 1
      : a.word < b.word
        ? -1
        : a.word > b.word
          ? 1
          : 0;
}

function rankedWordNames(bank) {
  return [...bank.words].sort(compareSchedule).map((w) => w.word);
}

/**
 * Builds today's checklist if it's missing or stale.
 *
 * Returns whether it actually changed anything. Callers use that to avoid
 * marking the bank dirty on every render — otherwise simply looking at the
 * app would queue a sync, and the counts in the rail refresh constantly.
 */
export function ensureTodayList(bank, date) {
  const fresh = !bank.today || bank.today.date !== date;
  if (fresh) {
    // Due words first (most overdue at the top), then the words whose
    // review comes up soonest, until we have about ten.
    const ranked = rankedWordNames(bank);
    const words = ranked.slice(0, TODAY_TARGET);
    bank.today = {
      date,
      words,
      ticked: [],
      updated: Date.now(),
      refreshed: 0,
      cursor: ranked.length ? words.length % ranked.length : 0,
    };
    return true;
  }
  // Drop anything deleted from the bank since the list was made.
  const t = bank.today;
  const beforeWords = [...t.words];
  const beforeTicked = [...t.ticked];
  const alive = new Set(bank.words.map((word) => word.word));
  t.words = t.words.filter((word) => alive.has(word));
  // Ticks are day-wide history, not merely checkbox state for the current
  // page. A practised word must still appear completed if rotation shows it
  // again later today.
  t.ticked = t.ticked.filter((word) => alive.has(word));

  // Top the list back up. Words can arrive after the list was built — most
  // often synced in from the other device — and without this they'd wait
  // until tomorrow to be practised, which reads as sync half-working.
  // Existing entries keep their order; only the tail grows.
  if (t.words.length < TODAY_TARGET) {
    const already = new Set(t.words);
    const fill = [...bank.words]
      .filter((w) => !already.has(w.word))
      .sort(compareSchedule)
      .slice(0, TODAY_TARGET - t.words.length)
      .map((w) => w.word);
    t.words.push(...fill);
  }

  const unchanged =
    t.words.length === beforeWords.length &&
    t.words.every((word, index) => word === beforeWords[index]) &&
    t.ticked.length === beforeTicked.length &&
    t.ticked.every((word, index) => word === beforeTicked[index]);
  if (unchanged) return false;
  t.updated = Date.now();
  return true;
}

/**
 * Replaces today's selection with the next due-ranked words that are not
 * already visible, then fills any spare slots from the current selection.
 * With ten words or fewer there is nothing useful to rotate, so this is a
 * genuine no-op and does not create needless storage or sync writes.
 */
export function refreshTodayList(bank, date) {
  const sameDay = bank.today?.date === date;
  const ensured = ensureTodayList(bank, date);
  // If the app stayed open across midnight, "refresh" should first show the
  // correctly prioritised new-day list, not immediately skip past it.
  if (!sameDay) return ensured;
  const t = bank.today;
  const ranked = rankedWordNames(bank);
  if (ranked.length <= TODAY_TARGET) return ensured;

  // Before the first manual rotation, infer the position after the current
  // page. This also handles a bank that grew from ten to eleven words after
  // today's list was created. Thereafter the persisted cursor walks a circular
  // sequence of pages, so a 25-word bank reaches words 20–24 instead of
  // bouncing forever between the first two groups of ten.
  let cursor = t.refreshed
    ? (t.cursor ?? 0) % ranked.length
    : cursorAfterCurrent(ranked, t.words);
  const words = Array.from(
    { length: Math.min(TODAY_TARGET, ranked.length) },
    (_, index) => ranked[(cursor + index) % ranked.length]
  );
  t.words = words;
  t.cursor = (cursor + TODAY_TARGET) % ranked.length;
  const now = Date.now();
  t.refreshed = Math.max(now, (t.refreshed ?? 0) + 1);
  t.updated = now;
  return true;
}

function cursorAfterCurrent(ranked, current) {
  for (let index = current.length - 1; index >= 0; index--) {
    const rankedIndex = ranked.indexOf(current[index]);
    if (rankedIndex >= 0) return (rankedIndex + 1) % ranked.length;
  }
  return 0;
}

export function todayView(bank) {
  const t = bank.today ?? { date: todayISO(), words: [], ticked: [] };
  const items = t.words
    .map((w) => find(bank, w))
    .filter(Boolean)
    .map((w) => ({
      word: w.word,
      pos: w.senses[0]?.pos ?? "",
      def: w.senses[0]?.def ?? "",
      ticked: t.ticked.includes(w.word),
    }));
  return {
    date: t.date,
    items,
    remaining: items.filter((i) => !i.ticked).length,
    can_refresh: bank.words.some((word) => !t.words.includes(word.word)),
  };
}

// ---- mutations (each stamps `updated` so sync can order them) ----

export function insertWord(bank, entry, today) {
  bank.words.unshift(entry);
  // A word re-added after a delete must clear its tombstone.
  bank.deleted = (bank.deleted ?? []).filter((d) => d.word !== entry.word);
  // A brand-new word can join today's checklist if there's room.
  const t = bank.today;
  if (t && t.date === today && t.words.length < TODAY_TARGET) {
    t.words.push(entry.word);
    t.updated = Date.now();
  }
}

export function newWord(word, dict, synonyms, today) {
  const now = Date.now();
  return {
    word,
    phonetic: dict.phonetic ?? null,
    senses: dict.senses,
    synonyms,
    source: dict.source,
    source_url: dict.source_url,
    clarification_url: dict.clarification_url ?? null,
    added: today,
    srs: newSrs(today),
    times_used: 0,
    essay_uses: 0,
    essay_use_events: {},
    // `updated` moves on every edit; `created` only when the word is added.
    updated: now,
    created: now,
  };
}

/**
 * Replaces only a word's dictionary fields, preserving its review and usage
 * history. Returns false for a stale/no-op result so callers avoid needless
 * storage writes and sync pushes.
 */
export function updateDefinition(bank, word, dictionary, now = Date.now()) {
  const entry = find(bank, word);
  if (!entry) return false;

  const next = {
    phonetic: dictionary.phonetic ?? entry.phonetic ?? null,
    senses: Array.isArray(dictionary.senses) ? dictionary.senses : entry.senses,
    source: typeof dictionary.source === "string" ? dictionary.source : entry.source,
    source_url:
      typeof dictionary.source_url === "string" ? dictionary.source_url : entry.source_url,
    clarification_url:
      typeof dictionary.clarification_url === "string"
        ? dictionary.clarification_url
        : entry.clarification_url ?? null,
  };
  const current = {
    phonetic: entry.phonetic ?? null,
    senses: entry.senses,
    source: entry.source,
    source_url: entry.source_url,
    clarification_url: entry.clarification_url ?? null,
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;

  Object.assign(entry, next);
  entry.updated = Math.max(now, (entry.updated ?? 0) + 1);
  return true;
}

/**
 * Puts a losing copy of a word back — the manual half of conflict resolution.
 *
 * A merge that had to choose is reported rather than hidden (see
 * `conflict.js`), and this is what "keep the other copy instead" does. It is
 * deliberately *not* a rollback: the record is reinstated as a fresh edit made
 * now, so it wins the next merge on every channel by the ordinary rules rather
 * than by a special case that only this device would understand.
 *
 * Two details make it stick. Essay-use events are unioned rather than replaced,
 * because those were never in conflict and discarding them would turn one
 * resolved conflict into a new loss. And restoring a word that another device
 * deleted moves `created` past the tombstone — the only thing that survives a
 * merge as a genuine re-add.
 */
export function reinstateWord(bank, record, now = Date.now()) {
  const word = record.word;
  const current = find(bank, word);

  const events = { ...(record.essay_use_events ?? {}) };
  for (const [id, count] of Object.entries(current?.essay_use_events ?? {})) {
    events[id] = Math.max(events[id] ?? 0, count);
  }

  const tomb = (bank.deleted ?? []).find((d) => d.word === word);
  const entry = {
    ...record,
    essay_use_events: events,
    essay_uses: Object.values(events).reduce((sum, count) => sum + count, 0),
    // Ahead of both copies, and of any device whose clock ran ahead of ours.
    updated: Math.max(now, (current?.updated ?? 0) + 1, (record.updated ?? 0) + 1),
    created: tomb
      ? Math.max(now, tomb.at + 1)
      : current?.created ?? record.created ?? now,
  };

  if (current) {
    bank.words = bank.words.map((w) => (w.word === word ? entry : w));
    bank.deleted = (bank.deleted ?? []).filter((d) => d.word !== word);
  } else {
    insertWord(bank, entry, todayISO());
  }
  return entry;
}

export function removeWord(bank, word) {
  const had = bank.words.some((w) => w.word === word);
  bank.words = bank.words.filter((w) => w.word !== word);
  if (bank.today) {
    bank.today.words = bank.today.words.filter((w) => w !== word);
    bank.today.ticked = bank.today.ticked.filter((w) => w !== word);
    bank.today.updated = Date.now();
  }
  if (had) tombstone(bank, word);
  return had;
}

export function grade(bank, word, g, today) {
  const entry = find(bank, word);
  if (!entry) throw new Error("word not found");
  applySrs(entry.srs, g, today);
  entry.updated = Date.now();
  return entry;
}

export function tick(bank, word, ticked, today) {
  ensureTodayList(bank, today);
  const t = bank.today;
  const already = t.ticked.includes(word);
  if (ticked && !already) {
    const entry = find(bank, word);
    // Advance the schedule at most once a day, and gate it on the word's own
    // record rather than the checklist. The checklist is derived state — a
    // merge can rebuild it, and un-ticking deliberately does not roll the
    // schedule back — so tick, un-tick, tick again would otherwise count as
    // two days of practice and jump the interval from 1 day to 6.
    if (entry && entry.srs.last !== today) {
      applySrs(entry.srs, "good", today);
      entry.times_used += 1;
      entry.updated = Date.now();
    }
    t.ticked.push(word);
    t.updated = Date.now();
  } else if (!ticked && already) {
    t.ticked = t.ticked.filter((w) => w !== word);
    t.updated = Date.now();
  }
  return todayView(bank);
}

/**
 * Adds the matched occurrences from one explicitly logged essay. This counter
 * is separate from `times_used`: essay evidence must not advance the review
 * schedule unless the word is also on today's checklist.
 *
 * Deliberately does not move the word's main `updated` stamp. Sync merges this
 * monotonic statistic independently, so logging an essay on a stale device
 * cannot replace a newer definition or SRS schedule wholesale.
 */
export function logEssayUses(bank, usages, logId) {
  if (typeof logId !== "string" || !logId) throw new Error("essay log needs an id");
  const totals = new Map();
  for (const usage of usages ?? []) {
    const count = Math.floor(Number(usage?.count));
    if (typeof usage?.word !== "string" || !Number.isFinite(count) || count <= 0) continue;
    totals.set(usage.word, (totals.get(usage.word) ?? 0) + count);
  }

  const logged = [];
  for (const [word, count] of totals) {
    const entry = find(bank, word);
    if (!entry) continue;
    entry.essay_use_events ??= {};
    entry.essay_use_events[logId] = Math.max(entry.essay_use_events[logId] ?? 0, count);
    entry.essay_uses = Object.values(entry.essay_use_events).reduce(
      (sum, eventCount) => sum + eventCount,
      0
    );
    logged.push({ word, count, total: entry.essay_uses });
  }
  return logged;
}

export function dueWords(bank, today) {
  return bank.words
    .filter((w) => w.srs.due <= today)
    .sort((a, b) => (a.srs.due < b.srs.due ? -1 : a.srs.due > b.srs.due ? 1 : 0));
}

export function listWords(bank) {
  return [...bank.words].sort((a, b) =>
    a.added > b.added ? -1 : a.added < b.added ? 1 : a.word < b.word ? -1 : 1
  );
}
