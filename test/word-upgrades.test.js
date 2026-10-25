import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { fetchWordUpgrades, clearLookupCaches } from "../src/core/dict.js";
import { installWordUpgrades } from "../src/word-upgrades.js";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const answer = rows => new Response(JSON.stringify(rows), {
  status: 200, headers: { "Content-Type": "application/json" },
});

test("stronger words use strict synonyms, rank formal alternatives and share immutable cached results", async () => {
  const previous = globalThis.fetch;
  clearLookupCaches();
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(new URL(url));
    return answer([
      { word: "good", tags: ["f:100"] },
      { word: "nice", tags: ["f:100"] },
      { word: "beneficial", score: 38038, tags: ["f:3"] },
      { word: "excellent", score: 22000, tags: ["f:9"] },
      { word: "BENEFICIAL", score: 38038, tags: ["f:3"] },
      { word: "very good", tags: ["f:1"] },
      { word: "<script>" },
      null,
    ]);
  };
  try {
    const [first, second] = await Promise.all([fetchWordUpgrades(" GOOD "), fetchWordUpgrades("good")]);
    assert.deepEqual(first.map(row => row.word), ["beneficial", "excellent"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchParams.get("rel_syn"), "good");
    assert.equal(calls[0].searchParams.has("ml"), false, "related meanings must not be presented as replacements");
    assert.equal(calls[0].searchParams.get("md"), "pf");
    first[0].word = "damaged";
    assert.equal(second[0].word, "beneficial");
    assert.equal((await fetchWordUpgrades("good"))[0].word, "beneficial");
  } finally {
    globalThis.fetch = previous;
    clearLookupCaches();
  }
});

test("a common-word query favours useful relevant alternatives over rare peripheral senses", async () => {
  const previous = globalThis.fetch;
  clearLookupCaches();
  globalThis.fetch = async () => answer([
    { word: "eminent", score: 131039, tags: ["adj", "f:5.414555"] },
    { word: "zealous", score: 60031, tags: ["adj", "f:1.671031"] },
    { word: "extraordinary", score: 46038, tags: ["adj", "f:16.766677"] },
    { word: "enthusiastic", score: 37031, tags: ["adj", "f:6.978928"] },
    { word: "distinguished", score: 26031, tags: ["adj", "f:24.393352"] },
    { word: "outstanding", score: 24043, tags: ["adj", "f:14.046224"] },
    { word: "enceinte", score: 27034, tags: ["n", "adj", "f:0.091778"] },
    { word: "gravid", score: 19040, tags: ["adj", "f:0.239986"] },
    { word: "corking", score: 4024, tags: ["adj", "f:0.036409"] },
    { word: "majuscule", score: 3030, tags: ["adj", "f:0.027335"] },
    { word: "uppercase", score: 24, tags: ["adj", "f:0.434660"] },
    { word: "smashing", score: 1034, tags: ["adj", "f:1.085118"] },
    { word: "swell", score: 29053, tags: ["adj", "f:3.501865"] },
    { word: "dandy", score: 22040, tags: ["adj", "f:1.007666"] },
  ]);
  try {
    const words = (await fetchWordUpgrades("great")).map(row => row.word);
    assert.equal(words[0], "eminent", "upstream relevance contributes to the ranking");
    assert.ok(words.includes("outstanding"));
    assert.ok(words.includes("distinguished"));
    assert.ok(words.includes("extraordinary"));
    for (const rejected of ["corking", "majuscule", "uppercase", "enceinte", "gravid", "smashing", "swell", "dandy"]) {
      assert.equal(words.includes(rejected), false, rejected);
    }
  } finally {
    globalThis.fetch = previous;
    clearLookupCaches();
  }
});

test("invalid queries do not send requests; a failed service can be retried", async () => {
  const previous = globalThis.fetch;
  clearLookupCaches();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    if (attempts === 2) return answer({ error: "unreadable" });
    return answer([]);
  };
  try {
    for (const word of ["", "two words", "word/word", "a".repeat(41)]) {
      await assert.rejects(() => fetchWordUpgrades(word), /one word/);
    }
    assert.equal(attempts, 0);
    await assert.rejects(() => fetchWordUpgrades("good"), /offline/);
    await assert.rejects(() => fetchWordUpgrades("good"), /unreadable/);
    assert.deepEqual(await fetchWordUpgrades("good"), []);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = previous;
    clearLookupCaches();
  }
});

function setup(findUpgrades) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const selected = [];
  installWordUpgrades({ document, findUpgrades, onLookup: word => selected.push(word) });
  const $ = id => document.getElementById(id);
  const input = value => {
    $("upgrade-input").value = value;
    $("upgrade-input").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const submit = () => $("upgrade-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  return { $, input, submit, selected };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("suggestions let the student inspect a word without saving the query", async () => {
  const calls = [];
  const s = setup(async word => { calls.push(word); return [{ word: "beneficial" }]; });
  s.input(" Good ");
  s.submit();
  assert.equal(s.$("upgrade-find").disabled, true);
  await settle();
  assert.deepEqual(calls, ["good"]);
  assert.equal(s.$("upgrade-find").disabled, false);
  const button = s.$("upgrade-results").querySelector("button");
  assert.equal(button.textContent, "beneficial");
  button.click();
  assert.deepEqual(s.selected, ["beneficial"]);
  assert.match(s.$("upgrade-status").textContent, /check its meaning/);
});

test("editing the query drops stale suggestions and late errors, and Enter cannot duplicate pending work", async () => {
  const requests = new Map();
  let calls = 0;
  const s = setup(word => { calls++; return new Promise((resolve, reject) => requests.set(word, { resolve, reject })); });
  s.input("good");
  s.submit();
  s.submit();
  assert.equal(calls, 1);
  s.input("bad");
  assert.equal(s.$("upgrade-status").hidden, true);
  assert.equal(s.$("upgrade-find").disabled, false);
  s.submit();
  requests.get("good").resolve([{ word: "beneficial" }]);
  await settle();
  assert.equal(s.$("upgrade-results").childElementCount, 0);
  assert.equal(s.$("upgrade-find").disabled, true);
  requests.get("bad").reject(new Error("offline"));
  await settle();
  assert.match(s.$("upgrade-status").textContent, /offline/);
  assert.equal(s.$("upgrade-find").disabled, false);
  s.input("new");
  s.submit();
  s.input("changed");
  requests.get("new").reject(new Error("late error"));
  await settle();
  assert.equal(s.$("upgrade-status").hidden, true);
});

test("empty suggestions and retry after an error remain usable", async () => {
  let fail = true;
  const s = setup(async () => {
    if (fail) throw new Error("offline");
    return [];
  });
  s.input("good");
  s.submit();
  await settle();
  assert.equal(s.$("upgrade-status").classList.contains("error"), true);
  fail = false;
  s.submit();
  await settle();
  assert.equal(s.$("upgrade-status").classList.contains("error"), false);
  assert.match(s.$("upgrade-status").textContent, /no stronger alternatives/);
  assert.equal(s.$("upgrade-find").disabled, false);
});
