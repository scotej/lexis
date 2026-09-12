/**
 * A finished test is filed once.
 *
 * The view keeps the keyboard after a test ends — the result screen is where
 * the next one is started from — and it keeps the run, so the passage can be
 * repeated. That combination is what made a stray keystroke over a result
 * score the same test again: every character went to `afterInput`, which asks
 * the run whether it is finished, finds that it is, and files the result. Two
 * or three idle keys after a test is what everybody does, so the record book,
 * the last-ten average and every bank word's "typed in N tests" drifted
 * upwards on their own.
 *
 * Driven through the real view in jsdom rather than through a unit of it,
 * because the bug was not in any one function: each of `onKeyDown`,
 * `afterInput` and `finishTest` did exactly what it said.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");

const SETTINGS_KEY = "lexis-typing-settings";
const RECORDS_KEY = "lexis-typing-records";

/** A localStorage that behaves, without a browser under it. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate, what, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The typing view, running against a real document.
 *
 * The module holds its chrome for the life of the page and installs itself
 * once, so this is deliberately a single shared setup: a second install would
 * be a no-op against the first document's nodes.
 */
async function boot() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.document = window.document;
  globalThis.localStorage = memoryStorage();
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  // A short generated run rather than a quotation: ten common words is a whole
  // test typed in one string, and nothing here is about which passage it was.
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ mode: "words", wordCount: 10, wordSource: "common", quickRestart: "off" })
  );

  const view = await import("../src/typing-view.js");
  view.installTypingView();
  view.initTypingView({
    app: {
      listWords: () => [],
      dueWords: () => [],
      getBank: () => ({ today: { words: [] } }),
    },
    getAiSettings: () => ({}),
    aiReady: () => false,
  });
  view.renderTypingView();
  await until(() => document.querySelectorAll("#tt-words .tt-word").length > 0, "a passage");
  return { window, view };
}

const { window } = await boot();

/** The words on screen, which are the words the run is asking for. */
const passage = () =>
  [...document.querySelectorAll("#tt-words .tt-word")].map((node) => node.textContent);

/** Types through the field the way an IME or a phone's autocorrect does. */
function send(text) {
  const input = document.getElementById("tt-input");
  input.value = text;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** Types through the keyboard, the way a keyboard does. */
function press(key) {
  const input = document.getElementById("tt-input");
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const filed = () => JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '{"history":[]}').history;

test("a finished test is filed once, however many keys land on the result", async () => {
  const words = passage();
  assert.ok(words.length >= 2, "the run should have words to type");

  send(`${words.join(" ")} `);
  await until(() => filed().length > 0, "the result to be filed");
  assert.equal(filed().length, 1, "one test, one entry");
  assert.equal(document.getElementById("tt-result").hidden, false, "the result is on screen");

  const after = filed()[0];

  // Everything somebody idly presses while reading their own score.
  for (const key of ["a", "b", " ", "Backspace", "c"]) press(key);
  send("de");
  press(" ");

  const history = filed();
  assert.equal(history.length, 1, "still one entry — the result is not filed again");
  assert.deepEqual(history[0], after, "and it is the same entry, not a rewritten one");
});

test("the next test files its own result, and the guard does not outlive the run", async () => {
  const before = filed().length;
  // "next test" is the button the result screen offers; pressing it is the
  // only thing on that screen that should start anything.
  const next = [...document.querySelectorAll("#tt-result button")].find(
    (button) => button.textContent === "next test"
  );
  assert.ok(next, "the result screen offers a next test");
  next.click();
  await until(() => document.getElementById("tt-stage").hidden === false, "a new passage");

  const words = passage();
  send(`${words.join(" ")} `);
  await until(() => filed().length > before, "the second result to be filed");
  assert.equal(filed().length, before + 1, "a second test, a second entry");
});
