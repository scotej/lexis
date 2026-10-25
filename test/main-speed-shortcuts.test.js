import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as bankModel from "../src/core/bank.js";
import { todayISO } from "../src/core/srs.js";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "https://lexis.test/" });
const { document, Event, KeyboardEvent } = dom.window;
for (const name of ["document", "localStorage", "sessionStorage", "location", "Blob", "File", "Event", "KeyboardEvent"]) {
  globalThis[name] = dom.window[name];
}
globalThis.addEventListener = () => {};
globalThis.fetch = async () => { throw new Error("offline test asset"); };

const initial = bankModel.emptyBank();
for (let index = 0; index < 300; index++) {
  initial.words.push(bankModel.newWord(`word-${index}`, {
    phonetic: "/test/",
    senses: Array.from({ length: 4 }, (_, sense) => ({
      pos: "noun", def: `A precise definition of meaning ${sense}.`, example: "An example sentence.",
    })),
    source: "test dictionary", source_url: "https://example.invalid",
  }, [{ word: "alternative" }], todayISO()));
}
bankModel.ensureTodayList(initial, todayISO());
let stored = initial;
const openedUrls = [];
globalThis.__TAURI__ = {
  core: { async invoke(command, args) {
    if (command === "load_bank") return JSON.stringify(stored);
    if (command === "save_bank") { stored = JSON.parse(args.json); return; }
    if (command === "check_update") return null;
    if (command === "ai_device_key") return Array(32).fill(1);
    throw new Error(`unexpected command: ${command}`);
  } },
  opener: { openUrl: async (url) => { openedUrls.push(url); } },
  event: { listen: async () => () => {} },
};
await import("../src/main.js");
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("the expected UI state did not appear");
}
const $ = id => document.getElementById(id);
function key(options) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
  document.activeElement.dispatchEvent(event);
  return event;
}

test("a large bank builds entry details only when opened, retaining links and expansion after sorting", async () => {
  await until(() => document.querySelectorAll(".entry-head").length === 300);
  assert.equal(document.querySelectorAll(".entry-body *").length, 0);
  const head = document.querySelector(".entry-head");
  const word = head.querySelector(".headword").textContent;
  assert.equal(head.getAttribute("aria-expanded"), "false");
  head.click();
  assert.equal(head.getAttribute("aria-expanded"), "true");
  let body = head.nextElementSibling;
  assert.equal(body.hidden, false);
  assert.equal(body.querySelectorAll(".sense").length, 4);
  assert.match(body.querySelector(".synonyms").textContent, /alternative/);
  [...body.querySelectorAll("button")].find(button => button.textContent === "view definition").click();
  assert.deepEqual(openedUrls, ["https://example.invalid"]);
  const count = body.childElementCount;
  head.click();
  head.click();
  assert.equal(body.childElementCount, count, "reopening must not duplicate its body");
  $("bank-sort").value = "word-asc";
  $("bank-sort").dispatchEvent(new Event("change", { bubbles: true }));
  body = [...document.querySelectorAll(".entry")].find(entry => entry.querySelector(".headword").textContent === word).querySelector(".entry-body");
  assert.equal(body.hidden, false, "a visible definition stays open across a bank repaint");
  assert.equal(document.querySelectorAll(".entry-body .sense").length, 4, "other rows remain lazy after sorting");
});

test("slash opens lookup from the launch field, restores focus and leaves writing alone", async () => {
  const add = $("add-input");
  add.value = "";
  add.focus();
  assert.equal(key({ key: "/", code: "Slash" }).defaultPrevented, true);
  assert.equal($("lookup").hidden, false);
  assert.equal(document.activeElement, $("lookup-input"));
  key({ key: "Escape" });
  assert.equal($("lookup").hidden, true);
  assert.equal(document.activeElement, add);
  // Reopen after closing: a hidden lookup input must never swallow the key.
  key({ key: "/", code: "Slash" });
  $("lookup").click();
  assert.equal(document.activeElement, add);
  assert.equal($("lookup").hidden, true);
  add.value = "prag";
  assert.equal(key({ key: "/" }).defaultPrevented, false);
  assert.equal($("lookup").hidden, true);

  document.querySelector('[data-view="essay"]').click();
  const essay = $("essay-text");
  essay.value = "Keep my draft / exactly as written.";
  essay.focus();
  assert.equal(key({ key: "/" }).defaultPrevented, false);
  assert.equal($("lookup").hidden, true);
  key({ key: "k", metaKey: true });
  assert.equal($("lookup").hidden, false, "macOS Command+K works while editing");
  key({ key: "Escape" });
  assert.equal(document.activeElement, essay);
  assert.equal(essay.value, "Keep my draft / exactly as written.");
  key({ key: "k", ctrlKey: true });
  assert.equal($("lookup").hidden, false, "Control+K works while editing");
  key({ key: "Escape" });
});

test("macOS view clicks release hidden editors and composition/modifier keys are respected", () => {
  const essay = $("essay-text");
  essay.focus();
  // jsdom click(), like macOS WebKit buttons, does not move the input focus.
  document.querySelector('[data-view="stats"]').click();
  assert.notEqual(document.activeElement, essay);
  key({ key: "/" });
  assert.equal($("lookup").hidden, false);
  key({ key: "Escape" });
  for (const options of [
    { key: "/", altKey: true },
    { key: "/", isComposing: true },
    { key: "/", keyCode: 229 },
    { key: "K", metaKey: true, shiftKey: true },
    { key: "/", repeat: true },
  ]) {
    key(options);
    assert.equal($("lookup").hidden, true, JSON.stringify(options));
  }
  $("export-dialog").setAttribute("open", "");
  assert.equal(key({ key: "k", metaKey: true }).defaultPrevented, false);
  assert.equal($("lookup").hidden, true, "another modal keeps its keyboard");
  $("export-dialog").removeAttribute("open");
});
