/**
 * The settings schema, the record book, and the generated word runs.
 *
 * The schema is the single description of every knob, so the tests worth
 * having are the ones that would catch it drifting away from the engine it
 * configures — a stored blob from a future version, a value the panel offers
 * that the engine has never heard of, an empty set of quote lengths that would
 * filter the corpus down to nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TYPING_SETTINGS,
  SETTINGS_ITEMS,
  describeTest,
  engineSettings,
  normalizeTypingSettings,
  settingApplies,
  testKey,
} from "../src/core/typing-settings.js";
import {
  bankWordTotals,
  emptyRecords,
  normalizeRecords,
  recordResult,
  summarize,
} from "../src/core/typing-records.js";
import { generateWords } from "../src/core/word-runs.js";
import { CONFIDENCE_MODES, DIFFICULTIES, STOP_ON_ERROR, createRun } from "../src/core/typing.js";

/* ---- the schema ---- */

test("every setting has a unique key and a usable default", () => {
  const keys = SETTINGS_ITEMS.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate setting keys");
  for (const item of SETTINGS_ITEMS) {
    assert.notEqual(item.fallback, undefined, `${item.key} has no default`);
    if (item.kind === "choice") {
      assert.ok(
        item.options.some((option) => option.value === item.fallback),
        `${item.key} defaults to something it does not offer`
      );
    }
  }
});

test("the defaults are already valid, without normalization", () => {
  assert.deepEqual(normalizeTypingSettings(DEFAULT_TYPING_SETTINGS), { ...DEFAULT_TYPING_SETTINGS });
});

test("the panel cannot offer a value the engine has never heard of", () => {
  const item = (key) => SETTINGS_ITEMS.find((entry) => entry.key === key);
  const values = (key) => item(key).options.map((option) => option.value);
  assert.deepEqual(values("difficulty"), DIFFICULTIES);
  assert.deepEqual(values("stopOnError"), STOP_ON_ERROR);
  assert.deepEqual(values("confidenceMode"), CONFIDENCE_MODES);
});

test("a stored blob from another version is repaired, not trusted", () => {
  const settings = normalizeTypingSettings({
    mode: "interpretive dance",
    caretStyle: "blinky",
    time: "60",
    fontSize: 99,
    minWpm: -20,
    quoteLengths: ["short", "enormous"],
    freedomMode: "yes please",
    nonsense: true,
  });
  assert.equal(settings.mode, DEFAULT_TYPING_SETTINGS.mode);
  assert.equal(settings.caretStyle, DEFAULT_TYPING_SETTINGS.caretStyle);
  assert.equal(settings.time, 60, "a numeric choice arrives as a string from a form");
  assert.equal(settings.fontSize, 2.4, "clamped, not rejected");
  assert.equal(settings.minWpm, 0);
  assert.deepEqual(settings.quoteLengths, ["short"], "the unknown length is dropped");
  assert.equal(settings.freedomMode, false);
  assert.equal("nonsense" in settings, false, "unknown keys do not survive");
});

test("an empty set of quote lengths falls back rather than matching nothing", () => {
  assert.deepEqual(
    normalizeTypingSettings({ quoteLengths: [] }).quoteLengths,
    DEFAULT_TYPING_SETTINGS.quoteLengths
  );
});

test("settings that cannot apply are hidden", () => {
  const quote = { ...DEFAULT_TYPING_SETTINGS, mode: "quote", bankFilter: "off" };
  const timed = { ...DEFAULT_TYPING_SETTINGS, mode: "time" };
  const find = (key) => SETTINGS_ITEMS.find((item) => item.key === key);

  assert.equal(settingApplies(find("quoteLengths"), quote), true);
  assert.equal(settingApplies(find("quoteLengths"), timed), false);
  assert.equal(settingApplies(find("punctuation"), timed), true);
  assert.equal(settingApplies(find("punctuation"), quote), false);
  assert.equal(settingApplies(find("minBankWords"), quote), false, "hidden while the filter is off");
  assert.equal(settingApplies(find("minBankWords"), { ...quote, bankFilter: "bank" }), true);
  assert.equal(settingApplies(find("caretStyle"), timed), true, "appearance always applies");
});

test("the engine is handed the rules and none of the decoration", () => {
  const engine = engineSettings(DEFAULT_TYPING_SETTINGS);
  assert.equal("caretStyle" in engine, false);
  assert.equal("liveWpm" in engine, false);
  assert.equal(engine.difficulty, "normal");
  // Everything the engine reads must actually be supplied.
  const run = createRun({ text: "one two", settings: engine });
  run.type("o");
  assert.equal(run.status, "running");
});

/* ---- comparing like with like ---- */

test("only tests that asked the same thing share a personal best", () => {
  const base = { ...DEFAULT_TYPING_SETTINGS, mode: "time", time: 60 };
  assert.equal(testKey(base), testKey({ ...base }));
  assert.notEqual(testKey(base), testKey({ ...base, time: 30 }));
  assert.notEqual(testKey(base), testKey({ ...base, punctuation: true }));
  assert.notEqual(testKey(base), testKey({ ...base, difficulty: "expert" }));
  assert.equal(
    testKey(base),
    testKey({ ...base, caretStyle: "block", liveWpm: true }),
    "appearance cannot change a score"
  );
});

test("quote length is part of the key, in a stable order", () => {
  const a = { ...DEFAULT_TYPING_SETTINGS, mode: "quote", quoteLengths: ["short", "long"] };
  const b = { ...DEFAULT_TYPING_SETTINGS, mode: "quote", quoteLengths: ["long", "short"] };
  assert.equal(testKey(a), testKey(b));
});

test("a test describes itself readably", () => {
  assert.equal(describeTest({ ...DEFAULT_TYPING_SETTINGS, mode: "time", time: 15 }), "15 seconds");
  assert.equal(describeTest({ ...DEFAULT_TYPING_SETTINGS, mode: "words", wordCount: 25 }), "25 words");
  assert.equal(
    describeTest({ ...DEFAULT_TYPING_SETTINGS, mode: "quote", quoteLengths: ["thicc", "short"] }),
    "quote — short, thicc"
  );
});

/* ---- the record book ---- */

const finished = (wpm, accuracy = 98) => ({ status: "done", wpm, accuracy, raw: wpm + 4, consistency: 80 });

test("a personal best is set, and only beaten by a faster run", () => {
  let records = emptyRecords();
  let outcome = recordResult(records, { key: "time:60", label: "60 seconds", result: finished(70) });
  assert.equal(outcome.best, true);
  records = outcome.records;

  outcome = recordResult(records, { key: "time:60", label: "60 seconds", result: finished(65) });
  assert.equal(outcome.best, false);
  assert.equal(outcome.records.bests["time:60"].wpm, 70);

  outcome = recordResult(outcome.records, { key: "time:60", label: "60 seconds", result: finished(88) });
  assert.equal(outcome.best, true);
  assert.equal(outcome.records.bests["time:60"].wpm, 88);
});

test("an abandoned or failed run sets no record", () => {
  const { records, best } = recordResult(emptyRecords(), {
    key: "time:60",
    label: "60 seconds",
    result: { ...finished(200), status: "failed" },
  });
  assert.equal(best, false);
  assert.deepEqual(records.bests, {});
  assert.equal(records.history.length, 0, "and is not filed at all");
});

test("a fast run at hopeless accuracy is not a personal best", () => {
  const { records, best } = recordResult(emptyRecords(), {
    key: "time:60",
    label: "60 seconds",
    result: finished(140, 41),
  });
  assert.equal(best, false, "mashing is not typing");
  assert.equal(records.history.length, 1, "but it still happened");
});

test("different tests keep separate bests", () => {
  let records = recordResult(emptyRecords(), { key: "time:60", label: "", result: finished(70) }).records;
  records = recordResult(records, { key: "words:25", label: "", result: finished(50) }).records;
  assert.equal(records.bests["time:60"].wpm, 70);
  assert.equal(records.bests["words:25"].wpm, 50);
});

test("history is capped and stays newest first", () => {
  let records = emptyRecords();
  for (let i = 0; i < 260; i++) {
    records = recordResult(records, { key: "time:60", label: "", result: finished(i), at: i }).records;
  }
  assert.equal(records.history.length, 200);
  assert.equal(records.history[0].wpm, 259, "newest first");
});

test("recent averages are per test, not across all of them", () => {
  let records = emptyRecords();
  records = recordResult(records, { key: "time:60", label: "", result: finished(60) }).records;
  records = recordResult(records, { key: "time:60", label: "", result: finished(80) }).records;
  records = recordResult(records, { key: "words:10", label: "", result: finished(200) }).records;
  const summary = summarize(records, "time:60");
  assert.equal(summary.tests, 2);
  assert.equal(summary.averageWpm, 70);
});

test("a corrupt record file reads as an empty one", () => {
  assert.deepEqual(normalizeRecords("nonsense"), emptyRecords());
  assert.deepEqual(normalizeRecords({ bests: { "x": { wpm: "fast" } }, history: [null, 7] }), emptyRecords());
});

test("bank words typed are totalled across the history", () => {
  let records = emptyRecords();
  records = recordResult(records, { key: "q", label: "", result: finished(60), bankWords: ["demise", "candour"] }).records;
  records = recordResult(records, { key: "q", label: "", result: finished(61), bankWords: ["demise"] }).records;
  const totals = bankWordTotals(records);
  assert.equal(totals.get("demise"), 2);
  assert.equal(totals.get("candour"), 1);
});

/* ---- generated word runs ---- */

const cycle = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test("a run is exactly as long as asked for", () => {
  const words = generateWords(["alpha", "beta", "gamma"], 25, { random: Math.random });
  assert.equal(words.length, 25);
});

test("no word follows itself", () => {
  const words = generateWords(["alpha", "beta"], 40, { random: Math.random });
  for (let i = 1; i < words.length; i++) {
    assert.notEqual(words[i], words[i - 1]);
  }
});

test("a one-word pool cannot deadlock looking for a different word", () => {
  assert.deepEqual(generateWords(["only"], 3, { random: () => 0 }), ["only", "only", "only"]);
});

test("an empty pool or a zero count produces nothing, rather than hanging", () => {
  assert.deepEqual(generateWords([], 10), []);
  assert.deepEqual(generateWords(["alpha"], 0), []);
});

test("punctuation opens sentences with a capital and closes the run with a stop", () => {
  const words = generateWords(["alpha", "beta", "gamma", "delta"], 12, {
    punctuation: true,
    random: cycle([0.05, 0.3, 0.5, 0.75, 0.9, 0.12]),
  });
  assert.match(words[0], /^[A-Z]/, "the first word is capitalized");
  assert.match(words.at(-1), /[.!?]$/, "the run ends on a full stop");
  const joined = words.join(" ");
  for (const [, next] of joined.matchAll(/[.!?]\s+(\S)/g)) {
    assert.match(next, /[A-Z"(]/, `a sentence started with "${next}"`);
  }
});

test("numbers appear only when asked for", () => {
  const plain = generateWords(["alpha", "beta"], 60, { random: Math.random });
  assert.equal(plain.some((word) => /\d/.test(word)), false);
  const numeric = generateWords(["alpha", "beta"], 200, { numbers: true, random: Math.random });
  assert.equal(numeric.some((word) => /^\d+$/.test(word)), true);
});
