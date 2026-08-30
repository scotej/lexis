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

test("a passage that overshoots is kept when the typist also ticked that class", async () => {
  // The batch is written for one length, but the typist picked a set. A medium
  // passage that came out long is exactly what someone who ticked both asked
  // for, and judging it against medium alone threw the whole batch away.
  fakeOpenRouter(
    JSON.stringify({
      passages: [{ text: passage(430, "over"), words: [] }, { text: passage(200, "on"), words: [] }],
    })
  );
  const { passages } = await aiQuotes(settings, {
    length: "medium",
    accept: ["medium", "long"],
    count: 2,
  });
  assert.equal(passages.length, 2, "both fall inside a class that was ticked");
});

test("every length ticked means no passage is ever dropped for its size", async () => {
  fakeOpenRouter(
    JSON.stringify({
      passages: [
        { text: passage(50, "a"), words: [] },
        { text: passage(250, "b"), words: [] },
        { text: passage(500, "c"), words: [] },
        { text: passage(1200, "d"), words: [] },
      ],
    })
  );
  const { passages } = await aiQuotes(settings, {
    length: "medium",
    accept: ["short", "medium", "long", "thicc"],
    count: 4,
  });
  assert.equal(passages.length, 4, "the four windows meet, so they leave no gap");
});

test("the error names the set when more than one length is on", async () => {
  fakeOpenRouter(JSON.stringify({ passages: [{ text: passage(2000, "vast") }] }));
  await assert.rejects(
    () => aiQuotes(settings, { length: "medium", accept: ["short", "medium"], count: 1 }),
    /nothing at any length you have picked/
  );
});

test("duplicates within one batch are collapsed", async () => {
  const text = passage(200, "same");
  fakeOpenRouter(JSON.stringify({ passages: [{ text }, { text }, { text: passage(210, "other") }] }));
  const { passages } = await aiQuotes(settings, { length: "medium", count: 3 });
  assert.equal(passages.length, 2);
});

test("a batch that misses the length class says so, rather than 'try again'", async () => {
  // The distinction earns its keep: the same model at the same temperature
  // will miss the class again, so "try again" sends the typist round a loop.
  fakeOpenRouter(JSON.stringify({ passages: [{ text: "too short" }] }));
  await assert.rejects(
    () => aiQuotes(settings, { length: "long", count: 2 }),
    /wrote a passage, but nothing at the long length/
  );
});

test("a batch with nothing in it at all is still an error, not an empty success", async () => {
  fakeOpenRouter(JSON.stringify({ passages: [] }));
  await assert.rejects(() => aiQuotes(settings, { length: "long", count: 2 }), /No usable passages/);
});

test("a reasoning model's schema aside doesn't empty the batch", async () => {
  // The reply that started this: the bare `string[]` in the model's own
  // preamble parsed as an empty array and was taken for the answer.
  fakeOpenRouter(
    `We need "passages": objects each having "text": string and "words": string[].\n\n` +
      JSON.stringify({ passages: [{ text: passage(200, "real"), words: [] }] })
  );
  const { passages } = await aiQuotes(settings, { length: "medium", count: 3 });
  assert.equal(passages.length, 1);
});

test("the request carries the bank words, the length, and nothing else of the student's", async () => {
  const sent = fakeOpenRouter(JSON.stringify({ passages: [{ text: passage(200), words: [] }] }));
  await aiQuotes(settings, { bankWords: ["demise", "candour"], length: "medium", count: 2 });
  const prompt = sent[0].messages.at(-1).content;
  assert.match(prompt, /demise, candour/);
  // Asked in words, because a model cannot count the characters it never sees:
  // medium is 110-300 characters, which is 18-50 words at CHARS_PER_WORD.
  assert.match(prompt, /around 34 words each/);
  assert.match(prompt, /about 18 to 50/);
  assert.doesNotMatch(prompt, /characters/, "counting characters is not a job a model can do");
  // And asked as a target rather than a gate — the gate is applied to what
  // comes back, where it can be applied honestly.
  assert.doesNotMatch(prompt, /\bmust be\b/, "length is a target, not a rule to be counted out");
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
