import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeBanks } from "../src/core/merge.js";
import { newSrs } from "../src/core/srs.js";

const DAY = "2026-07-20";

// Timestamps must sit near DAY: tombstones older than the retention window
// are pruned, so 1970-era epoch values would be discarded before a test could
// observe them. `t(0)` is that morning; higher numbers are later edits.
const BASE = Date.parse("2026-07-20T09:00:00");
const t = (n) => BASE + n;

function word(name, updated, extra = {}) {
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
    updated,
    created: updated,
    ...extra,
  };
}

function bank(words, deleted = [], today = null) {
  return { version: 2, words, deleted, today };
}

test("words unique to each side are both kept", () => {
  const merged = mergeBanks(bank([word("demise", t(100))]), bank([word("cessation", t(100))]), DAY);
  const names = merged.words.map((w) => w.word).sort();
  assert.deepEqual(names, ["cessation", "demise"]);
});

test("the most recently edited copy of a shared word wins", () => {
  const local = bank([word("demise", t(200), { times_used: 5 })]);
  const remote = bank([word("demise", t(100), { times_used: 1 })]);
  const merged = mergeBanks(local, remote, DAY);
  assert.equal(merged.words.length, 1);
  assert.equal(merged.words[0].times_used, 5);
});

test("edit direction does not depend on argument order", () => {
  const local = bank([word("demise", t(100), { times_used: 1 })]);
  const remote = bank([word("demise", t(200), { times_used: 5 })]);
  assert.equal(mergeBanks(local, remote, DAY).words[0].times_used, 5);
  assert.equal(mergeBanks(remote, local, DAY).words[0].times_used, 5);
});

test("a delete beats an older edit on the other device", () => {
  const local = bank([], [{ word: "demise", at: t(300) }]);
  const remote = bank([word("demise", t(200))]);
  const merged = mergeBanks(local, remote, DAY);
  assert.equal(merged.words.length, 0);
  assert.equal(merged.deleted.length, 1);
});

test("re-adding a word after a delete beats the old tombstone", () => {
  // The delete happened at 300; the word was typed in again at 400, which is
  // what moves `created`.
  const local = bank([word("demise", t(400))], [{ word: "demise", at: t(300) }]);
  const remote = bank([], [{ word: "demise", at: t(300) }]);
  const merged = mergeBanks(local, remote, DAY);
  assert.deepEqual(merged.words.map((w) => w.word), ["demise"]);
  assert.equal(merged.deleted.length, 0, "the outlived tombstone is cleared");
});

test("a word deleted on both devices stays deleted", () => {
  const merged = mergeBanks(
    bank([], [{ word: "demise", at: t(300) }]),
    bank([], [{ word: "demise", at: t(310) }]),
    DAY
  );
  assert.equal(merged.words.length, 0);
  assert.equal(merged.deleted.length, 1);
  assert.equal(merged.deleted[0].at, t(310), "the later tombstone is kept");
});

test("ticks made on two devices the same day are unioned, never lost", () => {
  const local = bank(
    [word("demise", t(100)), word("cessation", t(100))],
    [],
    { date: DAY, words: ["demise", "cessation"], ticked: ["demise"], updated: t(100) }
  );
  const remote = bank(
    [word("demise", t(100)), word("cessation", t(100))],
    [],
    { date: DAY, words: ["demise", "cessation"], ticked: ["cessation"], updated: t(200) }
  );
  const merged = mergeBanks(local, remote, DAY);
  assert.deepEqual(merged.today.ticked.sort(), ["cessation", "demise"]);
});

test("a newer day's checklist replaces an older one outright", () => {
  const local = bank([word("demise", t(100))], [], {
    date: "2026-07-19",
    words: ["demise"],
    ticked: ["demise"],
    updated: t(100),
  });
  const remote = bank([word("demise", t(100))], [], {
    date: "2026-07-20",
    words: ["demise"],
    ticked: [],
    updated: t(200),
  });
  const merged = mergeBanks(local, remote, DAY);
  assert.equal(merged.today.date, "2026-07-20");
  assert.deepEqual(merged.today.ticked, []);
});

test("the checklist cannot reference a word the merge deleted", () => {
  const local = bank([], [{ word: "demise", at: t(500) }], {
    date: DAY,
    words: ["demise"],
    ticked: ["demise"],
    updated: t(500),
  });
  const remote = bank([word("demise", t(100))], [], {
    date: DAY,
    words: ["demise"],
    ticked: [],
    updated: t(100),
  });
  const merged = mergeBanks(local, remote, DAY);
  assert.deepEqual(merged.today.words, []);
  assert.deepEqual(merged.today.ticked, []);
});

test("merging is idempotent — syncing twice changes nothing", () => {
  const local = bank([word("demise", t(200))], [{ word: "gone", at: t(150) }]);
  const remote = bank([word("cessation", t(100))], []);
  const once = mergeBanks(local, remote, DAY);
  const twice = mergeBanks(once, remote, DAY);
  assert.deepEqual(twice, once);
});

test("a v1 bank with no sync fields merges without losing words", () => {
  // The original desktop format: no version, no `updated`, no `deleted`.
  const legacy = {
    words: [
      {
        word: "demise",
        senses: [{ pos: "noun", def: "death" }],
        synonyms: [],
        source: "test",
        source_url: "https://example.invalid",
        added: "2026-07-01",
        srs: newSrs("2026-07-01"),
      },
    ],
  };
  const merged = mergeBanks(legacy, { words: [] }, DAY);
  assert.deepEqual(merged.words.map((w) => w.word), ["demise"]);
  assert.equal(merged.version, 2);
  assert.ok(typeof merged.words[0].updated === "number");
});

test("an empty remote leaves the local bank untouched", () => {
  const local = bank([word("demise", t(100)), word("cessation", t(100))]);
  const merged = mergeBanks(local, { words: [] }, DAY);
  assert.equal(merged.words.length, 2);
});

test("stale tombstones are pruned so the file cannot grow forever", () => {
  const ancient = Date.parse("2020-01-01T00:00:00");
  const merged = mergeBanks(bank([], [{ word: "old", at: ancient }]), bank([]), DAY);
  assert.equal(merged.deleted.length, 0);
});


test("reviewing a word elsewhere does not undo a delete", () => {
  // The bug this guards: `tick` and `grade` bump `updated`, so comparing the
  // tombstone against `updated` read an ordinary review as a deliberate re-add
  // — resurrecting the word AND destroying the tombstone, so no later merge
  // could ever re-apply the delete.
  const deletedAt = t(300);
  const reviewed = word("demise", t(900), { created: t(100) }); // added long before
  const merged = mergeBanks(
    bank([], [{ word: "demise", at: deletedAt }]),
    bank([reviewed]),
    DAY
  );
  assert.deepEqual(merged.words, [], "the delete stands");
  assert.equal(merged.deleted.length, 1, "and the tombstone survives to be re-applied");
});

test("a delete followed by a real re-add still resurrects the word", () => {
  const readded = word("demise", t(900), { created: t(800) }); // created after the delete
  const merged = mergeBanks(
    bank([], [{ word: "demise", at: t(300) }]),
    bank([readded]),
    DAY
  );
  assert.deepEqual(merged.words.map((w) => w.word), ["demise"]);
  assert.equal(merged.deleted.length, 0);
});

test("re-typing a known word cannot erase its review history", () => {
  // Device B was offline and never saw the word, so the user types it again.
  // The fresh record is newer, but it is pristine — it must not win.
  const mature = word("demise", t(100), {
    created: t(100),
    times_used: 12,
    srs: { reps: 6, lapses: 1, ease: 2.4, interval: 40, due: "2026-08-30", last: "2026-07-19" },
  });
  const phantom = word("demise", t(900), { created: t(900) });
  for (const merged of [
    mergeBanks(bank([mature]), bank([phantom]), DAY),
    mergeBanks(bank([phantom]), bank([mature]), DAY),
  ]) {
    assert.equal(merged.words[0].times_used, 12, "the mature schedule survives");
    assert.equal(merged.words[0].srs.reps, 6);
  }
});

test("a lapsed word is not mistaken for a disposable one", () => {
  // Grading "again" resets reps to 0. That is real history, not a blank record,
  // and it must still win over an older copy on recency.
  const lapsed = word("demise", t(900), {
    created: t(100),
    times_used: 3,
    srs: { reps: 0, lapses: 2, ease: 2.1, interval: 0, due: DAY, last: DAY },
  });
  const stale = word("demise", t(100), {
    created: t(100),
    times_used: 3,
    srs: { reps: 5, lapses: 1, ease: 2.5, interval: 30, due: "2026-08-19", last: "2026-07-10" },
  });
  const merged = mergeBanks(bank([lapsed]), bank([stale]), DAY);
  assert.equal(merged.words[0].srs.lapses, 2, "the newer lapse is kept");
});

test("tied timestamps converge instead of diverging forever", () => {
  // An upgraded v1 bank derives `updated` from the date each word was added,
  // so untouched words tie exactly between devices. Without a deterministic
  // tiebreak each device keeps its own copy and both push on every poll.
  const a = word("demise", t(100), { created: t(100), phonetic: "/A/" });
  const b = word("demise", t(100), { created: t(100), phonetic: "/B/" });
  const ab = mergeBanks(bank([a]), bank([b]), DAY);
  const ba = mergeBanks(bank([b]), bank([a]), DAY);
  assert.deepEqual(ab, ba, "both devices reach the same bank");

  // And it stays converged: re-merging changes nothing on either side.
  assert.deepEqual(mergeBanks(ab, bank([a]), DAY), ab);
  assert.deepEqual(mergeBanks(ba, bank([b]), DAY), ba);
});
