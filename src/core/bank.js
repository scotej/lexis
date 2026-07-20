/**
 * The bank model: words, today's checklist, and the sync bookkeeping that
 * lets two devices reconcile without a server.
 *
 * Every record carries an `updated` stamp (epoch milliseconds) and deletes
 * leave tombstones, so a merge can tell "changed here" from "deleted there"
 * without either side having to be online at the same time.
 */

import { newSrs, apply as applySrs, todayISO, daysBetween } from "./srs.js";

export const SCHEMA_VERSION = 2;
export const TODAY_TARGET = 10;

/** Tombstones older than this are pruned; well past any plausible offline gap. */
const TOMBSTONE_TTL_DAYS = 180;

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
    if (!Array.isArray(w.synonyms)) w.synonyms = [];
    if (!Array.isArray(w.senses)) w.senses = [];
  }
  if (out.today && typeof out.today.updated !== "number") {
    const t = Date.parse(`${out.today.date}T00:00:00`);
    out.today.updated = Number.isNaN(t) ? 0 : t;
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
    const words = bank.words
      .map((w) => ({ due: w.srs.due, word: w.word }))
      .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.word < b.word ? -1 : 1))
      .slice(0, TODAY_TARGET)
      .map((c) => c.word);
    bank.today = { date, words, ticked: [], updated: Date.now() };
    return true;
  }
  // Drop anything deleted from the bank since the list was made.
  const t = bank.today;
  const before = t.words.length + t.ticked.length;
  t.words = t.words.filter((w) => bank.words.some((b) => b.word === w));
  t.ticked = t.ticked.filter((w) => t.words.includes(w));

  // Top the list back up. Words can arrive after the list was built — most
  // often synced in from the other device — and without this they'd wait
  // until tomorrow to be practised, which reads as sync half-working.
  // Existing entries keep their order; only the tail grows.
  if (t.words.length < TODAY_TARGET) {
    const already = new Set(t.words);
    const fill = bank.words
      .filter((w) => !already.has(w.word))
      .sort((a, b) =>
        a.srs.due < b.srs.due ? -1 : a.srs.due > b.srs.due ? 1 : a.word < b.word ? -1 : 1
      )
      .slice(0, TODAY_TARGET - t.words.length)
      .map((w) => w.word);
    t.words.push(...fill);
  }

  if (t.words.length + t.ticked.length === before) return false;
  t.updated = Date.now();
  return true;
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
    added: today,
    srs: newSrs(today),
    times_used: 0,
    // `updated` moves on every edit; `created` only when the word is added.
    updated: now,
    created: now,
  };
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
