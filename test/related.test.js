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
