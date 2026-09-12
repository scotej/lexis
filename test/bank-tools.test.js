import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as tools from '../src/bank-tools.js';

const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const entry = (word, created) => ({ word, created, added: '2026-09-11', senses: [{ pos: 'noun', def: word }], synonyms: [], srs: { due: '2026-09-11', last: null } });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function setup(initial = [entry('zebra', 1), entry('apple', 2)], extra = {}) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function() { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  let words = initial;
  const saved = [];
  const builds = [];
  const ui = tools.installBankTools({ document, getWords: () => words, getAiSettings: () => ({ key: 'key' }), onChange: () => {},
    createPdf: async (entries, options) => { builds.push({ entries, options }); return new Uint8Array([37, 80, 68, 70]); },
    savePdf: async (bytes, filename) => { saved.push({ bytes, filename }); return true; }, ...extra });
  const $ = id => document.getElementById(id);
  const select = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('change')); };
  ui.displayWords();
  return { ui, $, select, saved, builds, setWords: value => { words = value; }, dom };
}

test('single word has an export action; empty bank disables export', () => {
  const one = setup([entry('solo', 1)]);
  assert.equal(one.$('bank-tools').hidden, false);
  assert.equal(one.$('bank-export').disabled, false);
  const empty = setup([]);
  assert.equal(empty.$('bank-export').disabled, true);
});

test('export uses all entries, chosen order and a click-time snapshot', async () => {
  const s = setup();
  s.$('bank-export').click();
  assert.equal(s.$('export-dialog').open, true);
  s.select('export-order', 'word-asc');
  s.$('export-save').click();
  s.setWords([]);
  await tick();
  assert.deepEqual(s.builds[0].entries.map(w => w.word), ['apple', 'zebra']);
  assert.match(s.builds[0].options.orderLabel, /A–Z/);
  assert.equal(s.saved.length, 1);
  assert.match(s.saved[0].filename, /^lexis-word-bank-\d{4}-\d{2}-\d{2}\.pdf$/);
});

test('AI sort is reused for export without another request and invalidated when meanings change', async () => {
  let requests = 0;
  const s = setup(undefined, { sortRelated: async words => { requests++; return [...words].reverse(); } });
  s.select('bank-sort', 'related');
  await tick();
  assert.deepEqual(s.ui.displayWords().map(w => w.word), ['apple', 'zebra']);
  s.$('bank-export').click();
  assert.equal(s.$('export-order').value, 'related');
  s.$('export-save').click();
  await tick();
  assert.equal(requests, 1);
  s.setWords([entry('new', 3)]);
  assert.deepEqual(s.ui.displayWords().map(w => w.word), ['new']);
  assert.notEqual(s.$('bank-sort').value, 'related');
  assert.equal(requests, 1, 'render does not spend credits');
});

test('a stale AI result cannot overwrite a later standard sort or changed bank', async () => {
  let resolve;
  const s = setup(undefined, { sortRelated: () => new Promise(done => { resolve = done; }) });
  s.select('bank-sort', 'related');
  s.select('bank-sort', 'word-desc');
  resolve([entry('gone', 0)]);
  await tick();
  assert.deepEqual(s.ui.displayWords().map(w => w.word), ['zebra', 'apple']);
  s.select('bank-sort', 'related');
  s.setWords([entry('replacement', 1)]);
  s.ui.displayWords();
  resolve([entry('gone', 0)]);
  await tick();
  assert.deepEqual(s.ui.displayWords().map(w => w.word), ['replacement']);
});

test('missing key, AI errors and save errors leave controls usable and show the cause', async () => {
  const s = setup(undefined, { getAiSettings: () => null });
  s.select('bank-sort', 'related');
  await tick();
  assert.match(s.$('bank-order-status').textContent, /key/i);
  assert.notEqual(s.$('bank-sort').value, 'related');
  const broken = setup(undefined, { savePdf: async () => { throw new Error('disk full'); } });
  broken.$('bank-export').click();
  broken.$('export-save').click();
  await tick();
  assert.match(broken.$('export-status').textContent, /disk full/);
  assert.equal(broken.$('export-save').disabled, false);
  const cancelled = setup(undefined, { savePdf: async () => false });
  cancelled.$('bank-export').click();
  cancelled.$('export-save').click();
  await tick();
  assert.match(cancelled.$('export-status').textContent, /cancelled/i);
});

test('cancelling export or removing the key prevents late async work from saving', async () => {
  let finish;
  const s = setup(undefined, { sortRelated: () => new Promise(resolve => { finish = resolve; }) });
  s.$('bank-export').click();
  s.select('export-order', 'related');
  s.$('export-save').click();
  s.$('export-close').click();
  finish([entry('late', 1)]);
  await tick();
  assert.equal(s.saved.length, 0);
  assert.equal(s.$('export-dialog').open, false);
  s.select('bank-sort', 'related');
  s.ui.reset();
  finish([entry('late', 1)]);
  await tick();
  assert.notEqual(s.$('bank-sort').value, 'related');
});
