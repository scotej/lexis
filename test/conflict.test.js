/**
 * What the merge had to throw away.
 *
 * `mergeBanks` always succeeds, so the only way to know a reconciliation cost
 * something is to look at what the losing copy held. These tests pin that
 * definition down at both edges: a real loss must be reported, and everything
 * the merge resolves without loss — unioned essay events, identical copies,
 * a pristine record beaten by one with history — must stay silent, or the
 * report becomes noise nobody reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFLICT_LOG_LIMIT,
  detectConflicts,
  foldConflicts,
  planResolution,
  resolvableConflicts,
} from "../src/core/conflict.js";
import { mergeBanks } from "../src/core/merge.js";
import { newSrs } from "../src/core/srs.js";

const DAY = "2026-07-20";

function word(name, patch = {}) {
  return {
    word: name,
    phonetic: null,
    senses: [{ pos: "noun", def: `${name} means something`, example: null }],
    synonyms: [],
    source: "test",
    source_url: "https://example.invalid",
    added: DAY,
    srs: newSrs(DAY),
    times_used: 0,
    essay_uses: 0,
    essay_use_events: {},
    updated: 1000,
    created: 1000,
    ...patch,
  };
}

function bank(words, deleted = []) {
  return { version: 3, words, deleted, today: null };
}

const sides = { mine: "here", theirs: "there" };

test("two identical copies are not a conflict", () => {
  const a = bank([word("demise")]);
  const b = bank([word("demise")]);
  assert.deepEqual(detectConflicts(a, b, sides), []);
});

test("a word only one side has is not a conflict", () => {
  const a = bank([word("demise")]);
  const b = bank([word("elegy")]);
  assert.deepEqual(detectConflicts(a, b, sides), []);
});

test("the losing copy's review history is reported, with the winner named", () => {
  const mine = bank([
    word("demise", {
      updated: 5000,
      srs: { ...newSrs(DAY), reps: 1 },
    }),
  ]);
  const theirs = bank([
    word("demise", {
      updated: 2000,
      srs: { ...newSrs(DAY), reps: 9, last: "2026-07-19" },
    }),
  ]);

  const [conflict] = detectConflicts(mine, theirs, sides);
  assert.equal(conflict.word, "demise");
  assert.equal(conflict.kind, "edit");
  assert.equal(conflict.keptSide, "here");
  assert.equal(conflict.lostSide, "there");
  assert.match(conflict.reasons.join(" "), /9 reps vs 1/);
  // The losing record is carried whole, because the interface offers it back.
  assert.equal(conflict.lost.srs.reps, 9);
});

test("a differing definition is reported even when nothing else changed", () => {
  const mine = bank([word("demise", { updated: 5000 })]);
  const theirs = bank([
    word("demise", {
      updated: 2000,
      senses: [{ pos: "noun", def: "a hand-written definition", example: null }],
    }),
  ]);
  const [conflict] = detectConflicts(mine, theirs, sides);
  assert.deepEqual(conflict.reasons, ["a different definition"]);
});

test("essay-use events differ without conflicting, because the merge unions them", () => {
  const mine = bank([
    word("demise", { updated: 5000, essay_use_events: { a: 2 }, essay_uses: 2 }),
  ]);
  const theirs = bank([
    word("demise", { updated: 2000, essay_use_events: { b: 3 }, essay_uses: 3 }),
  ]);

  assert.deepEqual(detectConflicts(mine, theirs, sides), []);
  // …and the merge really does keep both, which is why silence is correct.
  const merged = mergeBanks(mine, theirs);
  assert.equal(merged.words[0].essay_uses, 5);
});

test("a pristine re-add loses to a reviewed copy without being called a conflict", () => {
  // The merge already protects history here; the loser is a blank record that
  // took nothing with it, so there is nothing to report.
  const reviewed = bank([
    word("demise", { updated: 1000, srs: { ...newSrs(DAY), reps: 6, last: "2026-07-19" } }),
  ]);
  const retyped = bank([word("demise", { updated: 9000 })]);

  assert.deepEqual(detectConflicts(reviewed, retyped, sides), []);
  assert.equal(mergeBanks(reviewed, retyped).words[0].srs.reps, 6);
});

test("a delete that swallows a later edit is reported", () => {
  const deletedHere = bank([], [{ word: "demise", at: 5000 }]);
  const editedThere = bank([
    word("demise", { created: 1000, updated: 8000, srs: { ...newSrs(DAY), reps: 3 } }),
  ]);

  const [conflict] = detectConflicts(deletedHere, editedThere, sides);
  assert.equal(conflict.kind, "delete");
  assert.equal(conflict.keptSide, "here");
  assert.equal(conflict.lostSide, "there");
  assert.equal(conflict.lost.srs.reps, 3);
  // The merge agrees: the word is gone.
  assert.equal(mergeBanks(deletedHere, editedThere).words.length, 0);
});

test("a re-add that beats an old delete is not reported — nothing was lost", () => {
  const deletedHere = bank([], [{ word: "demise", at: 5000 }]);
  const readdedThere = bank([word("demise", { created: 9000, updated: 9000 })]);

  assert.deepEqual(detectConflicts(deletedHere, readdedThere, sides), []);
  assert.equal(mergeBanks(deletedHere, readdedThere).words.length, 1);
});

test("an edit made before the delete is not reported either", () => {
  const deletedHere = bank([], [{ word: "demise", at: 8000 }]);
  const staleThere = bank([word("demise", { created: 1000, updated: 3000 })]);
  assert.deepEqual(detectConflicts(deletedHere, staleThere, sides), []);
});

test("detection is symmetric: the same pair reports the same winner either way", () => {
  const a = bank([word("demise", { updated: 5000, times_used: 1 })]);
  const b = bank([word("demise", { updated: 2000, times_used: 7 })]);

  const forward = detectConflicts(a, b, { mine: "A", theirs: "B" });
  const backward = detectConflicts(b, a, { mine: "B", theirs: "A" });
  assert.equal(forward.length, 1);
  assert.equal(backward.length, 1);
  assert.equal(forward[0].keptSide, "A");
  assert.equal(backward[0].keptSide, "A");
  assert.equal(forward[0].id, backward[0].id);
});

test("the same unresolved conflict seen twice stays one log entry", () => {
  const a = bank([word("demise", { updated: 5000, times_used: 1 })]);
  const b = bank([word("demise", { updated: 2000, times_used: 7 })]);

  const first = detectConflicts(a, b, sides);
  const second = detectConflicts(a, b, sides);
  assert.equal(foldConflicts(foldConflicts([], first), second).length, 1);
});

test("a genuinely new divergence of the same word is a new entry", () => {
  const a = bank([word("demise", { updated: 5000, times_used: 1 })]);
  const b = bank([word("demise", { updated: 2000, times_used: 7 })]);
  const c = bank([word("demise", { updated: 2000, times_used: 12 })]);

  const log = foldConflicts(foldConflicts([], detectConflicts(a, b, sides)), detectConflicts(a, c, sides));
  assert.equal(log.length, 2);
});

test("the log is newest-first and bounded", () => {
  const many = Array.from({ length: CONFLICT_LOG_LIMIT + 10 }, (_, i) => ({
    id: `entry-${i}`,
    at: i,
  }));
  const log = foldConflicts([], many);
  assert.equal(log.length, CONFLICT_LOG_LIMIT);
  assert.equal(log[0].id, `entry-${CONFLICT_LOG_LIMIT + 9}`);
});

test("a dismissed conflict is not re-opened when the same divergence is seen again", () => {
  // Detection is stateless, so a peer file that never changes keeps producing
  // the identical finding. Without this, dismissing anything would be futile.
  const a = bank([word("demise", { updated: 5000, times_used: 1 })]);
  const b = bank([word("demise", { updated: 2000, times_used: 7 })]);

  const first = foldConflicts([], detectConflicts(a, b, sides));
  const dismissed = first.map((c) => ({ ...c, dismissed: true }));
  const again = foldConflicts(dismissed, detectConflicts(a, b, sides));

  assert.equal(again.length, 1);
  assert.equal(again[0].dismissed, true);
});

test("a new divergence of a word with a dismissed conflict is still reported", () => {
  const a = bank([word("demise", { updated: 5000, times_used: 1 })]);
  const b = bank([word("demise", { updated: 2000, times_used: 7 })]);
  const c = bank([word("demise", { updated: 2000, times_used: 12 })]);

  const dismissed = foldConflicts([], detectConflicts(a, b, sides)).map((x) => ({
    ...x,
    dismissed: true,
  }));
  const log = foldConflicts(dismissed, detectConflicts(a, c, sides));
  assert.equal(log.filter((x) => !x.dismissed).length, 1);
});

/* ---- dictionary state resolves on its own clock ---- */

test("the definition and the schedule can be kept from different devices", () => {
  // This is the case a single per-word verdict would misreport. `mergeBanks`
  // keeps the newer *record* and the newer *definition* independently, so the
  // two halves of the merged word can come from opposite machines.
  const mine = bank([
    word("demise", {
      updated: 5000,
      definition_updated: 1000,
      srs: { ...newSrs(DAY), reps: 1 },
    }),
  ]);
  const theirs = bank([
    word("demise", {
      updated: 2000,
      definition_updated: 9000,
      senses: [{ pos: "noun", def: "a hand-written definition", example: null }],
      srs: { ...newSrs(DAY), reps: 9, last: "2026-07-19" },
    }),
  ]);

  const found = detectConflicts(mine, theirs, sides);
  const edit = found.find((c) => c.kind === "edit");
  const definition = found.find((c) => c.kind === "definition");

  assert.ok(edit, "the discarded schedule is reported");
  assert.equal(edit.keptSide, "here");
  assert.match(edit.reasons.join(" "), /9 reps vs 1/);

  assert.ok(definition, "the discarded definition is reported separately");
  assert.equal(definition.keptSide, "there", "and against the other device");

  // The merge really does split them, which is why two entries is correct.
  const merged = mergeBanks(mine, theirs).words[0];
  assert.equal(merged.srs.reps, 1, "schedule came from here");
  assert.equal(merged.senses[0].def, "a hand-written definition", "definition came from there");
});

test("a definition conflict alone does not claim the schedule was lost", () => {
  const mine = bank([word("demise", { definition_updated: 5000 })]);
  const theirs = bank([
    word("demise", {
      definition_updated: 2000,
      senses: [{ pos: "noun", def: "a hand-written definition", example: null }],
    }),
  ]);
  const found = detectConflicts(mine, theirs, sides);
  assert.deepEqual(
    found.map((c) => c.kind),
    ["definition"]
  );
});

test("review events differ without conflicting, because the merge unions them", () => {
  const mine = bank([
    word("demise", { updated: 5000, review_events: { "review:a": "2026-07-18" } }),
  ]);
  const theirs = bank([
    word("demise", { updated: 2000, review_events: { "review:b": "2026-07-19" } }),
  ]);

  assert.deepEqual(detectConflicts(mine, theirs, sides), []);
  const merged = mergeBanks(mine, theirs).words[0];
  assert.deepEqual(Object.keys(merged.review_events).sort(), ["review:a", "review:b"]);
});

/* ---- resolving a whole list in one pass ---- */

function openEntry(word, kind, extra = {}) {
  return {
    id: `${word}:${kind}:${extra.tag ?? "1"}`,
    word,
    kind,
    reasons: [],
    kept: { word, senses: [{ pos: "noun", def: `${word} kept` }] },
    lost: { word, senses: [{ pos: "noun", def: `${word} lost` }] },
    at: extra.at ?? 1,
  };
}

test("only the newest divergence of a word and kind is worth asking about", () => {
  const newest = openEntry("demise", "edit", { tag: "new", at: 2 });
  const older = openEntry("demise", "edit", { tag: "old", at: 1 });
  const other = openEntry("candid", "edit");

  assert.deepEqual(
    resolvableConflicts([newest, older, other]).map((entry) => entry.id),
    [newest.id, other.id]
  );
  assert.deepEqual(resolvableConflicts([]), []);
});

test("restoring a record re-asserts whichever dictionary was chosen for that word", () => {
  const definition = openEntry("demise", "definition");
  const edit = openEntry("demise", "edit");

  // The definition is kept and the record restored: reinstateWord would carry
  // the rejected definition back in, so the kept one is written again.
  const kept = planResolution(
    [definition, edit],
    [
      { id: definition.id, choice: "keep", reason: "this one is fuller" },
      { id: edit.id, choice: "other", reason: "more practice" },
    ]
  );
  assert.deepEqual(
    kept.steps.map((step) => [step.kind, step.action]),
    [
      ["definition", "none"],
      ["edit", "restore-word"],
    ]
  );
  assert.deepEqual(kept.reassert, [{ word: "demise", record: definition.kept }]);

  // Both restored: the discarded definition is the one to end up with.
  const both = planResolution(
    [definition, edit],
    [
      { id: definition.id, choice: "other", reason: "" },
      { id: edit.id, choice: "other", reason: "" },
    ]
  );
  assert.deepEqual(both.reassert, [{ word: "demise", record: definition.lost }]);

  // The order the verdicts arrive in does not change where the word ends up.
  const reversed = planResolution(
    [definition, edit],
    [
      { id: edit.id, choice: "other", reason: "" },
      { id: definition.id, choice: "keep", reason: "" },
    ]
  );
  assert.deepEqual(reversed.reassert, [{ word: "demise", record: definition.kept }]);
});

test("a record restored with nothing said about its definition keeps the bank's own", () => {
  // The model answered the edit and skipped the definition, which is the
  // commonest way for a rejected dictionary to be carried back in unnoticed.
  const definition = openEntry("demise", "definition");
  const edit = openEntry("demise", "edit");
  const plan = planResolution([definition, edit], [{ id: edit.id, choice: "other", reason: "" }]);

  assert.deepEqual(plan.reassert, [{ word: "demise", record: null }]);
  assert.deepEqual(plan.unanswered, [definition.id]);
});

test("a verdict about a conflict nobody asked about is ignored, and repeats count once", () => {
  const edit = openEntry("demise", "edit");
  const plan = planResolution(
    [edit],
    [
      { id: edit.id, choice: "other", reason: "first" },
      { id: edit.id, choice: "keep", reason: "second thoughts" },
      { id: "a word from another list", choice: "other", reason: "" },
    ]
  );
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].reason, "first");
  assert.deepEqual(plan.unanswered, []);
});

test("a keep needs no work, and a delete conflict restores the whole record", () => {
  const deleted = { ...openEntry("candid", "delete"), kept: null };
  const plan = planResolution(
    [deleted],
    [{ id: deleted.id, choice: "other", reason: "it had a fortnight of reviews" }]
  );
  assert.equal(plan.steps[0].action, "restore-word");
  assert.equal(plan.steps[0].record, deleted.lost);
  assert.deepEqual(plan.reassert, [{ word: "candid", record: null }]);
});
