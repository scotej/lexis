import { test } from "node:test";
import assert from "node:assert/strict";

test("browser storage refuses to report a saved bank when no store is available", async () => {
  // Node has no IndexedDB. Remove the localStorage fallback too, as can
  // happen in a restricted browser context.
  const previousIndexedDB = globalThis.indexedDB;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.indexedDB = undefined;
  globalThis.localStorage = undefined;

  try {
    const { createWebPlatform } = await import("../src/platform/web.js");
    const platform = createWebPlatform();
    platform.setKey(await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    ));

    await assert.rejects(
      platform.storage.save({ version: 3, words: [], deleted: [] }),
      /Browser storage is unavailable/
    );
  } finally {
    globalThis.indexedDB = previousIndexedDB;
    globalThis.localStorage = previousLocalStorage;
  }
});
