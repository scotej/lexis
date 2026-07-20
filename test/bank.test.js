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

test("migrating a v1 bank dates its words from when they were added", () => {
  const migrated = bank.migrate({
    words: [{ word: "demise", added: "2026-07-01", srs: newSrs("2026-07-01"), senses: [] }],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.words[0].updated, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(migrated.words[0].created, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(migrated.words[0].times_used, 0);
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
  const w = bank.newWord("demise", { senses: [], source: "t", source_url: "u" }, [], DAY);
  assert.equal(typeof w.created, "number");
  assert.equal(w.created, w.updated);
});
