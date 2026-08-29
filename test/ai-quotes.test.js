/**
 * AI-written passages for the typing test.
 *
 * The interesting behaviour is not the request, it is what happens to the
 * answer: a passage that misses its length class, arrives with typographic
 * punctuation, or repeats the one before it is worse than no passage at all,
 * because the typist meets it as an error they cannot correct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { aiQuotes, setAiNetworkOptions } from "../src/core/ai.js";

setAiNetworkOptions({ timeoutMs: 500, retries: 1, backoffMs: 1 });

const settings = { key: "sk-or-test", model: "openrouter/auto" };

/** Answers one chat completion with whatever `reply` says, and records the ask. */
function fakeOpenRouter(reply) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: typeof reply === "function" ? reply(body) : reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return sent;
}

const passage = (chars, seed = "a") =>
  `The ${seed} of it. ${"Considered prose fills the line. ".repeat(Math.ceil(chars / 32))}`.slice(0, chars);

test("passages come back cleaned up and in order", async () => {
  fakeOpenRouter(
    JSON.stringify({
      passages: [
        { text: passage(180, "first"), words: ["Demise"] },
        { text: passage(200, "second"), words: [] },
      ],
    })
  );
  const { passages } = await aiQuotes(settings, { bankWords: ["demise"], length: "medium", count: 2 });
  assert.equal(passages.length, 2);
  assert.deepEqual(passages[0].words, ["demise"], "bank words come back folded to lower case");
});

test("typographic punctuation is flattened onto the keyboard", async () => {
  fakeOpenRouter(
    JSON.stringify({
      passages: [{ text: `“Naïveté” — the word’s own trap… ${passage(140, "x")}`, words: [] }],
    })
  );
  const { passages } = await aiQuotes(settings, { length: "medium", count: 1 });
  assert.match(passages[0].text, /^[\x20-\x7e]+$/, "only characters a keyboard has");
  assert.match(passages[0].text, /"Naivete" - the word's own trap\.\.\./);
});

test("a passage that misses its length class is dropped, not misfiled", async () => {
  fakeOpenRouter(
    JSON.stringify({
      passages: [
        { text: passage(60), words: [] }, // asked for medium, sent short
        { text: passage(200), words: [] },
        { text: passage(900), words: [] }, // and a thicc one
      ],
    })
  );
  const { passages } = await aiQuotes(settings, { length: "medium", count: 3 });
  assert.equal(passages.length, 1);
  assert.ok(passages[0].text.length > 110 && passages[0].text.length <= 375);
});

test("duplicates within one batch are collapsed", async () => {
  const text = passage(200, "same");
  fakeOpenRouter(JSON.stringify({ passages: [{ text }, { text }, { text: passage(210, "other") }] }));
  const { passages } = await aiQuotes(settings, { length: "medium", count: 3 });
  assert.equal(passages.length, 2);
});

test("a batch with nothing usable in it is an error, not an empty success", async () => {
  fakeOpenRouter(JSON.stringify({ passages: [{ text: "too short" }] }));
  await assert.rejects(() => aiQuotes(settings, { length: "long", count: 2 }), /No usable passages/);
});

test("the request carries the bank words, the length, and nothing else of the student's", async () => {
  const sent = fakeOpenRouter(JSON.stringify({ passages: [{ text: passage(200), words: [] }] }));
  await aiQuotes(settings, { bankWords: ["demise", "candour"], length: "medium", count: 2 });
  const prompt = sent[0].messages.at(-1).content;
  assert.match(prompt, /demise, candour/);
  assert.match(prompt, /110 and 300 characters/);
  assert.equal(sent[0].provider.data_collection, "deny", "strict privacy rides along by default");
});

test("a bare array of strings is accepted, because models send one", async () => {
  fakeOpenRouter(JSON.stringify([passage(200, "bare"), passage(210, "array")]));
  const { passages } = await aiQuotes(settings, { length: "medium", count: 2 });
  assert.equal(passages.length, 2);
});

test("the batch size is bounded whatever the caller asks for", async () => {
  const sent = fakeOpenRouter(JSON.stringify({ passages: [{ text: passage(200), words: [] }] }));
  await aiQuotes(settings, { length: "medium", count: 999 });
  assert.match(sent[0].messages.at(-1).content, /^Write 6 original passages/);
});

test("no key means no request", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not happen");
  };
  await assert.rejects(() => aiQuotes({ key: "" }, { length: "medium" }), /OpenRouter key/);
  assert.equal(called, false);
});
