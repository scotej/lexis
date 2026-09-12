import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdf from '../src/core/pdf.js';

await import('../src/vendor/jspdf.umd.min.js');
const fonts = {
  body: (await readFile(new URL('../src/fonts/DejaVuSans.ttf', import.meta.url))).toString('base64'),
  heading: (await readFile(new URL('../src/fonts/DejaVuSerif.ttf', import.meta.url))).toString('base64'),
  fallback: (await readFile(new URL('../src/fonts/Unifont.ttf', import.meta.url))).toString('base64'),
};
export const fixture = {
  word: 'éclat', phonetic: '/eɪˈklɑː/ ə ɜ ʊ ʒ θ ð ŋ',
  senses: [{ pos: 'noun', def: 'Brilliant success; splendour.', example: 'She performed with éclat.', antonyms: ['failure'] }, { pos: 'noun', def: 'Public acclaim.' }],
  synonyms: [{ word: 'brilliance', freq: 2.5, score: 7 }, { word: 'renown', note: 'lasting fame' }],
  source: 'Wiktionary', source_url: 'https://en.wiktionary.org/wiki/éclat', clarification_url: 'https://example.org/clarification',
  added: '2026-08-01', created: 1785542400000, updated: 1785628800000, definition_updated: 1785715200000,
  times_used: 4, essay_uses: 3, review_events: { 'review:one': '2026-08-02' }, essay_use_events: { 'essay:one': 3 },
  srs: { due: '2026-09-12', last: '2026-08-02', interval: 41, reps: 4, lapses: 1, ease: 2.6 }, notes: 'My personal note.',
};
async function readPdf(words, options = {}) {
  const bytes = pdf.buildBankPdf(words, { jsPDF: globalThis.jspdf.jsPDF, fonts, orderLabel: 'word — A–Z', date: new Date('2026-09-11T12:00:00Z'), ...options });
  assert.ok(bytes instanceof Uint8Array);
  const doc = await getDocument({ data: bytes, useSystemFonts: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    for (const item of content.items) {
      assert.ok(item.transform[5] > 20 && item.transform[5] < 825, `text stays inside page: ${item.str}`);
      assert.ok(item.transform[4] >= 39 && item.transform[4] + item.width < 558, `text fits width: ${item.str}`);
    }
    pages.push(content.items.map(item => item.str).join(' '));
  }
  await doc.destroy();
  return pages;
}

test('PDF retains every saved field, all senses, examples and Unicode pronunciations', async () => {
  const before = structuredClone(fixture);
  const pages = await readPdf([fixture]);
  const text = pages.join(' ');
  for (const value of ['éclat', '/eɪˈklɑː/', 'ə ɜ ʊ ʒ θ ð ŋ', 'Brilliant success; splendour.', 'Public acclaim.', 'She performed with éclat.', 'failure', 'brilliance', 'renown', 'lasting fame', '2.5', 'Wiktionary', 'https://en.wiktionary.org/wiki/éclat', 'https://example.org/clarification', '2026-08-01', '2026-09-12', '2026-08-02', '41', '2.6', 'review:one', 'essay:one', 'My personal note.', '2026-09-11', 'word — A–Z']) assert.ok(text.includes(value), `missing ${value}`);
  assert.deepEqual(fixture, before);
});

test('long entries and a large bank flow across pages without dropping text or changing order', async () => {
  const words = Array.from({ length: 45 }, (_, i) => ({ ...fixture, word: `entry-${i}`, senses: [{ pos: 'noun', def: `${'A very long definition. '.repeat(i === 0 ? 800 : 2)} END-${i}` }], source_url: `https://example.org/${'long'.repeat(160)}` }));
  const pages = await readPdf(words);
  assert.ok(pages.length > 10);
  const text = pages.join(' ');
  let at = -1;
  for (let i = 0; i < words.length; i++) {
    const next = text.indexOf(`END-${i}`, at + 1);
    assert.ok(next > at, `entry ${i} fully retained in order`);
    at = next;
  }
  assert.ok(pages.every((page, i) => page.includes(`${i + 1} / ${pages.length}`)), 'page numbers on every page');
});

test('empty bank cannot produce a misleading export', () => {
  assert.throws(() => pdf.buildBankPdf([], { jsPDF: globalThis.jspdf.jsPDF, fonts }), /no words/i);
});

test('foreign-script examples inside English definitions stay visible and searchable', async () => {
  const pages = await readPdf([{ ...fixture, word: 'kanji', senses: [{ pos: 'noun', def: 'A Chinese character (漢字) used in Japanese writing.', example: 'The Japanese word 日本 uses two kanji.' }] }]);
  const text = pages.join(' ');
  assert.ok(text.includes('漢字'));
  assert.ok(text.includes('日本'));
});

test('characters outside PDF font coverage retain their Unicode value instead of disappearing', async () => {
  const text = (await readPdf([{ ...fixture, notes: 'A smile 😀' }])).join(' ');
  assert.ok(text.includes('A smile [U+1F600]'));
});

test('PDF assets retry failed loads and support the first export after going offline', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(pdf.preloadBankPdf(), /fonts/i);
    globalThis.fetch = async url => new Response(await readFile(url));
    await pdf.preloadBankPdf();
    globalThis.fetch = async () => { throw new Error('offline'); };
    const bytes = await pdf.createBankPdf([fixture]);
    const document = await getDocument({ data: bytes }).promise;
    const page = await document.getPage(1);
    const text = (await page.getTextContent()).items.map(item => item.str).join(' ');
    assert.ok(text.includes('Brilliant success; splendour.'));
    assert.ok(text.includes('/eɪˈklɑː/'));
    await document.destroy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
