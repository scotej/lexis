// Synthetic DOM benchmark, not a browser/WebKit frame-time measurement.
// Run: node scripts/benchmark-bank.mjs
// Optional argument: a main.js path relative to the repo, for before/after runs.
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import * as bankModel from "../src/core/bank.js";
import { todayISO } from "../src/core/srs.js";

const dom = new JSDOM(await readFile(new URL("../src/index.html", import.meta.url), "utf8"), {
  url: "https://lexis.test/",
});
for (const name of ["document", "localStorage", "sessionStorage", "location", "Blob", "File", "Event", "KeyboardEvent"]) {
  globalThis[name] = dom.window[name];
}
globalThis.addEventListener = () => {};
globalThis.fetch = async () => { throw new Error("offline benchmark asset"); };

const bank = bankModel.emptyBank();
for (let index = 0; index < 1000; index++) {
  let suffix = "";
  for (let n = index; ; n = Math.floor(n / 26) - 1) {
    suffix = String.fromCharCode(97 + n % 26) + suffix;
    if (n < 26) break;
  }
  bank.words.push(bankModel.newWord(`word${suffix}`, {
    phonetic: "/test/",
    senses: Array.from({ length: 4 }, (_, sense) => ({
      pos: "noun", def: `A dictionary definition for meaning ${sense}.`, example: "A sentence using this word.",
    })),
    source: "test", source_url: "https://example.invalid",
  }, Array.from({ length: 4 }, (_, synonym) => ({ word: `synonym${synonym}` })), todayISO()));
}
bankModel.ensureTodayList(bank, todayISO());
globalThis.__TAURI__ = {
  core: { async invoke(command) {
    if (command === "load_bank") return JSON.stringify(bank);
    if (command === "save_bank" || command === "check_update") return null;
    if (command === "ai_device_key") return Array(32).fill(1);
    throw new Error(`unexpected command: ${command}`);
  } },
  opener: { openUrl: async () => {} },
  event: { listen: async () => () => {} },
};
const start = performance.now();
await import(new URL(`../${process.argv[2] ?? "src/main.js"}`, import.meta.url));
while (document.querySelectorAll(".entry-head").length !== 1000) {
  if (performance.now() - start > 5000) throw new Error("Bank did not render within five seconds.");
  await new Promise(resolve => setTimeout(resolve, 1));
}
console.log(JSON.stringify({
  benchmark: "synthetic JSDOM bank startup",
  rows: 1000,
  initialRenderMs: Math.round(performance.now() - start),
  nodes: document.getElementById("word-list").querySelectorAll("*").length,
  hiddenBodyNodes: document.querySelectorAll(".entry-body *").length,
}));
// The app owns periodic background timers; this one-shot measurement is done.
process.exit(0);
