import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, variants, tokenize, sentences } from "../src/core/essay.js";

test("finds inflected forms", () => {
  const report = analyze(
    "The author vilifies the outsider. This foreshadows the town's demise.",
    ["demise", "vilify"],
    []
  );
  const words = report.used.map((u) => u.word);
  assert.ok(words.includes("demise"));
  assert.ok(words.includes("vilify"));
});

test("flags overuse", () => {
  const report = analyze(
    "The demise came early. Their demise was slow. A demise foretold.",
    ["demise"],
    []
  );
  assert.equal(report.used[0].overused, true);
  assert.ok(report.notes.some((n) => n.includes("appears 3 times")));
});

test("tracks unused words from today's list", () => {
  const report = analyze("Nothing relevant here.", ["demise", "cessation"], ["cessation"]);
  assert.deepEqual(report.unused_today, ["cessation"]);
});

test("notices a word repeated inside one sentence", () => {
  const report = analyze("The demise foretold another demise entirely.", ["demise"], []);
  assert.ok(report.notes.some((n) => n.includes("repeated within a single sentence")));
});

test("variants cover regular English morphology", () => {
  assert.ok(variants("vilify").has("vilified"));
  assert.ok(variants("demise").has("demises"));
  assert.ok(variants("commit").has("committed"));
  assert.ok(variants("critique").has("critiquing"));
});

test("tokenizer keeps hyphens and apostrophes inside words", () => {
  assert.deepEqual(tokenize("well-worn; the town's, end."), ["well-worn", "the", "town's", "end"]);
});

test("sentence splitting keeps terminators and trailing fragments", () => {
  assert.deepEqual(sentences("One. Two! Three? Four"), ["One.", "Two!", "Three?", "Four"]);
});

test("counts every word in the draft, not just bank words", () => {
  const report = analyze("one two three four five", [], []);
  assert.equal(report.essay_words, 5);
});
