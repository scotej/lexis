import { test } from "node:test";
import assert from "node:assert/strict";
import * as bank from "../src/core/bank.js";
import { mergeBanks } from "../src/core/merge.js";
import { newSrs } from "../src/core/srs.js";
import { createApp } from "../src/core/app.js";

const DAY = "2026-07-20";
function entry(name, due = DAY) {
  return {
    word: name,
    phonetic: null,
    senses: [{ pos: "noun", def: `${name} means something`, example: null }],
    synonyms: [],
    source: "test",
    source_url: "https://example.invalid",
    added: DAY,
    srs: { ...newSrs(DAY), due },
    times_used: 0,
    essay_uses: 0,
    essay_use_events: {},
    updated: Date.now(),
    created: Date.now(),
  };
}

class MemoryStorage {
  constructor(value) {
    this.value = structuredClone(value);
    this.saves = 0;
    this.fail = false;
  }

  async load() {
    return structuredClone(this.value);
  }

  async save(value) {
    if (this.fail) throw new Error("disk full");
    this.value = structuredClone(value);
    this.saves += 1;
  }
}

test("app persists settings and skips no-op writes", async () => {
  const storage = new MemoryStorage(bank.emptyBank());
  const app = createApp(storage);
  await app.init();

  const updated = await app.setDailyTarget(7);
  assert.equal(updated.daily_target, 7);
  assert.equal(app.getSettings().daily_target, 7);
  assert.equal(storage.saves, 1);

  await app.setDailyTarget(7);
  assert.equal(storage.saves, 1, "saving the same target is a no-op");
});

test("failed settings persistence is transactional", async () => {
  const storage = new MemoryStorage(bank.emptyBank());
  const app = createApp(storage);
  await app.init();
  storage.fail = true;

  await assert.rejects(app.setDailyTarget(7), /disk full/);
  assert.equal(app.getSettings().daily_target, 10);
});

test("legacy data gets safe settings defaults", () => {
  const b = bank.migrate({ words: [] });
  assert.deepEqual(b.settings, { daily_target: 10, updated: 0 });
  assert.equal(bank.settingsView(b).daily_target, 10);
});

test("configured target controls new list and rotation", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 12 }, (_, i) => entry(`w${String(i).padStart(2,"0")}`));
  bank.setDailyTarget(b, 4, DAY);
  bank.ensureTodayList(b, DAY);
  assert.equal(b.today.words.length, 4);
  const first = [...b.today.words];
  bank.refreshTodayList(b, DAY);
  assert.equal(b.today.words.length, 4);
  assert.notDeepEqual(b.today.words, first);
});

test("raising target tops up and lowering waits until selection change", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 10 }, (_, i) => entry(`w${String(i).padStart(2,"0")}`));
  bank.setDailyTarget(b, 3, DAY);
  bank.ensureTodayList(b, DAY);
  assert.equal(b.today.words.length, 3);
  bank.setDailyTarget(b, 5, DAY);
  assert.equal(b.today.words.length, 5);
  bank.setDailyTarget(b, 2, DAY);
  assert.equal(b.today.words.length, 5);
  assert.equal(bank.todayView(b).can_refresh, true);
  bank.refreshTodayList(b, DAY);
  assert.equal(b.today.words.length, 2);
});

test("target validation is bounded", () => {
  const b = bank.emptyBank();
  assert.throws(() => bank.setDailyTarget(b, 0, DAY), /whole number/);
  assert.throws(() => bank.setDailyTarget(b, 101, DAY), /whole number/);
  assert.throws(() => bank.setDailyTarget(b, 1.5, DAY), /whole number/);
});

test("completed batches can expand without repeating today's words", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 8 }, (_, i) => entry(`w${String(i).padStart(2,"0")}`));
  bank.setDailyTarget(b, 3, DAY);
  bank.ensureTodayList(b, DAY);
  const first = [...b.today.words];
  assert.equal(bank.expandTodayList(b, DAY), false);
  for (const word of first) bank.tick(b, word, true, DAY);
  const completed = new Map(first.map((word) => [word, bank.find(b, word).times_used]));
  const view = bank.todayView(b);
  assert.equal(view.can_expand, true);
  assert.equal(view.next_batch_size, 3);
  assert.equal(bank.expandTodayList(b, DAY), true);
  assert.equal(b.today.words.length, 3);
  assert.equal(b.today.words.some((word) => first.includes(word)), false);
  assert.deepEqual(new Set(b.today.ticked), new Set(first));
  for (const [word, count] of completed) assert.equal(bank.find(b, word).times_used, count);
});

test("final extra batch can be smaller and expansion stops at exhaustion", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 5 }, (_, i) => entry(`w${String(i).padStart(2,"0")}`));
  bank.setDailyTarget(b, 3, DAY);
  bank.ensureTodayList(b, DAY);
  for (const word of [...b.today.words]) bank.tick(b, word, true, DAY);
  assert.equal(bank.todayView(b).next_batch_size, 2);
  bank.expandTodayList(b, DAY);
  assert.equal(b.today.words.length, 2);
  for (const word of [...b.today.words]) bank.tick(b, word, true, DAY);
  assert.equal(bank.todayView(b).can_expand, false);
  assert.equal(bank.expandTodayList(b, DAY), false);
});

test("settings merge by recency regardless of argument order", () => {
  const local = bank.emptyBank();
  const remote = bank.emptyBank();
  local.settings = { daily_target: 5, updated: 100 };
  remote.settings = { daily_target: 20, updated: 200 };
  for (const merged of [mergeBanks(local, remote, DAY), mergeBanks(remote, local, DAY)]) {
    assert.equal(merged.settings.daily_target, 20);
    assert.equal(merged.settings.updated, 200);
  }
});

test("lowered synced target does not truncate an existing same-day list", () => {
  const words = Array.from({ length: 10 }, (_, i) => entry(`w${String(i).padStart(2,"0")}`));
  const local = bank.emptyBank();
  local.words = structuredClone(words);
  local.settings = { daily_target: 5, updated: 200 };
  local.today = {
    date: DAY,
    words: words.map((word) => word.word),
    ticked: [],
    updated: 100,
    refreshed: 0,
    cursor: 0,
  };
  const remote = bank.emptyBank();
  remote.words = structuredClone(words);
  remote.settings = { daily_target: 10, updated: 100 };
  remote.today = structuredClone(local.today);
  const merged = mergeBanks(local, remote, DAY);
  assert.equal(merged.settings.daily_target, 5);
  assert.equal(merged.today.words.length, 10);
});
