/**
 * Harvests passages from English Wikisource.
 *
 *   node tools/harvest/wikisource.mjs
 *
 * Wikiquote is a shelf of lines; Wikisource is a shelf of whole texts. That
 * distinction is the reason this file exists, and it is entirely about length.
 *
 * A memorable quote is nearly always short — film dialogue and aphorisms are
 * what people write down — so a corpus built only from Wikiquote is starved at
 * the "long" and "thicc" settings, which are then two options that match
 * almost nothing. Oratory is the natural home of the long passage: a paragraph
 * of Lincoln or Woolf is four hundred characters of continuous argument that
 * still stands up on its own, which is exactly what those settings want.
 *
 * Every title here was checked to exist before it was written down. Modern
 * speeches — King, Mandela, the Redfern address — are absent for the ordinary
 * reason that they are still in copyright, so Wikisource cannot host them;
 * their best lines reach the corpus through the speakers' Wikiquote pages
 * instead.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

const CACHE = new URL("../../.quote-cache/", import.meta.url).pathname;
const RAW = `${CACHE}raw/`;
const API = "https://en.wikisource.org/w/api.php";
const UA = "lexis-quote-harvester/1.0 (https://github.com/scotej/lexis)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [page title, who said or wrote it, what to file it under]. */
const TEXTS = [
  // oratory
  ["Gettysburg Address", "Abraham Lincoln", "speech"],
  ["Emancipation Proclamation", "Abraham Lincoln", "speech"],
  ["Ain't I a Woman?", "Sojourner Truth", "speech"],
  ["What to the Slave Is the Fourth of July?", "Frederick Douglass", "speech"],
  ["Declaration of Sentiments", "Elizabeth Cady Stanton", "speech"],
  ["Atlanta Compromise", "Booker T. Washington", "speech"],
  ["We shall fight on the beaches", "Winston Churchill", "speech"],
  ["Their Finest Hour", "Winston Churchill", "speech"],
  ["Blood, Toil, Tears and Sweat", "Winston Churchill", "speech"],
  ["John F. Kennedy's Inaugural Address", "John F. Kennedy", "speech"],
  ["Franklin D. Roosevelt's First Inaugural Address", "Franklin D. Roosevelt", "speech"],
  ["Pearl Harbor speech", "Franklin D. Roosevelt", "speech"],
  ["Declaration of Independence", "Thomas Jefferson", "speech"],

  // essays and pamphlets: argument at length, which is what the long buckets want
  ["A Room of One's Own", "Virginia Woolf", "book"],
  ["A Vindication of the Rights of Woman", "Mary Wollstonecraft", "book"],
  ["Areopagitica", "John Milton", "book"],
  ["Self-Reliance", "Ralph Waldo Emerson", "book"],
  ["Nature", "Ralph Waldo Emerson", "book"],
  ["Civil Disobedience", "Henry David Thoreau", "book"],
  ["Common Sense", "Thomas Paine", "book"],
  ["Rights of Man", "Thomas Paine", "book"],
  ["The American Crisis", "Thomas Paine", "book"],
  ["On Liberty", "John Stuart Mill", "book"],
  ["The Souls of Black Folk", "W. E. B. Du Bois", "book"],
  ["Up From Slavery", "Booker T. Washington", "book"],
  ["Apology (Plato)", "Plato", "book"],
];

async function fetchWikitext(titles) {
  const params = new URLSearchParams({
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    format: "json",
    formatversion: "2",
    redirects: "1",
    titles: titles.join("|"),
  });
  const resp = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const out = new Map();
  for (const page of data?.query?.pages ?? []) {
    const text = page?.revisions?.[0]?.slots?.main?.content;
    if (typeof text === "string" && !page.missing) out.set(page.title, text);
  }
  return out;
}

function stripMarkup(raw) {
  return String(raw)
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, " ")
    .replace(/<ref[^>]*\/>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z][^>]{0,120}>/gi, " ")
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[(?:https?|\/\/)[^\s\]]*\s+([^\]]*)\]/g, "$1")
    .replace(/'''''|'''|''/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Sentence-sized cuts of a paragraph that is too long to type in one sitting.
 *
 * Cutting on sentence boundaries rather than at a character count is the whole
 * point: a passage that stops mid-clause is not a passage, it is a truncation,
 * and the typist meets it as a mistake in the corpus rather than as an ending.
 */
function chunk(paragraph, min = 320, max = 900) {
  if (paragraph.length <= max) return paragraph.length >= min ? [paragraph] : [];
  const sentences = paragraph.match(/[^.!?]+[.!?]+["')\]]?\s*/g) ?? [paragraph];
  const out = [];
  let run = "";
  for (const sentence of sentences) {
    if ((run + sentence).length > max && run.length >= min) {
      out.push(run.trim());
      run = "";
    }
    run += sentence;
  }
  if (run.trim().length >= min) out.push(run.trim());
  return out;
}

const SKIP_LINE =
  /^\s*(\||!|\{\||\|\}|=|\*|#|:|;|\[\[(?:File|Image|Category):|__)/i;

function passages(wikitext) {
  const body = wikitext
    // Wikisource wraps the text proper in a header template; drop it.
    .replace(/^\s*\{\{[\s\S]*?\}\}\s*/g, "")
    .split(/\n\s*\n+/);

  const out = [];
  for (const block of body) {
    const lines = block.split("\n").filter((line) => line.trim() && !SKIP_LINE.test(line));
    if (!lines.length) continue;
    const paragraph = stripMarkup(lines.join(" ")).replace(/\s+/g, " ").trim();
    if (paragraph.length < 320) continue;
    if (/^(chapter|section|part|book|note|preface|contents|index)\b/i.test(paragraph)) continue;
    out.push(...chunk(paragraph));
  }
  return out;
}

async function main() {
  await mkdir(RAW, { recursive: true });
  const cachePath = `${RAW}wikisource.json`;
  let cached = {};
  try {
    cached = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    /* first run */
  }

  const titles = TEXTS.map(([title]) => title);
  const wanted = titles.filter((title) => !(title in cached));
  for (let i = 0; i < wanted.length; i += 25) {
    const batch = wanted.slice(i, i + 25);
    const got = await fetchWikitext(batch);
    for (const title of batch) cached[title] = got.get(title) ?? null;
    for (const [title, text] of got) cached[title] ??= text;
    process.stderr.write(`\r  wikisource: ${Math.min(i + 25, wanted.length)}/${wanted.length} fetched`);
    await sleep(150);
  }
  if (wanted.length) process.stderr.write("\n");
  await writeFile(cachePath, JSON.stringify(cached));

  const quotes = [];
  let missing = 0;
  for (const [title, author, kind] of TEXTS) {
    const wikitext = cached[title];
    if (!wikitext) {
      missing++;
      continue;
    }
    for (const text of passages(wikitext)) {
      quotes.push({ text, speaker: kind === "speech" ? author : "", work: title, author, kind });
    }
  }

  await writeFile(`${CACHE}wikisource-speeches.json`, JSON.stringify(quotes));
  process.stderr.write(
    `wikisource: ${quotes.length} passages from ${TEXTS.length - missing} texts` +
      `${missing ? ` (${missing} unavailable)` : ""}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
