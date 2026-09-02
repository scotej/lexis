/**
 * The parts of the typing view that are arithmetic rather than DOM.
 *
 * The view itself paints and measures, and there is no browser here to do
 * either — but the sum that decides which line the caret is on is neither, and
 * it is the sum that decides whether a long passage stays under the typist's
 * eye or drifts a line at a time out from under it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { lineOf } = await import("../src/typing-view.js");

// A Charter glyph at the app's default 1.3rem: about 25px of ink in a 34.3px
// line. The gap is the whole reason the old arithmetic went wrong.
const LINE = 34.32;
const GLYPH = 25;
const TOP_OF_LINE = (n) => n * LINE + (LINE - GLYPH) / 2;

test("a character is on the line its own line box occupies", () => {
  for (let n = 0; n < 12; n++) {
    assert.equal(lineOf(TOP_OF_LINE(n), GLYPH, LINE), n, `line ${n}`);
  }
});

test("the glyph's own height is not mistaken for the line's", () => {
  // The bug this replaces: dividing a character's top by the character's
  // height read the second line as the third from the very first wrap.
  const naive = Math.round(TOP_OF_LINE(1) / GLYPH);
  assert.equal(naive, 2, "the old sum really did answer 2 here");
  assert.equal(lineOf(TOP_OF_LINE(1), GLYPH, LINE), 1);
});

test("a taller or shorter glyph on the same line still reads as that line", () => {
  // Capitals, descenders and the odd wide glyph all measure differently.
  for (const height of [14, 20, 25, 31, 34]) {
    const top = 2 * LINE + (LINE - height) / 2;
    assert.equal(lineOf(top, height, LINE), 2, `a ${height}px glyph`);
  }
});

test("an unmeasurable character falls back to the line's own height", () => {
  assert.equal(lineOf(TOP_OF_LINE(3), 0, LINE), 3);
});

test("nothing above the first line, and no line at all without a line height", () => {
  assert.equal(lineOf(-8, GLYPH, LINE), 0, "a glyph overshooting its line box");
  assert.equal(lineOf(120, GLYPH, 0), 0, "a stylesheet that never loaded");
});
