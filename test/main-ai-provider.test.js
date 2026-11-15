import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { emptyBank } from "../src/core/bank.js";

test("settings switch between providers without reusing models, balances or exposed keys", async () => {
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://lexis.test/" });
  for (const name of ["document", "localStorage", "sessionStorage", "location", "Blob", "File", "Event", "KeyboardEvent"]) {
    globalThis[name] = dom.window[name];
  }
  globalThis.addEventListener = () => {};
  globalThis.__TAURI__ = {
    core: { async invoke(command) {
      if (command === "load_bank") return JSON.stringify(emptyBank());
      if (command === "save_bank") return;
      if (command === "check_update") return null;
      if (command === "ai_device_key") return Array(32).fill(1);
      throw new Error(`unexpected command: ${command}`);
    } },
    opener: { openUrl: async () => {} },
    event: { listen: async () => () => {} },
  };
  const requests = [];
  let invalid = false;
  let delayedBalance = null;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("/models") && !String(url).endsWith("/key")) throw new Error("offline asset");
    requests.push({ url, auth: init.headers.Authorization });
    if (invalid) return Response.json({ error: { message: "invalid key" } }, { status: 401 });
    if (String(url).endsWith("/key")) {
      if (delayedBalance) return new Promise(resolve => { delayedBalance.resolve = resolve; });
      return Response.json({ data: { label: "router", usage: 1, limit: 10 } });
    }
    return Response.json({ data: [{ id: String(url).includes("openai.com") ? "gpt-5.4-mini" : "anthropic/claude-test" }] });
  };
  await import("../src/main.js");
  const $ = id => document.getElementById(id);
  const until = async predicate => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("expected settings state did not appear");
  };
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("input")); };
  const save = async () => {
    $("ai-settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => !$("ai-save").disabled && !$("ai-status").hidden);
  };
  await until(() => $("gate").hidden);
  input("ai-key", "sk-or-v1-test");
  input("ai-model", "anthropic/claude-test");
  await save();
  assert.match($("ai-status").textContent, /Key verified/);
  assert.match($("ai-key-spent").textContent, /US\$1.00 spent/);

  // An old provider's pending refresh must not overwrite the new account.
  delayedBalance = {};
  $("ai-refresh").click();
  await until(() => delayedBalance.resolve);
  input("ai-key", "sk-proj-test");
  assert.equal($("ai-model").value, "");
  assert.match($("ai-provider-note").textContent, /Detected: OpenAI/);
  assert.equal($("ai-router-privacy").hidden, true);
  assert.equal($("ai-openai-privacy").hidden, false);
  input("ai-model", "gpt-5.4-mini");
  await save();
  assert.match($("ai-status").textContent, /Key verified/);
  assert.equal($("ai-key").value, "");
  assert.equal($("ai-key-label").textContent, "OpenAI key");
  assert.match($("ai-key-spent").textContent, /platform.openai.com/);
  assert.ok(requests.some(r => r.url === "https://api.openai.com/v1/models"));
  assert.ok(requests.every(r => r.auth.startsWith("Bearer sk-or-") === r.url.includes("openrouter.ai")));
  delayedBalance.resolve(Response.json({ data: { label: "stale router", usage: 99 } }));
  await until(() => !$("ai-refresh").disabled);
  assert.equal($("ai-key-label").textContent, "OpenAI key");

  invalid = true;
  input("ai-key", "sk-proj-invalid");
  input("ai-model", "");
  await save();
  assert.match($("ai-status").textContent, /Saved, but.*OpenAI rejected the key/);
  assert.equal($("ai-status").classList.contains("error"), true);
  $("ai-remove").click();
  await until(() => $("ai-remove").hidden);
  assert.equal($("ai-facts").hidden, true);
  assert.equal($("ai-openai-privacy").hidden, true);
  dom.window.close();
});
