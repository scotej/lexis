import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as related from '../src/core/related.js';
import { setAiNetworkOptions, aiSessionUsage, resetAiSessionUsage } from '../src/core/ai.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const settings = { key: 'test-key', model: 'a/chat-model', strictPrivacy: true };
const word = (name, def = name) => ({ word: name, senses: [{ pos: 'noun', def }], synonyms: [{ word: 'associate', score: 9 }], times_used: 999, source_url: 'private-url' });
function api(vectors, inspect = () => {}) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    inspect(url, init, body);
    return Response.json({ data: vectors(body.input).map((embedding, index) => ({ embedding, index })).reverse(), usage: { prompt_tokens: 12 } });
  };
}

test('semantic ordering puts near meanings next to each other without changing entries', async () => {
  const words = [word('apple'), word('anger'), word('pear'), word('rage')];
  const before = structuredClone(words);
  api(() => [[1, 0], [0, 1], [0.99, 0.01], [0.01, 0.99]], (url, init, body) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/embeddings');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(body.model, 'openai/text-embedding-3-small');
    assert.deepEqual(body.provider, { data_collection: 'deny', zdr: true });
    assert.match(body.input[0], /noun.*apple/s);
    assert.match(body.input[0], /associate/);
    assert.doesNotMatch(JSON.stringify(body), /private-url|times_used|999|test-key/);
  });
  resetAiSessionUsage();
  const result = await related.relatedWords(words, settings);
  const names = result.map(w => w.word);
  assert.equal(Math.abs(names.indexOf('apple') - names.indexOf('pear')), 1);
  assert.equal(Math.abs(names.indexOf('anger') - names.indexOf('rage')), 1);
  assert.deepEqual(words, before);
  assert.equal(new Set(result).size, 4);
  assert.equal(aiSessionUsage().promptTokens, 12);
});

test('all words across bounded batches participate in one global order', async () => {
  const words = Array.from({ length: 105 }, (_, i) => word(`word-${i}`, `${i % 2 ? 'fruit' : 'feeling'} ${'x'.repeat(12000)}`));
  let requests = 0;
  api(inputs => inputs.map(text => text.includes('fruit') ? [1, 0] : [0, 1]), (_url, _init, body) => {
    requests++;
    assert.ok(body.input.length <= 32);
    assert.ok(body.input.every(input => input.length <= 6000));
  });
  const result = await related.relatedWords(words, settings);
  assert.ok(requests > 1);
  assert.equal(new Set(result).size, 105);
  const themes = result.map(w => w.senses[0].def.startsWith('fruit'));
  assert.equal(themes.slice(1).filter((t, i) => t !== themes[i]).length, 1);
});

test('malformed, missing, duplicate, zero or inconsistent vectors fail without a partial order', async () => {
  const words = [word('a'), word('b')];
  for (const data of [[], [{index: 0, embedding: [1]}], [{index: 0, embedding: [1]}, {index: 0, embedding: [2]}], [{index: 0, embedding: [0]}, {index: 1, embedding: [1]}], [{index: 0, embedding: [1]}, {index: 1, embedding: [1, 2]}], [{index: 0, embedding: ['bad']}, {index: 1, embedding: [2]}]]) {
    globalThis.fetch = async () => Response.json({ data });
    await assert.rejects(related.relatedWords(words, settings), /embedding|vector/i);
  }
});

test('empty/single banks need no request; no key and aborted requests fail clearly', async () => {
  globalThis.fetch = () => { throw new Error('unexpected request'); };
  assert.deepEqual(await related.relatedWords([], null), []);
  const single = [word('solo')];
  assert.deepEqual(await related.relatedWords(single, null), single);
  await assert.rejects(related.relatedWords([word('a'), word('b')], null), /key/i);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(related.relatedWords([word('a'), word('b')], settings, { signal: ctl.signal }), { name: 'AbortError' });
});

test('cancel aborts an in-flight HTTP request without retrying', async () => {
  const ctl = new AbortController();
  let requests = 0;
  setAiNetworkOptions({ retries: 2, backoffMs: 1 });
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    requests++;
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
    ctl.abort();
  });
  await assert.rejects(related.relatedWords([word('a'), word('b')], settings, { signal: ctl.signal }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('dictionary fingerprint ignores study changes but detects meanings, synonyms and membership', () => {
  const words = [word('apple'), word('pear')];
  const key = related.relatedFingerprint(words);
  assert.equal(related.relatedFingerprint([...words].reverse()), key);
  words[0].times_used++;
  assert.equal(related.relatedFingerprint(words), key);
  words[0].senses[0].def = 'different';
  assert.notEqual(related.relatedFingerprint(words), key);
});

/* ---- a key that can only buy free models ----
 *
 * Every embedding model OpenRouter sells is a paid one, so a key that has
 * never bought credits is refused the ordering outright with a 402 — a status
 * whose plain reading, "you have run out", is exactly wrong about a key that
 * has spent nothing. These prove the chat model picks the job up instead, and
 * that the bank survives whatever the reply does to the names in it.
 */

/** A fake OpenRouter that sells no embeddings but answers chat. */
function freeKeyApi(reply, inspect = () => {}) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    inspect(String(url), init, body);
    if (String(url).endsWith('/embeddings')) {
      return Response.json(
        { error: { message: 'Insufficient credits. This account never purchased credits.' } },
        { status: 402 }
      );
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify(reply(body)) } }],
      usage: { prompt_tokens: 7 },
    });
  };
}

test('a key with no credit for embeddings is grouped by the chat model instead', async () => {
  const words = [word('apple', 'a fruit'), word('anger', 'a feeling'), word('pear', 'a fruit'), word('rage', 'a feeling')];
  const before = structuredClone(words);
  const seen = [];
  freeKeyApi(
    () => ({ groups: [{ theme: 'strong feeling', words: ['anger', 'rage'] }, { theme: 'fruit', words: ['pear', 'apple'] }] }),
    (url, init, body) => {
      seen.push(url);
      if (!url.endsWith('/chat/completions')) return;
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      assert.equal(body.model, 'a/chat-model');
      assert.deepEqual(body.provider, { data_collection: 'deny', zdr: true });
      assert.match(JSON.stringify(body), /apple/);
      assert.doesNotMatch(JSON.stringify(body), /private-url|times_used|999/);
    }
  );
  const notes = [];
  const result = await related.relatedWords(words, settings, { onProgress: text => notes.push(text) });
  assert.deepEqual(seen, ['https://openrouter.ai/api/v1/embeddings', 'https://openrouter.ai/api/v1/chat/completions']);
  const names = result.map(w => w.word);
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4);
  assert.equal(Math.abs(names.indexOf('apple') - names.indexOf('pear')), 1);
  assert.equal(Math.abs(names.indexOf('anger') - names.indexOf('rage')), 1);
  assert.deepEqual(words, before);
  assert.ok(notes.some(note => /chat model/i.test(note)), 'the swap is said out loud');
});

test('words the reply drops, repeats or invents still leave a complete order', async () => {
  const words = ['alpha', 'beta', 'gamma', 'delta'].map(name => word(name));
  freeKeyApi(() => ({
    groups: [
      { theme: 'letters', words: ['gamma', 'gamma', 'omega', 'BETA'] },
      { theme: 'strays', words: ['alpha'] },
      { theme: '', words: ['delta'] },
    ],
  }));
  const result = await related.relatedWords(words, settings);
  const names = result.map(w => w.word);
  assert.equal(new Set(names).size, 4);
  assert.deepEqual([...names].sort(), ['alpha', 'beta', 'delta', 'gamma']);
  // Dropped by a nameless group, so it lands in the remainder bucket at the end.
  assert.equal(names.at(-1), 'delta');
});

test('a bank too big for one grouping request is split, and later chunks are told the themes so far', async () => {
  const words = Array.from({ length: 130 }, (_, i) => word(`word-${i}`));
  const asked = [];
  let chunk = 0;
  freeKeyApi(
    body => {
      const listed = body.messages.at(-1).content.match(/^- (word-\d+)/gm).map(line => line.slice(2));
      return { groups: [{ theme: `chunk ${chunk++}`, words: listed }] };
    },
    (url, _init, body) => { if (url.endsWith('/chat/completions')) asked.push(body.messages.at(-1).content); }
  );
  const result = await related.relatedWords(words, settings);
  assert.equal(asked.length, 3);
  assert.ok(asked.slice(1).every(prompt => /themes/i.test(prompt) && /chunk 0/.test(prompt)));
  assert.equal(new Set(result.map(w => w.word)).size, 130);
});

test('running out of credit partway through the embeddings is reported, not quietly re-sorted', async () => {
  const words = Array.from({ length: 40 }, (_, i) => word(`word-${i}`));
  let batches = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/embeddings')) throw new Error('the chat model should not be asked');
    if (++batches === 1) {
      return Response.json({ data: Array.from({ length: 32 }, (_, i) => ({ index: i, embedding: [1, i] })) });
    }
    return Response.json({ error: { message: 'Insufficient credits. Add more at openrouter.ai' } }, { status: 402 });
  };
  await assert.rejects(related.relatedWords(words, settings), /credits/i);
  assert.equal(batches, 2);
});

test('cancel during the chat-model fallback aborts without a partial order', async () => {
  const ctl = new AbortController();
  let chats = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/embeddings')) {
      return Response.json({ error: { message: 'never purchased credits' } }, { status: 402 });
    }
    chats++;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
      ctl.abort();
    });
  };
  await assert.rejects(
    related.relatedWords([word('a'), word('b')], settings, { signal: ctl.signal }),
    { name: 'AbortError' }
  );
  assert.equal(chats, 1);
});

test('a reply that groups nothing fails clearly rather than inventing an order', async () => {
  freeKeyApi(() => ({ groups: [] }));
  await assert.rejects(related.relatedWords([word('a'), word('b')], settings), /group/i);
});
