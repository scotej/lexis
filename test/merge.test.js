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
    essay_uses: 0,
    essay_use_events: {},
    updated,
    definition_updated: updated,
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

test("dictionary refresh and review history merge independently", () => {
  const clarifiedOnStaleDevice = word("poignantly", t(200), {
    created: t(100),
    definition_updated: t(900),
    times_used: 2,
    srs: {
      reps: 2,
      lapses: 0,
      ease: 2.5,
      interval: 6,
      due: "2026-07-26",
      last: "2026-07-19",
    },
    senses: [
      {
        pos: "adverb",
        def: "Depending on context: movingly or touchingly.",
        example: null,
      },
    ],
    source: "Wiktionary · clarification via Datamuse",
    source_url: "https://en.wiktionary.org/wiki/poignantly",
    clarification_url: "https://api.datamuse.com/words?ml=poignantly",
  });
  const reviewedOnOtherDevice = word("poignantly", t(800), {
    created: t(100),
    definition_updated: t(100),
    times_used: 8,
    srs: {
      reps: 6,
      lapses: 1,
      ease: 2.4,
      interval: 40,
      due: "2026-08-30",
      last: DAY,
    },
    senses: [{ pos: "adverb", def: "In a poignant manner.", example: null }],
    source: "Wiktionary",
    source_url: "https://en.wiktionary.org/wiki/poignantly",
  });

  for (const merged of [
    mergeBanks(bank([clarifiedOnStaleDevice]), bank([reviewedOnOtherDevice]), DAY),
    mergeBanks(bank([reviewedOnOtherDevice]), bank([clarifiedOnStaleDevice]), DAY),
  ]) {
    const result = merged.words[0];
    assert.equal(result.updated, t(800), "newer review/base state wins its own clock");
    assert.equal(result.times_used, 8);
    assert.equal(result.srs.reps, 6);
    assert.equal(result.srs.interval, 40);
    assert.equal(
      result.senses[0].def,
      "Depending on context: movingly or touchingly.",
      "newer dictionary state survives independently"
    );
    assert.equal(result.source, "Wiktionary · clarification via Datamuse");
    assert.equal(result.definition_updated, t(900));
  }
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
  assert.equal(merged.version, 3);
  assert.ok(typeof merged.words[0].updated === "number");
  assert.equal(merged.words[0].definition_updated, merged.words[0].created);
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

test("essay usage merges independently without replacing a newer schedule", () => {
  const current = word("demise", t(900), {
    essay_uses: 1,
    essay_use_events: { current: 1 },
    phonetic: "/new/",
    srs: { reps: 4, lapses: 0, ease: 2.5, interval: 12, due: "2026-08-01", last: DAY },
  });
  const staleWithMoreUses = word("demise", t(100), {
    essay_uses: 7,
    essay_use_events: { stale: 7 },
    phonetic: "/old/",
  });

  const merged = mergeBanks(bank([current]), bank([staleWithMoreUses]), DAY).words[0];
  assert.equal(merged.phonetic, "/new/", "the newer base record still wins");
  assert.equal(merged.srs.reps, 4, "its SRS history is not replaced by essay metadata");
  assert.equal(merged.essay_uses, 8, "independent essay events are merged separately");
});

test("concurrent offline essay logs are additive and shared events are not doubled", () => {
  const local = word("demise", t(200), {
    essay_uses: 7,
    essay_use_events: { shared: 5, local: 2 },
  });
  const remote = word("demise", t(100), {
    essay_uses: 8,
    essay_use_events: { shared: 5, remote: 3 },
  });

  const merged = mergeBanks(bank([local]), bank([remote]), DAY).words[0];
  assert.deepEqual(merged.essay_use_events, { local: 2, remote: 3, shared: 5 });
  assert.equal(merged.essay_uses, 10);
});

test("essay-only metadata cannot make an older base word beat a newer one", () => {
  const newer = word("demise", t(900), { phonetic: "/new/" });
  const older = word("demise", t(100), {
    phonetic: "/old/",
    essay_uses: 5,
    essay_use_events: { oldLog: 5 },
  });

  const merged = mergeBanks(bank([newer]), bank([older]), DAY).words[0];
  assert.equal(merged.phonetic, "/new/");
  assert.equal(merged.essay_uses, 5);
});

test("a manual same-day refresh replaces a stale selection during sync", () => {
  const words = [word("demise", t(100)), word("cessation", t(100)), word("hubris", t(100))];
  const stale = bank(words, [], {
    date: DAY,
    words: ["demise", "hubris"],
    ticked: ["hubris"],
    updated: t(200),
    refreshed: 0,
  });
  const refreshed = bank(words, [], {
    date: DAY,
    words: ["cessation", "hubris"],
    ticked: ["cessation"],
    updated: t(300),
    refreshed: t(300),
  });

  for (const merged of [
    mergeBanks(stale, refreshed, DAY),
    mergeBanks(refreshed, stale, DAY),
  ]) {
    assert.deepEqual(merged.today.words, ["cessation", "hubris"]);
    assert.deepEqual(merged.today.ticked.sort(), ["cessation", "hubris"]);
    assert.equal(merged.today.refreshed, t(300));
  }
});

test("equal refresh stamps converge to one bounded checklist in either direction", () => {
  const words = Array.from({ length: 12 }, (_, i) => word(`w${i}`, t(100)));
  const a = bank(words, [], {
    date: DAY,
    words: words.slice(0, 10).map((item) => item.word),
    ticked: ["w1"],
    updated: t(300),
    refreshed: t(250),
  });
  const b = bank(words, [], {
    date: DAY,
    words: words.slice(2, 12).map((item) => item.word),
    ticked: ["w2"],
    updated: t(300),
    refreshed: t(250),
  });

  const ab = mergeBanks(a, b, DAY);
  const ba = mergeBanks(b, a, DAY);
  assert.deepEqual(ab.today, ba.today);
  assert.equal(ab.today.words.length, 10);
  assert.deepEqual(ab.today.ticked, ["w1", "w2"], "day-wide completion history is retained");
});

test("identical refreshed lists with different cursors still converge", () => {
  const words = Array.from({ length: 12 }, (_, i) => word(`w${i}`, t(100)));
  const list = words.slice(0, 10).map((item) => item.word);
  const a = bank(words, [], {
    date: DAY,
    words: list,
    ticked: [],
    updated: t(300),
    refreshed: t(250),
    cursor: 1,
  });
  const b = bank(words, [], {
    date: DAY,
    words: list,
    ticked: [],
    updated: t(300),
    refreshed: t(250),
    cursor: 7,
  });

  const ab = mergeBanks(a, b, DAY);
  const ba = mergeBanks(b, a, DAY);
  assert.deepEqual(ab, ba);
  assert.equal(ab.today.cursor, 7);
});