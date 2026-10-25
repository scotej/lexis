import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as bankModel from "../src/core/bank.js";
import { todayISO } from "../src/core/srs.js";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "https://lexis.test/" });
const { document, Event } = dom.window;
for (const name of ["document", "localStorage", "sessionStorage", "location", "Blob", "File", "Event", "KeyboardEvent"]) {
  globalThis[name] = dom.window[name];
}
globalThis.addEventListener = () => {};

const initial = bankModel.emptyBank();
initial.words = [bankModel.newWord("alpha", {
  phonetic: null,
  senses: [{ pos: "noun", def: "the first", example: null }],
  source: "test",
  source_url: "https://example.invalid",
}, [], todayISO())];
bankModel.ensureTodayList(initial, todayISO());

let stored = initial;
let blockSave = null;
let saveCalls = 0;
globalThis.__TAURI__ = {
  core: {
    async invoke(command, args) {
      if (command === "load_bank") return JSON.stringify(stored);
      if (command === "save_bank") {
        saveCalls++;
        if (blockSave) await blockSave;
        stored = JSON.parse(args.json);
        return;
      }
      if (command === "check_update") return null;
      if (command === "ai_device_key") return Array(32).fill(1);
      throw new Error(`unexpected command: ${command}`);
    },
  },
  opener: { openUrl: async () => {} },
  event: { listen: async () => () => {} },
};

const lookups = new Map();
globalThis.fetch = (url) => {
  const target = String(url);
  if (target.startsWith("https://api.datamuse.com/")) {
    return Promise.resolve(new Response(JSON.stringify([{ word: "beneficial", score: 38038, tags: ["f:3"] }]), { status: 200 }));
  }
  if (!target.startsWith("https://api.dictionaryapi.dev/")) {
    return Promise.reject(new Error("offline test asset"));
  }
  const word = decodeURIComponent(target.split("/").at(-1));
  return new Promise((resolve) => lookups.set(word, resolve));
};

await import("../src/main.js");

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the expected UI state did not appear");
}

function dictionary(word) {
  return new Response(JSON.stringify([{
    word,
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: `${word} definition` }] }],
  }]), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("a review card accepts one grade while saving, and lookup drops a stale answer", async () => {
  await until(() => Boolean(document.querySelector(".entry-head")));
  assert.equal(document.getElementById("gate").hidden, true);

  document.querySelector('[data-view="review"]').click();
  document.querySelector(".review-stage").click();
  const grades = [...document.querySelectorAll(".grade-row button")];
  let failSave;
  blockSave = new Promise((resolve, reject) => { failSave = reject; });
  grades[2].click(); // good
  // Revisiting Review during the save must not create another live copy.
  document.querySelector('[data-view="bank"]').click();
  document.querySelector('[data-view="review"]').click();
  document.querySelector(".review-stage").click();
  const revisited = [...document.querySelectorAll(".grade-row button")];
  const reentryBlocked = revisited.every((button) => button.disabled);
  grades[3].click(); // a second click before the first save finishes
  await until(() => saveCalls === 1);
  assert.ok(grades.every((button) => button.disabled));
  failSave(new Error("disk full"));
  blockSave = null;
  await until(() => grades.every((button) => !button.disabled));
  assert.equal(stored.words[0].srs.reps, 0, "the failed grade did not reach storage");
  grades[2].click();
  await until(() => document.querySelector("#review-area")?.textContent.includes("1 word reviewed"));
  assert.equal(saveCalls, 2);
  assert.equal(stored.words[0].srs.reps, 1);
  assert.equal(Object.keys(stored.words[0].review_events).length, 1);
  assert.ok(reentryBlocked, "returning to Review must keep the pending card disabled");

  document.getElementById("rail-lookup").click();
  const input = document.getElementById("lookup-input");
  const form = document.getElementById("lookup-form");
  input.value = "obsolete";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(() => lookups.has("obsolete"));

  input.value = "new";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  lookups.get("obsolete")(dictionary("obsolete"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("lookup-result").textContent, "");
  assert.equal(document.getElementById("lookup-status").hidden, true);

  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(() => lookups.has("new"));
  lookups.get("new")(dictionary("new"));
  await until(() => document.getElementById("lookup-result").textContent.includes("new definition"));
  assert.doesNotMatch(document.getElementById("lookup-result").textContent, /obsolete/);
});

test("a stronger-word suggestion opens quick lookup without adding the simple word", async () => {
  const savesBefore = saveCalls;
  const input = document.getElementById("upgrade-input");
  input.value = "good";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("upgrade-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(() => Boolean(document.querySelector("#upgrade-results button")));
  document.querySelector("#upgrade-results button").click();
  await until(() => lookups.has("beneficial"));
  lookups.get("beneficial")(dictionary("beneficial"));
  await until(() => document.getElementById("lookup-result").textContent.includes("beneficial definition"));
  assert.equal(document.getElementById("lookup").hidden, false);
  assert.equal(document.getElementById("lookup-input").value, "beneficial");
  assert.match(document.getElementById("lookup-result").textContent, /add to bank/);
  assert.equal(saveCalls, savesBefore);
  assert.equal(stored.words.some(word => word.word === "good" || word.word === "beneficial"), false);
});
