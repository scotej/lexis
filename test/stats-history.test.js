import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/core/app.js";
import * as bankModel from "../src/core/bank.js";
import { mergeBanks } from "../src/core/merge.js";
import { buildStats } from "../src/core/stats.js";

const DAY = "2026-08-11";

function entry(word, added = DAY) {
  return bankModel.newWord(
    word,
    {
      phonetic: null,
      senses: [{ pos: "noun", def: `${word} definition`, example: null }],
      source: "test",
      source_url: "https://example.invalid",
    },
    [],
    added
  );
}

function memoryStorage(initial) {
  let stored = structuredClone(initial);
  return {
    async load() {
      return structuredClone(stored);
    },
    async save(next) {
      stored = structuredClone(next);
    },
    snapshot() {
      return structuredClone(stored);
    },
  };
}

test("deleting a word preserves additions, reviews, essay uses, and streak history", async () => {
  const bank = bankModel.emptyBank();
  bank.words = [entry("demise", "2026-08-10")];
  bankModel.grade(bank, "demise", "again", DAY);
  bankModel.grade(bank, "demise", "good", DAY);
  bankModel.logEssayUses(bank, [{ word: "demise", count: 3 }], "essay-1");

  const storage = memoryStorage(bank);
  const app = createApp(storage);
  await app.init();
  await app.deleteWord("demise");

  const stats = buildStats(app.getBank(), DAY, 2);
  assert.deepEqual(stats.totals, { words: 0, reviews: 2, essay_uses: 3, streak: 2 });
  assert.deepEqual(stats.window, { added: 1, reviews: 2, active_days: 2 });
  assert.ok(storage.snapshot().activity_archive, "archive is persisted with the deletion");

  const reloaded = createApp(storage);
  await reloaded.init();
  assert.deepEqual(buildStats(reloaded.getBank(), DAY, 2), stats, "archive survives reload migration");
});

test("a tombstone from an older client archives the disappearing word during merge", () => {
  const word = entry("demise", "2026-08-10");
  word.created = 100;
  const local = { version: 3, words: [word], deleted: [], today: null };
  bankModel.grade(local, "demise", "good", DAY);
  local.words[0].updated = 150;
  local.words[0].review_events_updated = 150;

  const remote = {
    version: 3,
    words: [],
    deleted: [{ word: "demise", at: 200 }],
    today: null,
  };

  const merged = mergeBanks(local, remote, DAY);
  const stats = buildStats(merged, DAY, 2);
  assert.equal(merged.words.length, 0);
  assert.deepEqual(stats.totals, { words: 0, reviews: 1, essay_uses: 0, streak: 2 });
  assert.deepEqual(stats.window, { added: 1, reviews: 1, active_days: 2 });
});

test("same-day reviews from an older client are inferred once from the coverage marker", () => {
  const word = entry("demise", "2026-08-10");
  const bank = { version: 3, words: [word], deleted: [], today: null };
  bankModel.grade(bank, "demise", "good", DAY);
  bank.words[0].created = 10;
  bank.words[0].updated = 100;
  bank.words[0].review_events_updated = 100;

  const remote = structuredClone(bank);
  remote.words[0].updated = 200;
  remote.words[0].srs.reps += 1;
  remote.words[0].srs.interval = 6;

  const merged = mergeBanks(bank, remote, DAY);
  assert.equal(Object.keys(merged.words[0].review_events).length, 2);
  assert.equal(merged.words[0].review_events_updated, 200);

  const mergedAgain = mergeBanks(merged, remote, DAY);
  assert.equal(Object.keys(mergedAgain.words[0].review_events).length, 2, "re-merging is idempotent");
});

test("new-client reviews stamp their event history through the word update", async () => {
  const bank = bankModel.emptyBank();
  bank.words = [entry("demise")];
  const storage = memoryStorage(bank);
  const app = createApp(storage);
  await app.init();

  const reviewed = await app.gradeWord("demise", "good");
  assert.equal(reviewed.review_events_updated, reviewed.updated);
  assert.equal(Object.keys(reviewed.review_events).length, 1);
});
