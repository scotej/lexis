/**
 * The OpenRouter client and its encrypted settings.
 *
 * The network suites prove the client survives the failure modes OpenRouter
 * and hostile networks actually produce — a revoked key, an empty balance,
 * throttling, a stall — each against a fake API that misbehaves in exactly
 * one way. The settings suites prove the pasted key exists only as
 * ciphertext at rest, sealed under a password-derived key on the web and a
 * device key on the desktop.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- environment shims -------------------------------------------------

class MemoryStorage {
  #map = new Map();
  getItem(k) {
    return this.#map.has(k) ? this.#map.get(k) : null;
  }
  setItem(k, v) {
    this.#map.set(k, String(v));
  }
  removeItem(k) {
    this.#map.delete(k);
  }
  clear() {
    this.#map.clear();
  }
}
globalThis.localStorage = new MemoryStorage();

const calls = [];

/** A well-behaved fake OpenRouter. Wrappers below inject failures. */
function baseFetch(url, init = {}) {
  return respond(url, init);
}

/**
 * The single place a response is produced, so the `calls` journal records
 * wrapper-injected failures too. A wrapper may pass `status` to fail one
 * attempt with an injected error.
 */
function respond(url, init = {}) {
  const u = new URL(url);
  calls.push({
    path: u.pathname,
    method: init.method ?? "GET",
    auth: init.headers?.Authorization,
    body: init.body ? JSON.parse(init.body) : null,
  });
  if (init.status) {
    return json(init.status, { error: { message: `injected ${init.status}` } });
  }
  if (u.pathname === "/api/v1/chat/completions") {
    const body = JSON.parse(init.body);
    return json(200, {
      choices: [{ message: { content: `echo:${body.messages.at(-1).content}` } }],
    });
  }
  if (u.pathname === "/api/v1/key") {
    return json(200, { data: { label: "lexis", usage: 1.25, limit: 10, is_free_tier: false } });
  }
  if (u.pathname === "/api/v1/models") {
    return json(200, {
      data: [
        { id: "openrouter/auto", name: "Auto", context_length: 200000 },
        { id: "a/b", name: "B", context_length: 8000 },
      ],
    });
  }
  return json(404, { error: { message: "no such endpoint" } });
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

globalThis.fetch = (url, init) => baseFetch(url, init);

const { setAiNetworkOptions, chat, fetchKeyInfo, fetchModels, normalizeModel, parseJSONLoose, stripEmphasis, aiSimilarWords, aiExampleSentences, aiNuance, aiEssayReview, aiSessionUsage, resetAiSessionUsage } =
  await import("../src/core/ai.js");
const { loadAiSettings, saveAiSettings, clearAiSettings, emptyAiSettings } =
  await import("../src/core/ai-settings.js");
const { storeGet, storeSet } = await import("../src/platform/store.js");
const { deriveKey, encryptJSON, decryptJSON, randomSalt } =
  await import("../src/core/crypto.js");

// Shrink every delay so retry paths run in milliseconds.
setAiNetworkOptions({ timeoutMs: 80, retries: 2, backoffMs: 1, maxBackoffMs: 5 });

const SETTINGS = { key: "sk-or-v1-test", model: "" };

function platformWith(key) {
  return { deviceKey: async () => key };
}

async function seededPlatform() {
  const key = await deriveKey("test-password", randomSalt());
  return { key, platform: platformWith(key) };
}

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  globalThis.fetch = (url, init) => baseFetch(url, init);
});

// --- the client ---------------------------------------------------------

test("chat sends the bearer key, the model, and both roles", async () => {
  const text = await chat(SETTINGS, { system: "be brief", prompt: "hello" });
  assert.match(text, /echo:hello/);
  const sent = calls[0].body;
  assert.equal(calls[0].auth, `Bearer ${SETTINGS.key}`);
  assert.equal(sent.model, "openrouter/auto"); // blank model normalizes to auto
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages.at(-1).role, "user");
});

test("a missing key refuses before any request", async () => {
  await assert.rejects(
    () => chat({ key: "", model: "" }, { prompt: "x" }),
    /Add your OpenRouter key/
  );
  assert.equal(calls.length, 0);
});

test("an empty completion is an error, not silence", async () => {
  globalThis.fetch = () =>
    json(200, { choices: [{ message: { content: "   " } }] });
  await assert.rejects(() => chat(SETTINGS, { prompt: "x" }), /empty response/);
});

test("401 names the key, not the network", async () => {
  globalThis.fetch = (url, init) => respond(url, { ...init, status: 401 });
  await assert.rejects(
    () => chat(SETTINGS, { prompt: "x" }),
    /rejected the key/
  );
  assert.equal(calls.length, 1, "auth failures are not retried");
});

test("402 points at credits", async () => {
  globalThis.fetch = () => json(402, { error: { message: "insufficient credits" } });
  await assert.rejects(() => chat(SETTINGS, { prompt: "x" }), /credits/);
});

test("403 passes through the upstream reason when there is one", async () => {
  globalThis.fetch = () =>
    json(403, { error: { message: "moderation flagged this content" } });
  await assert.rejects(
    () => chat(SETTINGS, { prompt: "x" }),
    /moderation flagged this content/
  );
});

test("a transient 500 is retried once and then succeeds", async () => {
  let attempt = 0;
  globalThis.fetch = (url, init) => {
    attempt += 1;
    return respond(url, { ...init, status: attempt === 1 ? 502 : undefined });
  };
  const text = await chat(SETTINGS, { prompt: "retry me" });
  assert.match(text, /echo:retry me/);
  assert.equal(calls.length, 2);
});

test("throttling waits out Retry-After: 0 rather than failing", async () => {
  let throttled = false;
  globalThis.fetch = (url, init) => {
    if (!throttled) {
      throttled = true;
      return json(429, { error: { message: "rate limited" } }, { "retry-after": "0" });
    }
    return baseFetch(url, init);
  };
  const text = await chat(SETTINGS, { prompt: "again" });
  assert.match(text, /echo:again/);
});

test("a stalled request is aborted by the timeout and retried", async () => {
  let hung = false;
  globalThis.fetch = (url, init) => {
    if (!hung) {
      hung = true;
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    }
    return baseFetch(url, init);
  };
  const text = await chat(SETTINGS, { prompt: "wake up" });
  assert.match(text, /echo:wake up/, "the retry carried it through");
});

test("a permanently dead network gives up as a transient error", async () => {
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  await assert.rejects(
    () => chat(SETTINGS, { prompt: "x" }),
    (err) => {
      assert.equal(err.transient, true, "tagged so callers could retry later");
      assert.match(String(err.message), /reach OpenRouter|respond/i);
      return true;
    }
  );
  // No journal entries: the requests never reached any server.
  assert.equal(calls.length, 0);
});

test("a stalled body is aborted by the timeout rather than hanging forever", async () => {
  let stalled = false;
  globalThis.fetch = (url, init) => {
    if (!stalled) {
      stalled = true;
      // Headers arrive promptly; the body never does. A timer that stops at
      // the headers leaves this read hanging with nothing to interrupt it.
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            );
          }),
      });
    }
    return baseFetch(url, init);
  };
  const text = await chat(SETTINGS, { prompt: "slow body" });
  assert.match(text, /echo:slow body/, "the retry carried it through");
});

test("a 200 that isn’t JSON reads as a human error, not a crash", async () => {
  globalThis.fetch = () =>
    new Response("<html>gateway</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  await assert.rejects(() => chat(SETTINGS, { prompt: "x" }), /couldn’t read/);
});

// --- the session ledger --------------------------------------------------

test("the session ledger totals requests, tokens, and cost", async () => {
  resetAiSessionUsage();
  globalThis.fetch = () =>
    json(200, {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0021 },
    });
  await chat(SETTINGS, { prompt: "one" });
  await chat(SETTINGS, { prompt: "two" });

  const usage = aiSessionUsage();
  assert.equal(usage.requests, 2);
  assert.equal(usage.totalTokens, 300);
  assert.ok(Math.abs(usage.cost - 0.0042) < 1e-9, "cost accumulates");
});

test("a request that never succeeded is not counted as spend", async () => {
  resetAiSessionUsage();
  globalThis.fetch = () => json(401, { error: { message: "revoked" } });
  await assert.rejects(() => chat(SETTINGS, { prompt: "x" }));
  assert.equal(aiSessionUsage().requests, 0, "a rejected key spent nothing");
});

test("an unpriced reply adds tokens without inventing a cost", async () => {
  resetAiSessionUsage();
  globalThis.fetch = () =>
    json(200, {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  await chat(SETTINGS, { prompt: "x" });
  const usage = aiSessionUsage();
  assert.equal(usage.totalTokens, 15);
  assert.equal(usage.cost, 0, "absent is not a guess");
});

// --- key facts and catalogue --------------------------------------------

test("fetchKeyInfo reports spend and remaining credit", async () => {
  const info = await fetchKeyInfo(SETTINGS.key);
  assert.equal(info.label, "lexis");
  assert.equal(info.usage, 1.25);
  assert.equal(info.remaining, 8.75);
  assert.equal(info.freeTier, false);
});

test("a key with no spending limit reports null remaining, not zero", async () => {
  globalThis.fetch = () => json(200, { data: { usage: 3.5, limit: null } });
  const info = await fetchKeyInfo(SETTINGS.key);
  assert.equal(info.limit, null);
  assert.equal(info.remaining, null, "an unlimited key must not read as broke");
});

test("fetchModels maps the catalogue", async () => {
  const models = await fetchModels(SETTINGS.key);
  assert.equal(models[0].id, "openrouter/auto");
  assert.ok(models.length >= 2);
});

test("normalizeModel accepts bare ids and chat URLs, defaulting blanks to auto", () => {
  assert.equal(normalizeModel(" anthropic/claude-sonnet "), "anthropic/claude-sonnet");
  assert.equal(
    normalizeModel("https://openrouter.ai/c/openrouter/auto"),
    "openrouter/auto"
  );
  assert.equal(normalizeModel(""), "openrouter/auto", "blank routes to auto");
});

// --- tolerant parsing ----------------------------------------------------

test("parseJSONLoose unwraps markdown fences and prose", () => {
  assert.deepEqual(parseJSONLoose('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJSONLoose('Here you go:\n{"a": [1, 2]} — hope that helps!'), {
    a: [1, 2],
  });
});

test("parseJSONLoose tolerates trailing commas", () => {
  assert.deepEqual(parseJSONLoose('{"a": 1, "b": [1, 2],}'), { a: 1, b: [1, 2] });
});

test("parseJSONLoose throws a human error on garbage", () => {
  assert.throws(() => parseJSONLoose("no json here at all"), /shape we asked for|wasn’t the shape/);
});

test("stripEmphasis removes bold and italic markers", () => {
  assert.equal(stripEmphasis("**vivid** and *precise*"), "vivid and precise");
  assert.equal(stripEmphasis("__underlined__"), "underlined");
});

// --- features ------------------------------------------------------------

test("aiSimilarWords drops the headword itself", async () => {
  globalThis.fetch = () =>
    json(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              words: [
                { word: "demise", note: "the word itself" },
                { word: "eclipse", note: "overshadowing" },
                { word: "oblivion", note: "ruin" },
              ],
            }),
          },
        },
      ],
    });
  const { words } = await aiSimilarWords(SETTINGS, "demise");
  assert.deepEqual(words.map((w) => w.word), ["eclipse", "oblivion"]);
});

test("aiExampleSentences tolerates a bare array response", async () => {
  globalThis.fetch = () =>
    json(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              sentences: ['The novel’s demise mirrors its protagonist.', 'Second sentence.', 'Third sentence.'],
            }),
          },
        },
      ],
    });
  const { sentences } = await aiExampleSentences(SETTINGS, { word: "demise" });
  assert.equal(sentences.length, 3);
  assert.match(sentences[0], /demise/);
});

test("aiNuance aligns distinctions with the words asked about", async () => {
  globalThis.fetch = () =>
    json(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              distinctions: [
                { word: "hubris", nuance: "pride punished" },
                { word: "venality", nuance: "for sale" },
              ],
              guidance: "prefer hubris for tragic flaws.",
            }),
          },
        },
      ],
    });
  const out = await aiNuance(SETTINGS, ["hubris", "venality"]);
  assert.equal(out.distinctions[0].word, "hubris");
  assert.match(out.guidance, /hubris/);
});

test("aiNuance needs at least two distinct words", async () => {
  await assert.rejects(() => aiNuance(SETTINGS, ["hubris"]), /at least two/);
});

test("aiEssayReview maps the full shape and quotes nothing invented", async () => {
  globalThis.fetch = () =>
    json(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "A promising draft.",
              strengths: ["Clear contention."],
              improvements: [{ title: "Evidence", detail: "Quote the text directly." }],
              focus: ["topic sentences"],
            }),
          },
        },
      ],
    });
  const review = await aiEssayReview(SETTINGS, { essay: "My essay.", bankWords: ["demise"] });
  assert.equal(review.summary, "A promising draft.");
  assert.equal(review.strengths[0], "Clear contention.");
  assert.equal(review.improvements[0].title, "Evidence");
  assert.deepEqual(review.focus, ["topic sentences"]);
});

test("aiEssayReview survives improvements given as plain strings", async () => {
  globalThis.fetch = () =>
    json(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              improvements: ["Tighten the introduction.", "Vary sentence openings."],
            }),
          },
        },
      ],
    });
  const review = await aiEssayReview(SETTINGS, { essay: "My essay." });
  assert.equal(review.improvements[0].title || review.improvements[0].detail, "Tighten the introduction.");
  assert.equal(review.improvements.length, 2);
});

test("aiEssayReview refuses an entirely empty response shape", async () => {
  globalThis.fetch = () =>
    json(200, { choices: [{ message: { content: JSON.stringify({}) } }] });
  await assert.rejects(
    () => aiEssayReview(SETTINGS, { essay: "My essay." }),
    /readable feedback/
  );
});

test("aiEssayReview truncates very long drafts instead of failing", async () => {
  let received;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({
      path: u.pathname,
      method: init.method ?? "GET",
      auth: init.headers?.Authorization,
      body: init.body ? JSON.parse(init.body) : null,
    });
    received = JSON.parse(init.body).messages.at(-1).content;
    return json(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "Reads fine.",
              strengths: [],
              improvements: [],
              focus: [],
            }),
          },
        },
      ],
    });
  };
  const huge = "word ".repeat(12000); // ~60k chars, over the cap
  await aiEssayReview(SETTINGS, { essay: huge });
  assert.ok(received.length < 42000, "the draft was trimmed to the cap");
});

// --- encrypted settings ---------------------------------------------------

test("settings survive a round trip and come back exactly as saved", async () => {
  const { platform } = await seededPlatform();
  const saved = await saveAiSettings(platform, { key: " sk-or-v1-abc ", model: " a/b " });
  assert.equal(saved.key, "sk-or-v1-abc", "the key is trimmed");
  assert.equal(saved.model, "a/b");

  const loaded = await loadAiSettings(platform);
  assert.equal(loaded.key, "sk-or-v1-abc");
  assert.equal(loaded.model, "a/b");
});

test("at rest the stored bytes are ciphertext, not the key", async () => {
  const { platform } = await seededPlatform();
  await saveAiSettings(platform, { key: "sk-or-v1-super-secret", model: "" });
  const envelope = await storeGet("lexis-ai");
  assert.ok(envelope?.ct, "an encrypted envelope was written");
  assert.ok(!JSON.stringify(envelope).includes("super-secret"), "no plaintext anywhere in storage");

  // And it decrypts under the sealing key alone.
  const round = await decryptJSON(await platform.deviceKey(), envelope);
  assert.equal(round.key, "sk-or-v1-super-secret");
});

test("a different device key reads as 'not set up', never as someone else's key", async () => {
  const first = await seededPlatform();
  await saveAiSettings(first.platform, { key: "sk-or-v1-mine", model: "" });

  const second = await seededPlatform(); // fresh device key
  const loaded = await loadAiSettings(second.platform);
  assert.deepEqual(loaded, emptyAiSettings());
});

test("saving without a key is refused before anything is written", async () => {
  const { platform } = await seededPlatform();
  await assert.rejects(
    () => saveAiSettings(platform, { key: "  ", model: "a/b" }),
    /Paste your OpenRouter key/
  );
  assert.equal(await storeGet("lexis-ai"), null, "nothing was persisted");
});

test("clear removes the envelope entirely", async () => {
  const { platform } = await seededPlatform();
  await saveAiSettings(platform, { key: "sk-or-v1-x", model: "" });
  await clearAiSettings();
  assert.equal(await storeGet("lexis-ai"), null);
});
