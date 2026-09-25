import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("a failed desktop load leaves navigation unable to save over the file", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://lexis.test/" });
  for (const name of ["document", "localStorage", "sessionStorage", "location", "Blob", "File", "Event", "KeyboardEvent"]) {
    globalThis[name] = dom.window[name];
  }
  globalThis.addEventListener = () => {};
  globalThis.fetch = async () => { throw new Error("offline test asset"); };
  const damaged = '{"words":[';
  let stored = damaged;
  let saves = 0;
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  globalThis.__TAURI__ = { core: {
    async invoke(command, args) {
      if (command === "load_bank") { await loadGate; return stored; }
      if (command === "save_bank") { saves++; stored = args.json; return; }
      throw new Error(`unexpected command: ${command}`);
    },
  } };
  await import("../src/main.js");
  // Navigation must also be unavailable while the load is still pending.
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "1" }));
  releaseLoad();
  for (let i = 0; i < 100 && document.getElementById("gate").hidden; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(document.getElementById("gate").textContent, /Couldn’t open lexis/);
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "Digit1", key: "1" }));
  document.getElementById("rail-lookup").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(saves, 0, "no navigation may create an empty-bank save after a load failure");
  assert.equal(stored, damaged);
  assert.equal(document.getElementById("lookup").hidden, true);
  dom.window.close();
});
