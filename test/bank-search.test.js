import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { installBankSearch } from "../src/bank-search.js";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const words = ["profound", "pragmatic", "reproach", "éloquent", "can't", "well-read"].map((word) => ({ word }));

function setup(entries = words) {
  const dom = new JSDOM(html);
  const $ = (id) => dom.window.document.getElementById(id);
  let results;
  const ui = installBankSearch({ document: dom.window.document, onChange: () => { results = ui.filterWords(entries); } });
  results = ui.filterWords(entries);
  const search = (query) => {
    $("bank-search").value = query;
    $("bank-search").dispatchEvent(new dom.window.Event("input"));
    return results.map(({ word }) => word);
  };
  return { dom, $, search, results: () => results };
}

test("bank search matches only headword prefixes and preserves the supplied order", () => {
  const s = setup();
  const original = structuredClone(words);
  assert.deepEqual(s.search(" PR "), ["profound", "pragmatic"]);
  assert.match(s.$("bank-search-status").textContent, /2 of 6 words/);
  assert.deepEqual(s.search("e\u0301"), ["éloquent"]);
  assert.deepEqual(s.search("can't"), ["can't"]);
  assert.deepEqual(s.search("well-"), ["well-read"]);
  assert.deepEqual(s.search(".*"), []);
  assert.match(s.$("bank-search-status").textContent, /No words start with/);
  assert.equal(s.$("bank-search-tools").hidden, false, "zero matches must leave search usable");
  assert.deepEqual(words, original, "search must not edit or reorder bank data");
  s.dom.window.close();
});

test("clear and Escape restore all results and keep focus in search", () => {
  const s = setup();
  s.search("pr");
  s.$("bank-search-clear").click();
  assert.equal(s.results(), words);
  assert.equal(s.dom.window.document.activeElement, s.$("bank-search"));
  assert.equal(s.$("bank-search-clear").hidden, true);
  assert.equal(s.$("bank-search-status").hidden, true);
  s.search("unknown");
  const escape = new s.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  s.$("bank-search").dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(s.results(), words);
  assert.deepEqual(s.search("   "), words.map(({ word }) => word));
  s.dom.window.close();
});

test("an empty bank hides search without showing a misleading no-matches message", () => {
  const s = setup([]);
  s.search("pr");
  assert.equal(s.$("bank-search-tools").hidden, true);
  assert.equal(s.$("bank-search-status").hidden, true);
  s.dom.window.close();
});
