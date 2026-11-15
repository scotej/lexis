import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { aiProvider } from "../src/core/ai-provider.js";
import {
  chat, aiEmbedWords, fetchKeyInfo, fetchModels, normalizeModel,
  aiSessionUsage, resetAiSessionUsage, setAiNetworkOptions,
} from "../src/core/ai.js";
import { relatedWords } from "../src/core/related.js";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const settings = { key: "sk-proj-test", model: "", strictPrivacy: true };
const calls = [];
beforeEach(() => {
  calls.length = 0;
  resetAiSessionUsage();
  setAiNetworkOptions({ retries: 2, backoffMs: 1, maxBackoffMs: 5 });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "gpt-5.4-mini" }] });
    if (url.endsWith("/embeddings")) return Response.json({
      data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
    return Response.json({
      choices: [{ message: { content: "a helpful answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
  };
});

test("OpenAI project, service-account and legacy keys are routed locally", () => {
  for (const key of ["sk-proj-test", "sk-svcacct-test", "sk-legacy", " sk-proj-test "]) {
    assert.equal(aiProvider(key), "openai");
  }
  assert.equal(aiProvider("sk-or-v1-test"), "openrouter");
  assert.equal(normalizeModel("", settings), "gpt-5.4-mini");
  assert.equal(normalizeModel("openai/gpt-5.4-mini", settings), "gpt-5.4-mini");
});

test("OpenAI chat uses direct authentication and omits router-only fields", async () => {
  assert.equal(await chat(settings, { system: "be helpful", prompt: "hello" }), "a helpful answer");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(call.headers.Authorization, "Bearer sk-proj-test");
  assert.equal(call.headers["HTTP-Referer"], undefined);
  assert.equal(call.headers["X-Title"], undefined);
  assert.deepEqual(call.body, {
    model: "gpt-5.4-mini", store: false,
    messages: [{ role: "system", content: "be helpful" }, { role: "user", content: "hello" }],
  });
  assert.equal(aiSessionUsage().totalTokens, 20);
  assert.equal(aiSessionUsage().cost, 0);
});

test("OpenAI reasoning models receive no unsupported temperature or reasoning object", async () => {
  await chat({ ...settings, model: "o3" }, { prompt: "hello", temperature: 0.2 });
  assert.equal(calls[0].body.model, "o3");
  assert.equal(calls[0].body.temperature, undefined);
  assert.equal(calls[0].body.reasoning, undefined);
});

test("OpenAI embeddings use the direct model ID and preserve response indices", async () => {
  assert.deepEqual(await aiEmbedWords(settings, ["one", "two"]), [[1, 0], [0, 1]]);
  assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
  assert.deepEqual(calls[0].body, {
    model: "text-embedding-3-small", input: ["one", "two"], dimensions: 256, encoding_format: "float",
  });
});

test("OpenAI key checks use models and do not fabricate a billing balance", async () => {
  const info = await fetchKeyInfo(settings.key);
  const models = await fetchModels(settings.key);
  assert.equal(info.label, "OpenAI key");
  assert.equal(info.usage, null);
  assert.equal(info.remaining, null);
  assert.equal(models[0].id, "gpt-5.4-mini");
  assert.ok(calls.every(call => call.url === "https://api.openai.com/v1/models" && !call.body));
});

test("an invalid OpenAI key is never retried at OpenRouter", async () => {
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json({ error: { message: "invalid key" } }, { status: 401 });
  };
  await assert.rejects(chat(settings, { prompt: "hello" }), /OpenAI rejected the key/);
  assert.deepEqual(calls, ["https://api.openai.com/v1/chat/completions"]);
});

test("OpenAI billing exhaustion is distinct from rate limiting and is not retried", async () => {
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json({ error: { code: "insufficient_quota" } }, { status: 429 });
  };
  await assert.rejects(chat(settings, { prompt: "hello" }), /OpenAI API quota exceeded.*billing/);
  assert.equal(calls.length, 1);
});

test("OpenAI embedding failures do not invoke the OpenRouter free-model fallback", async () => {
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json({ error: { message: "billing required" } }, { status: 402 });
  };
  await assert.rejects(relatedWords([{ word: "one" }, { word: "two" }], settings), /OpenAI.*billing/);
  assert.deepEqual(calls, ["https://api.openai.com/v1/embeddings"]);
});

test("OpenAI requests preserve caller cancellation", async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const request = chat(settings, { prompt: "hello", signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});
