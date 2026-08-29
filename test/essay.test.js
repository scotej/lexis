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

test("identifies bank-word matches outside today's list", () => {
  const report = analyze("The town's demise was inevitable.", ["demise"], []);
  assert.equal(report.used[0].word, "demise");
  assert.equal(report.used[0].count, 1);
  assert.equal(report.used[0].in_today, false);
});

test("an exact bank word owns a token instead of also counting it as another word's variant", () => {
  const report = analyze("She argued fervently.", ["fervent", "fervently"], []);
  assert.deepEqual(report.used.map((usage) => [usage.word, usage.count]), [["fervently", 1]]);
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

/* ---- British and American spellings of the same word ---- */

test("a bank word is found in either spelling, with its inflections", () => {
  // lexis is written for an Australian student; most of the quotable English
  // ever written down was published in America. Without this, a bank holding
  // "recognise" misses the seven-in-eight of the quote corpus that spells it
  // the other way.
  const forms = variants("recognise");
  for (const form of ["recognize", "recognizes", "recognized", "recognizing", "recognised"]) {
    assert.ok(forms.has(form), `variants("recognise") is missing ${form}`);
  }
  assert.ok(variants("colour").has("colored"));
  assert.ok(variants("color").has("colours"));
  assert.ok(variants("analyse").has("analyzed"));
  assert.ok(variants("sombre").has("somber"));
  assert.ok(variants("defence").has("defense"));
  assert.ok(variants("travelled").has("traveled"));
  assert.ok(variants("organisation").has("organization"));
});

test("spelling rules do not fire on words that merely look similar", () => {
  // The -our/-or rule would otherwise turn "four" into "for" and credit an
  // essay with a word it never used.
  for (const [word, trap] of [
    ["four", "for"],
    ["your", "yor"],
    ["hour", "hor"],
    ["tour", "tor"],
    ["more", "moer"],
    ["here", "heer"],
  ]) {
    assert.equal(variants(word).has(trap), false, `variants("${word}") wrongly contains "${trap}"`);
  }
});

test("an essay is credited for the other spelling of a banked word", () => {
  const report = analyze("The colour of it was recognized by everyone.", ["colour", "recognise"], []);
  assert.deepEqual(
    report.used.map((u) => u.word).sort(),
    ["colour", "recognise"]
  );
});
