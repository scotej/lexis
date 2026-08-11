import { test } from "node:test";
import assert from "node:assert/strict";
import * as bankModel from "../src/core/bank.js";
import { mergeBanks } from "../src/core/merge.js";
import { newSrs } from "../src/core/srs.js";
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

test("review events count real review actions and daily practice only once", () => {
  const bank = bankModel.emptyBank();
  bank.words = [entry("demise")];

  bankModel.tick(bank, "demise", true, DAY);
  bankModel.tick(bank, "demise", false, DAY);
  bankModel.tick(bank, "demise", true, DAY);
  assert.deepEqual(bank.words[0].review_events, { [`practice:${DAY}`]: DAY });

  bankModel.grade(bank, "demise", "again", DAY);
  bankModel.grade(bank, "demise", "good", DAY);
  const dates = Object.values(bank.words[0].review_events);
  assert.equal(dates.length, 3, "each explicit review response is its own event");
  assert.ok(dates.every((date) => date === DAY));
});

test("migration recovers the latest known review from an older bank", () => {
  const legacy = {
    words: [
      {
        word: "demise",
        added: "2026-07-01",
        senses: [],
        synonyms: [],
        srs: { ...newSrs("2026-07-01"), last: "2026-08-09", due: "2026-08-10", reps: 3 },
      },
    ],
  };

  const migrated = bankModel.migrate(legacy);
  assert.deepEqual(migrated.words[0].review_events, {
    "legacy:2026-08-09": "2026-08-09",
  });
});

test("review events from concurrent devices are unioned without duplicates", () => {
  const localWord = entry("demise", "2026-08-01");
  localWord.review_events = { shared: "2026-08-08", local: "2026-08-09" };
  localWord.srs.last = "2026-08-09";
  localWord.updated = 200;

  const remoteWord = structuredClone(localWord);
  remoteWord.review_events = { shared: "2026-08-08", remote: "2026-08-10" };
  remoteWord.srs.last = "2026-08-10";
  remoteWord.updated = 100;

  const merged = mergeBanks(
    { version: 3, words: [localWord], deleted: [], today: null },
    { version: 3, words: [remoteWord], deleted: [], today: null },
    DAY
  );

  assert.deepEqual(merged.words[0].review_events, {
    local: "2026-08-09",
    remote: "2026-08-10",
    shared: "2026-08-08",
  });
});

test("stats aggregate additions and reviews into a complete daily window", () => {
  const bank = bankModel.emptyBank();
  const alpha = entry("alpha", "2026-08-09");
  alpha.review_events = {
    a: "2026-08-09",
    b: "2026-08-10",
  };
  alpha.essay_uses = 4;
  const bravo = entry("bravo", "2026-08-10");
  bravo.review_events = { c: "2026-08-10" };
  bravo.essay_uses = 2;
  bank.words = [alpha, bravo];

  const stats = buildStats(bank, DAY, 4);
  assert.deepEqual(stats.daily, [
    { date: "2026-08-08", added: 0, reviews: 0 },
    { date: "2026-08-09", added: 1, reviews: 1 },
    { date: "2026-08-10", added: 1, reviews: 2 },
    { date: "2026-08-11", added: 0, reviews: 0 },
  ]);
  assert.deepEqual(stats.totals, { words: 2, reviews: 3, essay_uses: 6, streak: 2 });
  assert.deepEqual(stats.window, { added: 2, reviews: 3, active_days: 2 });
});

test("stats reject malformed ranges instead of silently producing nonsense", () => {
  assert.throws(() => buildStats(bankModel.emptyBank(), "2026-02-31", 30), /valid ISO date/);
  assert.throws(() => buildStats(bankModel.emptyBank(), DAY, 0), /between 1 and 366/);
  assert.throws(() => buildStats(bankModel.emptyBank(), DAY, 367), /between 1 and 366/);
});
