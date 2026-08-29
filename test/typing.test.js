/**
 * The typing engine.
 *
 * Every test here drives the run through the same three methods a keyboard
 * does, with a clock that only moves when the test says so — which is what
 * makes "type 120 words in 60 seconds" an assertion rather than a minute of
 * waiting. The suites are grouped by the promise each setting makes, because
 * that is what breaks: not the arithmetic, but a rule that stops applying at
 * the edge of a word.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRun, foldAccents } from "../src/core/typing.js";

/** A run with a clock we hold, advancing a fixed amount per keystroke. */
function harness(options = {}, { msPerKey = 100 } = {}) {
  let clock = 1000;
  const run = createRun({ ...options, now: () => clock });
  return {
    run,
    advance(ms) {
      clock += ms;
    },
    get clock() {
      return clock;
    },
    /** Types a string, treating spaces as the space key. */
    type(text) {
      for (const char of text) {
        clock += msPerKey;
        if (char === " ") run.space();
        else run.type(char);
      }
    },
    backspace(times = 1, whole = false) {
      for (let i = 0; i < times; i++) {
        clock += msPerKey;
        run.backspace(whole);
      }
    },
  };
}

/* ---- the basics ---- */

test("a perfectly typed passage finishes with nothing wrong in it", () => {
  const h = harness({ text: "the quick brown fox" });
  h.type("the quick brown fox ");
  assert.equal(h.run.status, "done");
  const result = h.run.result();
  assert.equal(result.chars.incorrect, 0);
  assert.equal(result.chars.extra, 0);
  assert.equal(result.chars.missed, 0);
  assert.equal(result.accuracy, 100);
  assert.equal(result.words, 4);
});

test("the clock starts on the first keystroke, not on creation", () => {
  const h = harness({ text: "alpha beta" });
  h.advance(30000); // thirty seconds of staring at it
  assert.equal(h.run.status, "idle");
  h.type("alpha beta ");
  // Ten keystrokes at 100ms: the half minute before the first one is not typing.
  assert.ok(h.run.result().seconds < 2, `counted ${h.run.result().seconds}s`);
});

test("wpm counts only the words that came out right", () => {
  // Five characters plus a space is one "word" by the standard definition.
  const h = harness({ text: "aaaaa bbbbb" }, { msPerKey: 0 });
  h.type("aaaaa ");
  h.advance(6000); // ten seconds total after the keystrokes below
  h.type("bbbbb ");
  const perfect = h.run.result().wpm;

  const spoiled = harness({ text: "aaaaa bbbbb" }, { msPerKey: 0 });
  spoiled.type("aaaaa ");
  spoiled.advance(6000);
  spoiled.type("bbbbx ");
  assert.ok(spoiled.run.result().wpm < perfect, "a mistyped word must not earn its characters");
});

test("raw speed counts everything the fingers did", () => {
  const h = harness({ text: "aaaaa" }, { msPerKey: 0 });
  h.type("bbbbb");
  h.advance(60000);
  const result = h.run.result();
  assert.equal(result.wpm, 0, "nothing was typed correctly");
  assert.ok(result.raw > 0, "but five keys were pressed");
});

test("accuracy is keystrokes, not characters left on screen", () => {
  const h = harness({ text: "cat" });
  h.type("cx");
  h.backspace();
  h.type("at");
  // Four keys were pressed and one of them was wrong. Erasing the evidence
  // does not erase the mistake, and the backspace itself is not a keystroke.
  assert.equal(h.run.result().accuracy, (3 / 4) * 100);
});

/* ---- what the view draws ---- */

test("a word reports its characters as correct, wrong, extra, or missed", () => {
  const h = harness({ text: "brown fox" });
  h.type("brwonx ");
  const view = h.run.wordView(0);
  assert.deepEqual(
    view.chars.map((c) => c.state),
    ["correct", "correct", "incorrect", "incorrect", "correct"]
  );
  assert.deepEqual(view.extra, ["x"]);
  assert.equal(view.correct, false);

  const short = harness({ text: "brown fox" });
  short.type("bro ");
  assert.deepEqual(
    short.run.wordView(0).chars.map((c) => c.state),
    ["correct", "correct", "correct", "missed", "missed"]
  );
});

test("the word under the caret has pending characters, not missed ones", () => {
  const h = harness({ text: "brown fox" });
  h.type("bro");
  assert.deepEqual(
    h.run.wordView(0).chars.map((c) => c.state),
    ["correct", "correct", "correct", "pending", "pending"]
  );
  assert.equal(h.run.result().chars.missed, 0);
});

/* ---- backspace ---- */

test("backspace walks back into a word that was wrong, and not into one that was right", () => {
  const h = harness({ text: "alpha beta gamma" });
  h.type("alpha bxta ");
  assert.equal(h.run.index, 2);
  h.backspace();
  assert.equal(h.run.index, 1, "the previous word had an error, so it is reachable");

  const clean = harness({ text: "alpha beta gamma" });
  clean.type("alpha beta ");
  clean.backspace();
  assert.equal(clean.run.index, 2, "a word already correct is finished with");
});

test("freedom mode lets you go back to a word you got right", () => {
  const h = harness({ text: "alpha beta", settings: { freedomMode: true } });
  h.type("alpha ");
  h.backspace();
  assert.equal(h.run.index, 0);
});

test("ctrl+backspace clears the whole word", () => {
  const h = harness({ text: "abstraction follows" });
  h.type("abstrac");
  h.backspace(1, true);
  assert.equal(h.run.typed[0], "");
});

test("confidence mode refuses to go back a word; max refuses backspace entirely", () => {
  const on = harness({ text: "alpha beta", settings: { confidenceMode: "on" } });
  on.type("alpxa ");
  on.backspace();
  assert.equal(on.run.index, 1, "cannot return to a finished word");
  on.type("be");
  on.backspace();
  assert.equal(on.run.typed[1], "b", "but the current word is still editable");

  const max = harness({ text: "alpha beta", settings: { confidenceMode: "max" } });
  max.type("alp");
  max.backspace();
  assert.equal(max.run.typed[0], "alp", "no backspace at all");
});

/* ---- stop on error ---- */

test("stop on error: letter refuses the wrong key but still counts it", () => {
  const h = harness({ text: "cat", settings: { stopOnError: "letter" } });
  h.type("cx");
  assert.equal(h.run.typed[0], "c", "the wrong letter never lands");
  h.type("at");
  assert.equal(h.run.typed[0], "cat");
  assert.equal(h.run.result().accuracy, (3 / 4) * 100, "the mistake still happened");
});

test("stop on error: word refuses the space until the word is right", () => {
  const h = harness({ text: "cat dog", settings: { stopOnError: "word" } });
  h.type("cxt ");
  assert.equal(h.run.index, 0, "space is refused");
  h.backspace(2);
  h.type("at ");
  assert.equal(h.run.index, 1);
});

/* ---- difficulty ---- */

test("expert fails the test when a wrong word is submitted", () => {
  const h = harness({ text: "cat dog", settings: { difficulty: "expert" } });
  h.type("cxt ");
  assert.equal(h.run.status, "failed");
  assert.match(h.run.failure, /word/);
});

test("master fails on the wrong key, before the word is finished", () => {
  const h = harness({ text: "cat dog", settings: { difficulty: "master" } });
  h.type("cx");
  assert.equal(h.run.status, "failed");
  assert.match(h.run.failure, /key/);
});

test("a failed run stops accepting input", () => {
  const h = harness({ text: "cat dog", settings: { difficulty: "master" } });
  h.type("cxt dog ");
  assert.equal(h.run.index, 0);
});

/* ---- spaces ---- */

test("a stray space at the start of a word is ignored, unless strict", () => {
  const h = harness({ text: "cat dog" });
  h.type(" ");
  assert.equal(h.run.index, 0);
  assert.equal(h.run.result().accuracy, 100, "an ignored key is not a mistake");

  const strict = harness({ text: "cat dog", settings: { strictSpace: true } });
  strict.type(" ");
  assert.equal(strict.run.index, 0, "still does not advance");
  assert.ok(strict.run.result().accuracy < 100, "but it is scored");
});

/* ---- extra letters ---- */

test("extra letters pile up, or don't, depending on the setting", () => {
  const loose = harness({ text: "cat" });
  loose.type("catttt");
  assert.deepEqual(loose.run.wordView(0).extra, ["t", "t", "t"]);

  const hidden = harness({ text: "cat", settings: { hideExtraLetters: true } });
  hidden.type("catttt");
  assert.deepEqual(hidden.run.wordView(0).extra, []);
  assert.ok(hidden.run.result().accuracy < 100, "the keys were still pressed wrongly");
});

test("extra letters cannot grow without bound", () => {
  const h = harness({ text: "cat" });
  h.type("cat" + "z".repeat(200));
  assert.ok(h.run.typed[0].length <= 3 + 25, `runaway word: ${h.run.typed[0].length}`);
});

/* ---- quick end ---- */

test("quick end finishes on the last letter instead of waiting for a space", () => {
  const plain = harness({ text: "cat dog" });
  plain.type("cat dog");
  assert.equal(plain.run.status, "running");

  const quick = harness({ text: "cat dog", settings: { quickEnd: true } });
  quick.type("cat dog");
  assert.equal(quick.run.status, "done");
});

/* ---- timed runs ---- */

test("a timed run ends when the clock does, and grows text before it runs out", () => {
  const h = harness({ words: ["alpha", "beta"], duration: 10 }, { msPerKey: 0 });
  h.type("alpha ");
  h.run.appendWords(["gamma", "delta"]);
  assert.equal(h.run.words.length, 4);
  h.type("beta gamma ");
  h.advance(11000);
  assert.equal(h.run.tick(), "done");
  assert.equal(h.run.remaining(), 0);
});

test("running out of text mid-timer waits for more rather than ending the test", () => {
  const h = harness({ words: ["alpha"], duration: 30 }, { msPerKey: 0 });
  h.type("alpha ");
  assert.equal(h.run.status, "running");
  h.run.appendWords(["beta"]);
  h.type("beta ");
  assert.equal(h.run.status, "running");
});

test("progress tracks the clock when timed and the words when not", () => {
  const timed = harness({ words: ["a", "b", "c", "d"], duration: 10 }, { msPerKey: 0 });
  timed.type("a ");
  timed.advance(5000);
  assert.ok(Math.abs(timed.run.progress() - 0.5) < 0.05);

  const counted = harness({ words: ["a", "b", "c", "d"] }, { msPerKey: 0 });
  counted.type("a b ");
  assert.equal(counted.run.progress(), 0.5);
});

/* ---- thresholds ---- */

test("a minimum speed ends the test when it is missed", () => {
  const h = harness({ text: "alpha beta gamma", settings: { minWpm: 200 } }, { msPerKey: 500 });
  h.type("alpha beta ");
  assert.equal(h.run.status, "failed");
  assert.match(h.run.failure, /wpm/);
});

test("a minimum accuracy ends the test when it is missed", () => {
  const h = harness({ text: "alpha beta gamma", settings: { minAccuracy: 90 } });
  h.type("xxxxx ");
  assert.equal(h.run.status, "failed");
  assert.match(h.run.failure, /accuracy/);
});

test("thresholds of zero are off, not impossible to meet", () => {
  const h = harness({ text: "alpha beta", settings: { minWpm: 0, minAccuracy: 0, minBurst: 0 } });
  h.type("alpha beta ");
  assert.equal(h.run.status, "done");
});

/* ---- lazy mode ---- */

test("lazy mode folds the passage onto keys a keyboard has", () => {
  assert.equal(foldAccents("naïveté — “clichés”"), 'naivete - "cliches"');
  const h = harness({ text: "naïve", settings: { lazyMode: true } });
  h.type("naive");
  assert.equal(h.run.wordView(0).chars.every((c) => c.state === "correct"), true);
});

/* ---- consistency ---- */

test("steady typing scores higher consistency than stuttering", () => {
  const steady = harness({ words: ["aaaaaaaaaa"], duration: null }, { msPerKey: 100 });
  steady.type("aaaaaaaaaa ");

  const lumpy = harness({ words: ["aaaaaaaaaa"], duration: null }, { msPerKey: 0 });
  for (let i = 0; i < 10; i++) {
    lumpy.advance(i % 2 === 0 ? 40 : 900);
    lumpy.run.type("a");
  }
  lumpy.advance(100);
  lumpy.run.space();

  assert.ok(
    steady.run.result().consistency > lumpy.run.result().consistency,
    "an even rhythm is the more consistent one"
  );
});

test("the timeline has one bucket per second of the run", () => {
  const h = harness({ words: ["aaaaa", "bbbbb"] }, { msPerKey: 300 });
  h.type("aaaaa bbbbb ");
  const timeline = h.run.result().timeline;
  assert.ok(timeline.length >= 3 && timeline.length <= 5, `got ${timeline.length} buckets`);
  assert.equal(
    timeline.reduce((sum, second) => sum + Math.round((second.raw / 60) * 5), 0),
    12,
    "every keystroke lands in exactly one second"
  );
});

/* ---- zen ---- */

test("zen accepts anything and counts it as right", () => {
  const h = harness({ words: [""], zen: true });
  h.type("whatever I like ");
  assert.equal(h.run.status, "running", "zen has no end of its own");
  assert.equal(h.run.result().accuracy, 100);
  assert.deepEqual(h.run.words.slice(0, 3), ["whatever", "I", "like"]);
  assert.deepEqual(
    h.run.wordView(0).chars.map((c) => c.state),
    ["correct", "correct", "correct", "correct", "correct", "correct", "correct", "correct"]
  );
});

test("zen grows a word to type into without being asked", () => {
  const h = harness({ words: [""], zen: true });
  h.type("one two three ");
  assert.equal(h.run.words.length, 4, "there is always a word waiting");
  assert.equal(h.run.words.at(-1), "");
});

test("zen ends when it is stopped, and scores what was typed", () => {
  const h = harness({ words: [""], zen: true }, { msPerKey: 100 });
  h.type("a steady rhythm of words ");
  h.run.stop();
  const result = h.run.result();
  assert.equal(result.status, "done");
  assert.ok(result.wpm > 0);
  assert.equal(h.run.progress(), 0, "zen has no proportion to be through");
});

test("a stray space in zen does not open an empty word", () => {
  const h = harness({ words: [""], zen: true });
  h.type("  word ");
  assert.equal(h.run.words[0], "word");
});
