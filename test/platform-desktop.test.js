import { test } from "node:test";
import assert from "node:assert/strict";

const calls = [];
let bankOnDisk = null;
globalThis.__TAURI__ = {
  core: {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "load_bank") return bankOnDisk;
      if (command === "save_bank") {
        bankOnDisk = args.json;
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  },
};

const { createDesktopPlatform } = await import("../src/platform/desktop.js");

test("desktop refuses a damaged bank instead of replacing it with an empty one", async () => {
  bankOnDisk = '{"words":[';
  calls.length = 0;
  const platform = createDesktopPlatform();

  await assert.rejects(platform.storage.load(), /bank\.json is not valid JSON/);
  assert.equal(bankOnDisk, '{"words":[');
  assert.deepEqual(calls.map((call) => call.command), ["load_bank"]);

  bankOnDisk = "";
  await assert.rejects(platform.storage.load(), /bank\.json is not valid JSON/);
  assert.equal(bankOnDisk, "", "an empty file is damaged, not a first run");

  bankOnDisk = "{}";
  await assert.rejects(platform.storage.load(), /no valid words list/);
  assert.equal(bankOnDisk, "{}", "valid JSON can still be a damaged bank");
});

test("desktop still accepts a missing or valid bank", async () => {
  const platform = createDesktopPlatform();
  bankOnDisk = null;
  assert.equal(await platform.storage.load(), null);

  bankOnDisk = JSON.stringify({ version: 3, words: [], deleted: [] });
  assert.deepEqual(await platform.storage.load(), { version: 3, words: [], deleted: [] });
});
