import { test } from "node:test";
import assert from "node:assert/strict";
import * as bank from "../src/core/bank.js";
import { newSrs } from "../src/core/srs.js";
import { sophisticationScore, stripHtml } from "../src/core/dict.js";

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
    updated: Date.now(),
    created: Date.now(),
  };
}

test("normalize accepts words, hyphens and apostrophes", () => {
  assert.equal(bank.normalize("  Demise "), "demise");
  assert.equal(bank.normalize("well-worn"), "well-worn");
  assert.equal(bank.normalize("ne'er"), "ne'er");
});

test("normalize rejects blanks, phrases and digits", () => {
  assert.throws(() => bank.normalize("   "), /type a word/);
  assert.throws(() => bank.normalize("two words"), /single word/);
  assert.throws(() => bank.normalize("word2"), /single word/);
  assert.throws(() => bank.normalize("x".repeat(41)), /single word/);
});

test("today's list takes the most overdue words first", () => {
  const b = bank.emptyBank();
  b.words = [entry("late", "2026-07-01"), entry("later", "2026-07-10"), entry("soon", "2026-08-01")];
  bank.ensureTodayList(b, DAY);
  assert.deepEqual(b.today.words, ["late", "later", "soon"]);
});

test("today's list is capped and stable within a day", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 25 }, (_, i) => entry(`w${String(i).padStart(2, "0")}`));
  bank.ensureTodayList(b, DAY);
  assert.equal(b.today.words.length, bank.TODAY_TARGET);
  const first = [...b.today.words];
  bank.ensureTodayList(b, DAY);
  assert.deepEqual(b.today.words, first, "re-running the same day must not reshuffle");
});

test("ticking a word schedules it and counts a use", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  const w = bank.find(b, "demise");
  assert.equal(w.times_used, 1);
  assert.equal(w.srs.reps, 1);
  assert.ok(w.srs.due > DAY, "a ticked word moves into the future");
});

test("un-ticking does not undo the schedule, only the checkbox", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  const dueAfterTick = bank.find(b, "demise").srs.due;
  bank.tick(b, "demise", false, DAY);
  assert.deepEqual(b.today.ticked, []);
  assert.equal(bank.find(b, "demise").srs.due, dueAfterTick);
});

test("ticking twice counts once", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  bank.tick(b, "demise", true, DAY);
  assert.equal(bank.find(b, "demise").times_used, 1);
});

test("deleting a word leaves a tombstone and clears it from today", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  bank.removeWord(b, "demise");
  assert.equal(b.words.length, 0);
  assert.deepEqual(b.deleted.map((d) => d.word), ["demise"]);
  assert.deepEqual(b.today.words, []);
});

test("re-adding a word clears its tombstone", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.removeWord(b, "demise");
  bank.insertWord(b, entry("demise"), DAY);
  assert.equal(b.deleted.length, 0);
});

test("due words are those scheduled today or earlier", () => {
  const b = bank.emptyBank();
  b.words = [entry("past", "2026-07-01"), entry("today", DAY), entry("future", "2026-08-01")];
  const due = bank.dueWords(b, DAY).map((w) => w.word);
  assert.deepEqual(due, ["past", "today"]);
});

test("bank sorting uses creation time without changing stored order", () => {
  const b = bank.emptyBank();
  const alpha = entry("alpha");
  const bravo = entry("bravo");
  const candid = entry("candid");
  alpha.created = Date.parse("2026-07-19T09:00:00Z");
  bravo.created = Date.parse("2026-07-20T09:00:00Z");
  candid.created = Date.parse("2026-07-20T10:00:00Z");
  alpha.updated = Date.parse("2026-07-21T12:00:00Z");
  b.words = [bravo, alpha, candid];
  const stored = b.words.map((word) => word.word);

  assert.deepEqual(bank.listWords(b).map((word) => word.word), ["candid", "bravo", "alpha"]);
  assert.deepEqual(bank.listWords(b, "added-oldest").map((word) => word.word), [
    "alpha",
    "bravo",
    "candid",
  ]);
  assert.deepEqual(b.words.map((word) => word.word), stored, "display sorting must not alter sync data");
});

test("legacy words fall back to their day-only added timestamp", () => {
  const b = bank.emptyBank();
  const earlier = entry("earlier");
  const later = entry("later");
  delete earlier.created;
  delete later.created;
  earlier.added = "2026-07-01";
  later.added = "2026-07-03";
  b.words = [earlier, later];

  assert.deepEqual(bank.listWords(b).map((word) => word.word), ["later", "earlier"]);
});

test("bank sorting supports alphabetical and study-oriented orders", () => {
  const b = bank.emptyBank();
  const alpha = entry("alpha", "2026-07-20");
  const bravo = entry("bravo", "2026-07-18");
  const candid = entry("candid", "2026-07-25");
  alpha.times_used = 2;
  bravo.times_used = 1;
  candid.times_used = 3;
  alpha.essay_uses = 5;
  bravo.essay_uses = 5;
  candid.essay_uses = 0;
  b.words = [candid, alpha, bravo];

  const names = (order) => bank.listWords(b, order).map((word) => word.word);
  assert.deepEqual(names("word-asc"), ["alpha", "bravo", "candid"]);
  assert.deepEqual(names("word-desc"), ["candid", "bravo", "alpha"]);
  assert.deepEqual(names("due-soonest"), ["bravo", "alpha", "candid"]);
  assert.deepEqual(names("due-latest"), ["candid", "alpha", "bravo"]);
  assert.deepEqual(names("practised-most"), ["candid", "alpha", "bravo"]);
  assert.deepEqual(names("practised-least"), ["bravo", "alpha", "candid"]);
  assert.deepEqual(names("essay-most"), ["alpha", "bravo", "candid"]);
  assert.deepEqual(names("essay-least"), ["candid", "alpha", "bravo"]);
});

test("alphabetical sorting handles valid accented words naturally", () => {
  const b = bank.emptyBank();
  b.words = [entry("zebra"), entry("éclair"), entry("apple")];

  assert.deepEqual(bank.listWords(b, "word-asc").map((word) => word.word), [
    "apple",
    "éclair",
    "zebra",
  ]);
  assert.deepEqual(bank.listWords(b, "word-desc").map((word) => word.word), [
    "zebra",
    "éclair",
    "apple",
  ]);
});

test("bank sorting rejects an unknown order", () => {
  assert.throws(() => bank.listWords(bank.emptyBank(), "surprise"), /unknown bank sort/);
});

test("migrating a v1 bank dates its words from when they were added", () => {
  const migrated = bank.migrate({
    words: [{ word: "demise", added: "2026-07-01", srs: newSrs("2026-07-01"), senses: [] }],
  });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.words[0].updated, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(migrated.words[0].created, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(migrated.words[0].times_used, 0);
  assert.equal(migrated.words[0].essay_uses, 0);
  assert.deepEqual(migrated.words[0].essay_use_events, {});
  assert.deepEqual(migrated.deleted, []);
});

test("formal words outscore plain ones", () => {
  // "cessation" (rare, Latinate) should beat "end" (short, everyday).
  assert.ok(sophisticationScore("cessation", 2.1) > sophisticationScore("end", 320));
});

test("strip_html removes tags and entities", () => {
  assert.equal(
    stripHtml("<span>Death</span> or <i>ruin</i> &amp; decline"),
    "Death or ruin & decline"
  );
});

test("ensureTodayList reports whether it changed anything", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  assert.equal(bank.ensureTodayList(b, DAY), true, "building the list is a change");
  assert.equal(bank.ensureTodayList(b, DAY), false, "re-running the same day is not");
  // Removing a word the list referenced makes it stale again.
  b.words = [];
  assert.equal(bank.ensureTodayList(b, DAY), true);
  assert.equal(bank.ensureTodayList(b, DAY), false);
});

test("a new day rebuilds the list", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  assert.equal(bank.ensureTodayList(b, "2026-07-21"), true);
  assert.equal(b.today.date, "2026-07-21");
});

test("a word that arrives after the list was built still joins it", () => {
  // The sync case: today's list exists, then the other device's words land.
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  assert.deepEqual(b.today.words, ["demise"]);

  b.words.push(entry("cessation"));
  assert.equal(bank.ensureTodayList(b, DAY), true);
  assert.deepEqual(b.today.words, ["demise", "cessation"], "appended, not reshuffled");
});

test("topping up never exceeds the daily target", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  b.words.push(...Array.from({ length: 30 }, (_, i) => entry(`w${String(i).padStart(2, "0")}`)));
  bank.ensureTodayList(b, DAY);
  assert.equal(b.today.words.length, bank.TODAY_TARGET);
  assert.equal(b.today.words[0], "demise", "the original entry keeps its place");
});

test("a ticked word is not displaced by a top-up", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  b.words.push(entry("cessation"));
  bank.ensureTodayList(b, DAY);
  assert.ok(b.today.words.includes("demise"));
  assert.deepEqual(b.today.ticked, ["demise"], "the tick survives");
});


test("migration timestamps are timezone-independent", () => {
  // These are compared across devices, so the same v1 word must migrate to the
  // same number in Melbourne and in London — otherwise the more westerly
  // device's copy looks newer and silently wins every merge.
  const migrated = bank.migrate({
    words: [{ word: "demise", added: "2026-07-01", srs: newSrs("2026-07-01"), senses: [] }],
  });
  assert.equal(migrated.words[0].updated, 1782864000000);
  assert.equal(migrated.words[0].created, 1782864000000);
});

test("ticking twice in one day cannot double-advance the schedule", () => {
  // tick → untick → tick again is an ordinary slip, and un-ticking
  // deliberately does not roll the schedule back.
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  const after = { ...bank.find(b, "demise").srs };
  bank.tick(b, "demise", false, DAY);
  bank.tick(b, "demise", true, DAY);
  const now = bank.find(b, "demise").srs;
  assert.equal(now.reps, after.reps, "one day of writing is one review");
  assert.equal(now.interval, after.interval);
  assert.equal(now.due, after.due);
  assert.equal(bank.find(b, "demise").times_used, 1);
});

test("a word already reviewed today is not advanced again by a tick", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.grade(b, "demise", "good", DAY);
  const afterGrade = { ...bank.find(b, "demise").srs };
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  assert.deepEqual(bank.find(b, "demise").srs, afterGrade);
  assert.deepEqual(b.today.ticked, ["demise"], "but it still shows as done");
});

test("a genuine re-add gets a fresh created stamp", () => {
  const b = bank.emptyBank();
  const w = bank.newWord(
    "demise",
    { senses: [], source: "t", source_url: "u", clarification_url: "c" },
    [],
    DAY
  );
  assert.equal(typeof w.created, "number");
  assert.equal(w.created, w.updated);
  assert.equal(w.clarification_url, "c");
  assert.equal(w.essay_uses, 0);
  assert.deepEqual(w.essay_use_events, {});
});

test("manually refreshing today rotates in words outside the current list", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 15 }, (_, i) => entry(`w${String(i).padStart(2, "0")}`));
  bank.ensureTodayList(b, DAY);
  const original = [...b.today.words];
  bank.tick(b, original[0], true, DAY);

  assert.equal(bank.refreshTodayList(b, DAY), true);
  assert.equal(b.today.words.length, bank.TODAY_TARGET);
  assert.notDeepEqual(b.today.words, original);
  assert.deepEqual(
    b.today.words.slice(0, 5),
    ["w10", "w11", "w12", "w13", "w14"],
    "unseen words lead the refreshed list in due order"
  );
  assert.equal(
    bank.todayView(b).items.find((item) => item.word === original[0])?.ticked,
    true,
    "a completed word remains completed if the circular page includes it"
  );
  assert.deepEqual(b.today.ticked, [original[0]], "completion remains in today's history");
  assert.equal(bank.find(b, original[0]).times_used, 1, "its practice history is preserved");
  assert.ok(b.today.refreshed > 0);
});

test("refreshing with no alternative words is a no-op", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise"), entry("cessation")];
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "demise", true, DAY);
  const before = structuredClone(b.today);

  assert.equal(bank.refreshTodayList(b, DAY), false);
  assert.deepEqual(b.today, before);
});

test("a manual refresh after midnight builds the new day's first list before rotating", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 15 }, (_, i) => entry(`w${String(i).padStart(2, "0")}`));
  bank.ensureTodayList(b, "2026-07-19");

  assert.equal(bank.refreshTodayList(b, DAY), true);
  assert.equal(b.today.date, DAY);
  assert.deepEqual(b.today.words, ["w00", "w01", "w02", "w03", "w04", "w05", "w06", "w07", "w08", "w09"]);
  assert.equal(b.today.refreshed, 0, "the automatic new-day selection is not a manual rotation");
});

test("repeated refreshes cycle through the entire bank before wrapping", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 25 }, (_, i) => entry(`w${String(i).padStart(2, "0")}`));
  bank.ensureTodayList(b, DAY);
  assert.deepEqual(b.today.words, ["w00", "w01", "w02", "w03", "w04", "w05", "w06", "w07", "w08", "w09"]);

  bank.refreshTodayList(b, DAY);
  assert.deepEqual(b.today.words, ["w10", "w11", "w12", "w13", "w14", "w15", "w16", "w17", "w18", "w19"]);

  bank.refreshTodayList(b, DAY);
  assert.deepEqual(b.today.words, ["w20", "w21", "w22", "w23", "w24", "w00", "w01", "w02", "w03", "w04"]);
});

test("a tick remains completed after its word rotates out and back in", () => {
  const b = bank.emptyBank();
  b.words = Array.from({ length: 20 }, (_, i) => entry(`w${String(i).padStart(2, "0")}`));
  bank.ensureTodayList(b, DAY);
  bank.tick(b, "w00", true, DAY);

  bank.refreshTodayList(b, DAY);
  assert.ok(!b.today.words.includes("w00"));
  bank.refreshTodayList(b, DAY);
  const returned = bank.todayView(b).items.find((item) => item.word === "w00");
  assert.equal(returned?.ticked, true);
});

test("essay uses are cumulative metadata and do not alter review state", () => {
  const b = bank.emptyBank();
  const demise = entry("demise");
  demise.updated = 12345;
  b.words = [demise];
  const schedule = structuredClone(demise.srs);

  const logged = bank.logEssayUses(
    b,
    [
      { word: "demise", count: 2 },
      { word: "demise", count: 1 },
      { word: "missing", count: 9 },
      { word: "demise", count: 0 },
    ],
    "essay-a"
  );

  assert.deepEqual(logged, [{ word: "demise", count: 3, total: 3 }]);
  assert.equal(demise.essay_uses, 3);
  assert.deepEqual(demise.essay_use_events, { "essay-a": 3 });
  assert.equal(demise.times_used, 0);
  assert.equal(demise.updated, 12345, "essay metadata cannot win whole-word sync by recency");
  assert.deepEqual(demise.srs, schedule);
});

test("the same essay event id is idempotent", () => {
  const b = bank.emptyBank();
  b.words = [entry("demise")];
  bank.logEssayUses(b, [{ word: "demise", count: 2 }], "essay-a");
  bank.logEssayUses(b, [{ word: "demise", count: 2 }], "essay-a");
  assert.equal(bank.find(b, "demise").essay_uses, 2);
});
