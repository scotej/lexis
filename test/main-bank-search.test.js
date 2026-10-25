import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as bankModel from "../src/core/bank.js";
import { todayISO } from "../src/core/srs.js";

test("typing a bank prefix filters entries without changing totals, export or open drawers", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://lexis.test/" });
  for (const name of ["document", "localStorage", "sessionStorage", "location", "Blob", "File", "Event", "KeyboardEvent"]) {
    globalThis[name] = dom.window[name];
  }
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  globalThis.addEventListener = () => {};
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("offline test asset"); };
  const bank = bankModel.emptyBank();
  bank.words = ["pragmatic", "profound", "reproach", "austere"].map((word, index) => ({
    ...bankModel.newWord(word, {
      phonetic: null,
      senses: [{ pos: "adjective", def: `${word} definition`, example: null }],
      source: "test", source_url: "https://example.invalid",
    }, [], todayISO()), created: index + 1,
  }));
  bankModel.ensureTodayList(bank, todayISO());
  let saveCalls = 0;
  globalThis.__TAURI__ = {
    core: { async invoke(command) {
      if (command === "load_bank") return JSON.stringify(bank);
      if (command === "save_bank") { saveCalls++; return; }
      if (command === "check_update") return null;
      if (command === "ai_device_key") return Array(32).fill(1);
      throw new Error(`unexpected command: ${command}`);
    } },
    opener: { openUrl: async () => {} },
    event: { listen: async () => () => {} },
  };
  await import("../src/main.js");
  const $ = (id) => document.getElementById(id);
  for (let i = 0; i < 100 && !document.querySelector(".entry-head"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal($("gate").hidden, true);
  const headwords = () => [...document.querySelectorAll("#word-list .headword")].map((node) => node.textContent);
  const search = (value) => { $("bank-search").value = value; $("bank-search").dispatchEvent(new Event("input")); };
  const initialSaves = saveCalls;
  const initialNetwork = networkCalls;
  const pragmatic = () => [...document.querySelectorAll(".entry")].find((entry) => entry.querySelector(".headword").textContent === "pragmatic");
  pragmatic().querySelector(".entry-head").click();
  search("pr");
  assert.deepEqual(headwords(), ["profound", "pragmatic"]);
  assert.equal($("guide-words").textContent, "pragmatic — profound");
  assert.equal($("count-bank").textContent, "4");
  $("bank-sort").value = "word-asc";
  $("bank-sort").dispatchEvent(new Event("change"));
  assert.deepEqual(headwords(), ["pragmatic", "profound"]);
  search("zz");
  assert.deepEqual(headwords(), []);
  assert.equal($("bank-empty").hidden, true);
  assert.equal($("bank-search-tools").hidden, false);
  assert.match($("bank-search-status").textContent, /No words start with/);
  $("bank-export").click();
  assert.match($("export-count").textContent, /4 words · all entries included/);
  $("bank-search-clear").click();
  assert.deepEqual(headwords(), ["austere", "pragmatic", "profound", "reproach"]);
  assert.equal(pragmatic().querySelector(".entry-body").hidden, false);
  assert.equal(saveCalls, initialSaves, "search is not a saved bank mutation");
  assert.equal(networkCalls, initialNetwork, "search uses saved words without network requests");
  dom.window.close();
});
