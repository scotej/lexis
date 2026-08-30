/**
 * The typing test view.
 *
 * Self-installing, the way the statistics view is: it adds its own rail link,
 * its own section, and its own stylesheet, so the feature is one import in
 * main.js rather than a hundred lines of markup nobody else needs.
 *
 * The logic it needs is all in the core — the engine, the corpus, the filters,
 * the record book, the prefetch queue. What lives here is the part that has to
 * touch a DOM: painting one word per keystroke instead of the whole passage,
 * keeping a caret on the right character, and making sure the keyboard belongs
 * to the test while a test is running and to the rest of lexis when it isn't.
 */

import { aiQuotes } from "./core/ai.js";
import { createPrefetcher } from "./core/prefetch.js";
import {
  QUOTE_LENGTHS,
  attribution,
  bankWordsIn,
  createBankMatcher,
  createQuotePool,
  filterQuotes,
  loadCorpus,
  quoteLength,
} from "./core/quotes.js";
import { createRun } from "./core/typing.js";
import {
  bankWordTotals,
  emptyRecords,
  normalizeRecords,
  recordResult,
  summarize,
} from "./core/typing-records.js";
import {
  DEFAULT_TYPING_SETTINGS,
  SETTINGS_SCHEMA,
  TIME_PRESETS,
  WORD_PRESETS,
  describeTest,
  engineSettings,
  normalizeTypingSettings,
  optionValues,
  options,
  settingApplies,
  testKey,
} from "./core/typing-settings.js";
import { TIMED_CHUNK, generateWords } from "./core/word-runs.js";

/* ---- small helpers, in the house style ---- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = "lexis-typing-settings";
const RECORDS_KEY = "lexis-typing-records";

/**
 * Preferences and personal bests stay on the device.
 *
 * They are not bank data: a speed is a fact about a keyboard as much as about
 * a typist, and a caret style chosen on a desktop has no business travelling
 * to a school laptop. Nothing here is sensitive, so unlike the bank it is
 * stored as it stands — but it is also never synced, never uploaded, and
 * never sent to a model.
 */
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a full or blocked storage costs a preference, not the feature */
  }
}

/* ---- state ---- */

let context = null; // { app, getAiSettings, aiReady }
let settings = { ...DEFAULT_TYPING_SETTINGS };
let records = emptyRecords();

let corpus = null;
let corpusError = null;
let pool = createQuotePool([]);
let matchCount = null; // how many passages the current filters allow

let run = null;
let current = null; // the passage being typed: { text, title, author, origin, bankWords }
let repeatOf = null; // a passage held back so "repeat" can serve it again

let wordNodes = [];
let ticker = null;
let lineOffset = 0;
let installed = false;
let active = false; // is this the view on screen

let bankSignature = null; // what rebuildPool last filtered against
let aiQueue = null;
let aiQueueKey = "";
let aiState = { ready: 0, size: 0, filling: false, error: null, retryingAt: 0 };
const recentAiOpenings = [];

/* ---- installation ---- */

export function installTypingView() {
  if (installed) return;
  installed = true;

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "typing.css";
  style.dataset.lexisTyping = "";
  document.head.append(style);

  // Beside review rather than beside essay: bank, today, review and type are
  // the four ways of practising, and statistics reports on all of them.
  const button = el("button", "rail-link", "type");
  button.dataset.view = "typing";
  const links = document.querySelector(".rail-links");
  links.insertBefore(
    button,
    links.querySelector('[data-view="stats"]') ?? links.querySelector('[data-view="essay"]')
  );

  const view = el("section", "view");
  view.id = "view-typing";
  view.append(buildChrome());
  const anchor = $("view-stats") ?? $("view-essay");
  anchor.parentNode.insertBefore(view, anchor);
}

/**
 * The input the keyboard actually talks to.
 *
 * A real focused input rather than a document-level key listener, for three
 * reasons: a phone shows its keyboard, lexis's own `/` and `1`–`7` shortcuts
 * already stand aside for a focused field, and "does the test have the
 * keyboard" becomes a thing the browser tracks rather than a flag this module
 * has to keep in step with reality.
 */
function buildChrome() {
  const frame = document.createDocumentFragment();

  const input = el("input", "tt-input");
  input.id = "tt-input";
  input.setAttribute("aria-label", "Typing test");
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.tabIndex = -1;

  const bar = el("div", "tt-bar");
  bar.id = "tt-bar";

  const notice = el("p", "tt-notice");
  notice.id = "tt-notice";
  notice.hidden = true;

  const stage = el("div", "tt-stage");
  stage.id = "tt-stage";

  const meter = el("div", "tt-meter");
  meter.id = "tt-meter";

  const scroller = el("div", "tt-scroller");
  scroller.id = "tt-scroller";
  const words = el("div", "tt-words");
  words.id = "tt-words";
  const caret = el("span", "tt-caret");
  caret.id = "tt-caret";
  scroller.append(words, caret);

  const source = el("p", "tt-source");
  source.id = "tt-source";

  const foot = el("div", "tt-foot");
  foot.id = "tt-foot";

  stage.append(meter, scroller, source, foot);

  const result = el("div", "tt-result");
  result.id = "tt-result";
  result.hidden = true;

  const panel = el("div", "tt-settings");
  panel.id = "tt-settings";
  panel.hidden = true;

  frame.append(input, bar, notice, stage, result, panel);
  return frame;
}

/* ---- wiring ---- */

export function initTypingView(ctx) {
  context = ctx;
  settings = normalizeTypingSettings(readStore(SETTINGS_KEY, {}));
  records = normalizeRecords(readStore(RECORDS_KEY, emptyRecords()));

  const input = $("tt-input");
  input.addEventListener("keydown", onKeyDown);
  // A composed character (a phone's autocorrect, an IME) arrives as input
  // rather than as keydown. Feed each character through and clear the field.
  input.addEventListener("input", () => {
    const text = input.value;
    input.value = "";
    for (const char of text) {
      if (char === " ") run?.space();
      else if (char !== "\n") typeChar(char);
    }
    if (text) afterInput();
  });
  input.addEventListener("blur", () => {
    document.getElementById("view-typing")?.classList.remove("tt-engaged");
    stopTicker();
  });
  input.addEventListener("focus", () => {
    document.getElementById("view-typing")?.classList.add("tt-engaged");
    if (run?.status === "running") startTicker();
  });

  $("tt-scroller").addEventListener("mousedown", (e) => {
    e.preventDefault();
    focusInput();
  });

  renderBar();
  renderSettingsPanel();
}

/** The view came on screen. */
export function renderTypingView() {
  active = true;
  applyAppearance();
  Promise.all([ensureCorpus(), ensureWords()]).then(() => {
    if (!current) nextTest();
    else renderPassage();
    focusInput();
  });
  refreshAiQueue();
  renderBar();
}

/** The view went off screen: give the keyboard back and stop the clock. */
export function suspendTypingView() {
  active = false;
  stopTicker();
  $("tt-input")?.blur();
}

/**
 * The bank changed — a word added, a sync landed, a review ticked.
 *
 * The filters read from it, and so does every AI passage waiting in the queue,
 * so both are rebuilt. The test in progress is deliberately left alone: having
 * the passage change under your fingers mid-sentence would be worse than
 * finishing one test against a slightly stale filter.
 */
export function notifyTypingBankChanged() {
  if (!installed || !context) return;
  // Called after *every* bank mutation, including a tick on today's list, so
  // it earns its keep by noticing when nothing the filters care about actually
  // moved. Re-tokenizing four thousand passages because a review was graded
  // would be a lot of work to arrive back where we started.
  const signature = bankFingerprint();
  if (signature === bankSignature) return;
  bankSignature = signature;
  rebuildPool();
  refreshAiQueue();
  if (active) renderBar();
}

/* ---- where the words come from ---- */

async function ensureCorpus() {
  if (corpus) return corpus;
  try {
    corpus = await loadCorpus();
    corpusError = null;
    rebuildPool();
  } catch (err) {
    corpusError = err;
    showNotice(`The quote library didn’t load — ${String(err.message ?? err)}`, true);
  }
  return corpus;
}

/** The bank words the "my words" filter is currently about. */
function filterWords() {
  const app = context?.app;
  if (!app) return [];
  try {
    switch (settings.bankFilter) {
      case "bank":
        return app.listWords().map((word) => word.word);
      case "today":
        return app.getBank()?.today?.words ?? [];
      case "due":
        return app.dueWords().map((word) => word.word);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/** Every bank word, for marking matches even when the filter is off. */
function allBankWords() {
  try {
    return context?.app?.listWords().map((word) => word.word) ?? [];
  } catch {
    return [];
  }
}

/**
 * The words a passage should be built or chosen around.
 *
 * With the filter off that is the whole bank — an AI passage may as well use
 * words you are learning even when you have not asked it to. One definition,
 * because the prefetch key and the request itself must agree about it: if they
 * drift, the queue stops noticing that the words it was filled for have changed.
 */
function targetWords() {
  return settings.bankFilter === "off" ? allBankWords() : filterWords();
}

function bankFingerprint() {
  return `${settings.bankFilter}|${[...targetWords()].sort().join(",")}|${allBankWords().length}`;
}

function rebuildPool() {
  if (!corpus) return;
  bankSignature = bankFingerprint();
  const filtering = settings.bankFilter !== "off";
  const words = filtering ? filterWords() : allBankWords();
  const matcher = createBankMatcher(words);
  const kept = filterQuotes(corpus, {
    lengths: settings.quoteLengths,
    kinds: settings.quoteKinds,
    bankMatcher: matcher,
    minBankWords: filtering ? settings.minBankWords : 0,
  });
  matchCount = kept.length;
  pool.replace(kept);
}

/* ---- the AI queue ---- */

/**
 * One string describing everything a queued passage was built for.
 *
 * When it changes the queue is thrown away, because a passage written around
 * last week's bank words is stale in a way the typist cannot see — it would
 * simply keep arriving, quietly practising the wrong vocabulary.
 */
function prefetchKey() {
  const ai = context?.getAiSettings?.();
  return [
    settings.quoteSource,
    [...settings.quoteLengths].sort().join("+"),
    settings.bankFilter,
    [...targetWords()].sort().join(","),
    ai?.model ?? "",
    ai?.key ? "keyed" : "none",
  ].join("|");
}

function wantsAi() {
  return settings.mode === "quote" && (settings.quoteSource === "ai" || settings.quoteSource === "both");
}

function refreshAiQueue() {
  if (!wantsAi() || !context?.aiReady?.()) {
    aiQueue?.stop();
    aiQueue = null;
    aiQueueKey = "";
    aiState = { ready: 0, size: 0, filling: false, error: null, retryingAt: 0 };
    return;
  }

  const key = prefetchKey();
  if (aiQueue && key === aiQueueKey) {
    aiQueue.prime();
    return;
  }
  aiQueue?.stop();
  aiQueueKey = key;
  aiQueue = createPrefetcher({
    produce: produceAiPassages,
    size: 3,
    lowWater: 2,
    onChange: (state) => {
      const wasEmpty = aiState.ready === 0;
      aiState = state;
      if (!active) return;
      renderBar();
      // The first passage arriving on a screen that had nothing to offer is
      // the one moment the queue should start the test itself, rather than
      // leaving "writing…" sitting there beside a full queue.
      if (wasEmpty && state.ready > 0 && !run) nextTest();
    },
  });
  aiQueue.prime();
}

async function produceAiPassages(want) {
  const ai = context?.getAiSettings?.();
  if (!ai?.key) throw new Error("Add an OpenRouter key in settings → ai assist.");

  const lengths = settings.quoteLengths.length ? settings.quoteLengths : ["medium"];
  const length = lengths[Math.floor(Math.random() * lengths.length)];
  const { passages } = await aiQuotes(ai, {
    bankWords: targetWords(),
    length,
    // Written for one class, but kept if it lands in any of them. A model that
    // overshoots medium has still written a long passage, and the typist who
    // ticked both asked for exactly that.
    accept: lengths,
    // Two at a time at least: a round trip for one passage costs the same as a
    // round trip for three, and the queue would rather be full than thrifty.
    count: Math.min(4, Math.max(2, want)),
    avoid: recentAiOpenings,
  });

  const matcher = createBankMatcher(allBankWords());
  return passages.map((passage, i) => {
    recentAiOpenings.unshift(passage.text.slice(0, 40));
    recentAiOpenings.length = Math.min(recentAiOpenings.length, 8);
    return {
      id: `ai:${Date.now()}:${i}`,
      text: passage.text,
      speaker: "",
      work: "",
      author: modelName(ai.model),
      kind: "ai",
      origin: "ai",
      length: quoteLength(passage.text),
      bankWords: [...matcher.match(passage.text)],
    };
  });
}

function modelName(model) {
  const id = String(model ?? "").trim();
  if (!id || id === "openrouter/auto") return "openrouter, automatic routing";
  return id;
}

/* ---- starting a test ---- */

function pickPassage() {
  if (settings.mode !== "quote") return null;

  const fromAi = () => (aiQueue ? aiQueue.take() : null);
  if (settings.quoteSource === "ai") return fromAi();
  if (settings.quoteSource === "both") {
    // Prefer whichever is ready, leaning on the library so a slow queue never
    // becomes a wait. The AI passages are the treat, not the staple.
    if (aiState.ready > 0 && Math.random() < 0.5) return fromAi() ?? pool.next();
    return pool.next() ?? fromAi();
  }
  return pool.next();
}

function buildRun() {
  const engine = engineSettings(settings);

  if (settings.mode === "zen") {
    // A blank page: no passage, no end, nothing to get wrong. The engine grows
    // the target to match what is typed, so the only thing being measured is
    // the rhythm — which is the whole point of zen.
    current = { text: "", work: "", author: "", origin: "zen", bankWords: [] };
    return createRun({ words: [""], zen: true, settings: engine });
  }

  if (settings.mode === "quote") {
    const passage = repeatOf ?? pickPassage();
    repeatOf = null;
    if (!passage) {
      current = null;
      return null;
    }
    current = passage;
    // Worked out here, for this one passage. The corpus filter deliberately
    // leaves it unanswered when the bank filter is off, because answering it
    // for every quote in the library costs a second to serve one line.
    current.bankWords = bankWordsIn(passage, createBankMatcher(allBankWords()));
    return createRun({ text: passage.text, settings: engine });
  }

  const words = generateWords(wordPool(), settings.mode === "time" ? TIMED_CHUNK : settings.wordCount, {
    punctuation: settings.punctuation,
    numbers: settings.numbers,
  });
  current = {
    text: words.join(" "),
    work: settings.wordSource === "bank" ? "your bank" : "",
    author: "",
    kind: "words",
    origin: "words",
    // Only the bank's own words count towards "words met at speed" — a mixed
    // run is mostly common words, and crediting those would make the total
    // a measure of how long you typed rather than of what you practised.
    bankWords: settings.wordSource === "common" ? [] : allBankWords(),
  };
  return createRun({
    words,
    duration: settings.mode === "time" ? settings.time : null,
    settings: engine,
  });
}

function wordPool() {
  const bank = allBankWords().filter((word) => /^[a-z'-]+$/i.test(word));
  if (settings.wordSource === "bank") return bank.length ? bank : common();
  if (settings.wordSource === "mixed") return bank.length ? [...common().slice(0, 300), ...bank] : common();
  return common();
}

let commonWords = null;
function common() {
  return commonWords ?? ["the", "of", "and", "to", "in", "that", "it", "was", "for", "with"];
}

/** The word list, loaded beside the corpus. */
async function ensureWords() {
  if (commonWords) return commonWords;
  try {
    ({ COMMON_WORDS: commonWords } = await import("./data/words.js"));
  } catch {
    /* the fallback above keeps words mode usable */
  }
  return commonWords;
}

function nextTest() {
  stopTicker();
  $("tt-result").hidden = true;
  $("tt-stage").hidden = false;
  hideNotice();

  run = buildRun();
  if (!run) {
    renderEmptyPool();
    return;
  }
  lineOffset = 0;
  renderPassage();
  renderMeter();
  $("tt-foot").replaceChildren(hintLine());
  renderBar();
  focusInput();
}

/** Same passage again — the one you were halfway through. */
function repeatTest() {
  repeatOf = settings.mode === "quote" ? current : null;
  nextTest();
}

/**
 * What the restart key does, which is two things depending on where you are.
 *
 * Mid-test it repeats the passage, because a restart there means "let me have
 * another go at *that*". On the result screen it moves on, because the
 * passage is finished and asking for it again is what the *repeat* button is
 * for. Shift always means "a different one", from either place.
 */
function quickRestart(wantsNew) {
  const finished = run && (run.status === "done" || run.status === "failed");
  if (wantsNew || finished) {
    repeatOf = null;
    nextTest();
  } else {
    repeatTest();
  }
}

/* ---- input ---- */

function typeChar(char) {
  run?.type(char);
}

function onKeyDown(e) {
  if (!run) return;
  const quick = settings.quickRestart;

  if (e.key === "Tab") {
    if (quick === "tab") {
      e.preventDefault();
      quickRestart(e.shiftKey);
    }
    return; // otherwise Tab does what Tab does: leave the field
  }
  if (e.key === "Escape") {
    if (quick === "esc") {
      e.preventDefault();
      quickRestart(e.shiftKey);
      return;
    }
    // Escape hands the keyboard back to lexis, so `/` and `1`–`8` work again.
    $("tt-input").blur();
    return;
  }
  if (e.key === "Enter") {
    // Zen has no end of its own, so it needs one keystroke that means "done".
    // Shift+enter, because it is the one combination no restart setting claims.
    if (settings.mode === "zen" && (e.shiftKey || quick !== "enter")) {
      e.preventDefault();
      if (run.status === "running") {
        run.stop();
        finishTest();
      }
      return;
    }
    if (quick === "enter") {
      e.preventDefault();
      quickRestart(e.shiftKey);
    }
    return;
  }

  if (settings.capsLockWarning) {
    const caps = e.getModifierState?.("CapsLock");
    $("view-typing")?.classList.toggle("tt-caps", Boolean(caps));
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    run.backspace(e.ctrlKey || e.altKey || e.metaKey);
    afterInput();
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    run.space();
    afterInput();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1) return;

  e.preventDefault();
  typeChar(e.key);
  afterInput();
}

/**
 * Everything that has to happen after the run's state moved.
 *
 * Repainting only the words that could have changed is what keeps a thicc
 * quote — two hundred words, six hundred character spans — responsive at
 * speed. Repainting the passage on every keystroke does not survive a fast
 * typist on a laptop; this does.
 */
function afterInput() {
  if (!run) return;
  const i = run.index;
  paintWord(i - 1);
  paintWord(i);
  paintWord(i + 1);
  topUpTimedWords();
  syncWordNodes();
  moveCaret();
  playSound();
  startTicker();
  if (run.status === "done" || run.status === "failed") finishTest();
}

/**
 * A timed run has no natural end, so its text is grown in chunks well before
 * the typist can reach the end of what exists. Nobody types a hundred words in
 * the time it takes to generate the next hundred.
 */
function topUpTimedWords() {
  if (settings.mode !== "time" || !run) return;
  if (run.words.length - run.index > TIMED_CHUNK / 2) return;
  run.appendWords(
    generateWords(wordPool(), TIMED_CHUNK, {
      punctuation: settings.punctuation,
      numbers: settings.numbers,
    })
  );
}

/** Gives every target word a node, however it came to exist (zen, or a top-up). */
function syncWordNodes() {
  if (!run) return;
  for (let i = wordNodes.length; i < run.words.length; i++) addWordNode(i);
}

function focusInput() {
  if (!active) return;
  const input = $("tt-input");
  if (input && document.activeElement !== input) input.focus({ preventScroll: true });
}

/* ---- painting ---- */

function renderPassage() {
  const container = $("tt-words");
  container.replaceChildren();
  wordNodes = [];
  if (!run) return;
  // Before the first paint, not after it: paintWord reads this set, and a
  // passage painted against the previous one's words underlines the wrong ones.
  refreshBankWordSet();
  for (let i = 0; i < run.words.length; i++) addWordNode(i);
  container.style.transform = "translateY(0)";
  lineOffset = 0;
  renderSource();
  requestAnimationFrame(moveCaret);
}

function addWordNode(i) {
  const node = el("span", "tt-word");
  wordNodes[i] = node;
  $("tt-words").append(node);
  paintWord(i);
  return node;
}

function paintWord(i) {
  if (!run || i < 0 || i >= run.words.length) return;
  const node = wordNodes[i];
  if (!node) return;

  const view = run.wordView(i);
  const blind = settings.blindMode;
  const parts = [];

  const input = run.typed[i] ?? "";
  view.chars.forEach((char, at) => {
    const span = el("span", "tt-c", char.char);
    // Blind mode paints nothing: no feedback at all until the result screen.
    const state = blind ? "pending" : char.state;
    if (state !== "pending") span.classList.add(`tt-${state}`);
    if (state === "incorrect" && settings.indicateTypos === "replace" && input[at]) {
      // Show what was actually typed in place of what should have been.
      span.textContent = input[at];
    }
    parts.push(span);
  });

  if (!settings.hideExtraLetters) {
    for (const char of view.extra) {
      const span = el("span", "tt-c tt-extra", char);
      if (blind) span.className = "tt-c";
      parts.push(span);
    }
  }

  node.replaceChildren(...parts);
  node.classList.toggle("tt-word-active", view.active);
  node.classList.toggle("tt-word-error", !blind && view.submitted && !view.correct);
  node.classList.toggle("tt-word-done", view.submitted && view.correct);

  if (settings.indicateTypos === "below" && !blind) {
    const typedText = run.typed[i] ?? "";
    const wrong = view.submitted && typedText !== run.words[i];
    node.dataset.typed = wrong ? typedText : "";
    node.classList.toggle("tt-word-typo", wrong && Boolean(typedText));
  } else {
    node.classList.remove("tt-word-typo");
  }

  // Underlining a bank word is the quiet reminder that this is a vocabulary
  // app: you are not just typing, you are meeting *demise* in a sentence.
  if (settings.markBankWords && bankWordSet.size) {
    const bare = run.words[i]?.toLowerCase().replace(/[^a-z'-]/g, "") ?? "";
    node.classList.toggle("tt-word-bank", bankWordSet.has(bare));
  }
}

let bankWordSet = new Set();

function refreshBankWordSet() {
  const words = current?.bankWords ?? [];
  const matcher = createBankMatcher(words);
  bankWordSet = new Set();
  if (!words.length || !run) return;
  for (const word of run.words) {
    const bare = word.toLowerCase().replace(/[^a-z'-]/g, "");
    if (bare && matcher.match(bare).size) bankWordSet.add(bare);
  }
}

/**
 * The caret, and the line the passage is scrolled to.
 *
 * Both are measured from the DOM rather than computed, because the answer
 * depends on where the browser actually broke the lines — which depends on the
 * font, the window width, and the font-size setting.
 */
function moveCaret() {
  const caret = $("tt-caret");
  const scroller = $("tt-scroller");
  const container = $("tt-words");
  if (!caret || !run) return;

  if (settings.caretStyle === "off") {
    caret.hidden = true;
  } else {
    caret.hidden = false;
  }

  const node = wordNodes[run.index];
  if (!node) return;
  const view = run.wordView(run.index);
  const chars = node.children;
  const target = chars[Math.min(view.caret, chars.length - 1)] ?? node;
  const atEnd = view.caret >= chars.length;

  const base = container.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const x = box.left - base.left + (atEnd ? box.width : 0);
  const y = box.top - base.top;

  caret.style.setProperty("--tt-caret-x", `${x}px`);
  caret.style.setProperty("--tt-caret-y", `${y + lineOffset}px`);
  caret.style.setProperty("--tt-caret-w", `${box.width || 10}px`);
  caret.style.setProperty("--tt-caret-h", `${box.height || 20}px`);

  if (settings.tapeMode !== "off") {
    // Tape mode: the caret stays put and the passage slides under it. The
    // caret is a sibling of the words, not a child, so it does not inherit
    // that slide — it has to be pinned to the anchor itself.
    const anchor = scroller.clientWidth * 0.3;
    container.style.transform = `translateX(${anchor - x}px)`;
    caret.style.setProperty("--tt-caret-x", `${anchor}px`);
    caret.style.setProperty("--tt-caret-y", "0px");
    return;
  }

  // Otherwise keep the active line as the second of the three on screen.
  const lineHeight = box.height || 24;
  const line = Math.round(y / lineHeight);
  const wanted = -Math.max(0, line - 1) * lineHeight;
  if (wanted !== lineOffset) {
    lineOffset = wanted;
    container.style.transform = `translateY(${lineOffset}px)`;
    caret.style.setProperty("--tt-caret-y", `${y + lineOffset}px`);
  }
}

/**
 * The credit under the passage.
 *
 * Built from core's attribution() rather than from an if-ladder here, so the
 * result screen and this line can never disagree about who said something.
 */
function creditNodes(quote) {
  if (!quote) return [];
  if (quote.origin === "ai") {
    return [el("span", "tt-source-ai", "written for you"), el("span", null, ` · ${quote.author}`)];
  }
  const segments = attribution(quote);
  if (!segments.length) return quote.work ? [el("span", null, quote.work)] : [];

  const nodes = [];
  segments.forEach((segment, i) => {
    if (i) nodes.push(el("span", null, ", "));
    nodes.push(segment.style === "work" ? el("em", null, segment.text) : el("span", null, segment.text));
  });
  return nodes;
}

function renderSource() {
  const node = $("tt-source");
  const nodes = creditNodes(current);
  if (!nodes.length) {
    node.textContent = "";
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.replaceChildren(...nodes);
  if (current.bankWords?.length && settings.markBankWords) {
    node.append(el("span", "tt-source-bank", ` · your words: ${current.bankWords.join(", ")}`));
  }
}

/* ---- the live readouts ---- */

function startTicker() {
  if (ticker != null) return;
  if (!run || run.status !== "running") return;
  ticker = setInterval(() => {
    if (!run) return stopTicker();
    if (run.tick() !== "running") {
      finishTest();
      return;
    }
    renderMeter();
  }, 100);
  renderMeter();
}

function stopTicker() {
  if (ticker != null) clearInterval(ticker);
  ticker = null;
}

function fmt(value, decimals = settings.showDecimals ? 2 : 0) {
  return Number(value).toFixed(decimals);
}

function renderMeter() {
  const meter = $("tt-meter");
  if (!run) return;
  const parts = [];
  const snapshot = run.status === "idle" ? null : run.live();

  if (settings.timerStyle !== "off") {
    if (settings.mode === "time") {
      const left = Math.ceil(run.remaining() ?? settings.time);
      if (settings.timerStyle !== "bar") parts.push(metricNode("", String(left)));
    } else if (settings.timerStyle !== "bar") {
      parts.push(metricNode("", `${Math.min(run.index + 1, run.words.length)}/${run.words.length}`));
    }
  }
  if (settings.liveWpm && snapshot) parts.push(metricNode("wpm", fmt(snapshot.wpm)));
  if (settings.liveAccuracy && snapshot && !settings.blindMode) {
    parts.push(metricNode("acc", `${fmt(snapshot.accuracy)}%`));
  }
  if (settings.liveBurst && snapshot) parts.push(metricNode("burst", fmt(snapshot.burst)));

  const bar = el("div", "tt-progress");
  if (settings.timerStyle === "bar" || settings.timerStyle === "mini") {
    const fill = el("span", "tt-progress-fill");
    fill.style.width = `${(run.progress() * 100).toFixed(1)}%`;
    bar.append(fill);
  }

  meter.replaceChildren(...parts, bar);
  meter.classList.toggle("tt-meter-quiet", !parts.length);
}

function metricNode(label, value) {
  const node = el("span", "tt-metric");
  node.append(el("strong", null, value));
  if (label) node.append(el("span", "tt-metric-label", label));
  return node;
}

/* ---- the result ---- */

function finishTest() {
  stopTicker();
  if (!run) return;
  const result = run.result();
  const key = testKey(settings);
  const label = describeTest(settings);

  const typedBankWords = wordsActuallyTyped();
  const outcome = recordResult(records, { key, label, result, bankWords: typedBankWords });
  records = outcome.records;
  writeStore(RECORDS_KEY, records);

  renderResult(result, outcome, typedBankWords);
  $("tt-stage").hidden = true;
  $("tt-result").hidden = false;
  refreshAiQueue(); // the next passage should already be on its way
  focusInput();
}

/**
 * Which bank words the typist actually got through.
 *
 * Not the same as the passage's bank words: a timed test that stopped halfway
 * only met the ones before the caret, and crediting the rest would make the
 * "words met at speed" total a measure of what you were shown.
 */
function wordsActuallyTyped() {
  if (!run || !current?.bankWords?.length) return [];
  const reached = run.words.slice(0, run.index).join(" ");
  const matcher = createBankMatcher(current.bankWords);
  return [...matcher.match(reached)];
}

function renderResult(result, outcome, typedBankWords) {
  const view = $("tt-result");
  view.replaceChildren();

  const failed = result.status === "failed";
  const head = el("div", "tt-result-head");
  head.append(
    bigMetric("wpm", fmt(result.wpm, settings.showDecimals ? 2 : 0)),
    bigMetric("accuracy", `${fmt(result.accuracy, settings.showDecimals ? 2 : 0)}%`)
  );
  view.append(head);

  if (failed) {
    view.append(el("p", "tt-failed", `test failed — ${result.failure}`));
  } else if (outcome.best) {
    const previous = outcome.previous ? ` — past ${fmt(outcome.previous.wpm)} wpm` : "";
    view.append(el("p", "tt-best", `a personal best for ${describeTest(settings)}${previous}`));
  }

  const rows = el("dl", "tt-facts");
  const fact = (term, detail) => {
    const wrap = el("div");
    wrap.append(el("dt", null, term), el("dd", null, detail));
    rows.append(wrap);
  };
  fact("raw", fmt(result.raw));
  fact("consistency", `${fmt(result.consistency)}%`);
  fact(
    "characters",
    `${result.chars.correct}/${result.chars.incorrect}/${result.chars.extra}/${result.chars.missed}`
  );
  fact("time", `${fmt(result.seconds, 1)}s`);
  fact("test", describeTest(settings));
  const summary = summarize(records, testKey(settings));
  if (summary.tests > 1) {
    fact("last 10", `${fmt(summary.averageWpm)} wpm · ${fmt(summary.averageAccuracy)}%`);
  }
  const best = records.bests[testKey(settings)];
  if (best) fact("best", `${fmt(best.wpm)} wpm`);
  view.append(rows);

  if (result.timeline.length > 1) view.append(chart(result.timeline));

  if (typedBankWords.length) {
    const totals = bankWordTotals(records);
    const line = el("p", "tt-result-bank");
    line.append(el("span", "tt-result-bank-label", "your words in this passage: "));
    typedBankWords.forEach((word, i) => {
      if (i) line.append(el("span", null, ", "));
      const count = totals.get(word) ?? 1;
      const item = el("span", "tt-bank-chip", word);
      item.title = `typed in ${count} ${count === 1 ? "test" : "tests"}`;
      line.append(item);
    });
    view.append(line);
  }

  const credit = creditNodes(current);
  if (credit.length) {
    const source = el("p", "tt-source");
    source.replaceChildren(...credit);
    view.append(source);
  }

  const actions = el("div", "tt-actions");
  actions.append(
    actionButton("next test", () => {
      repeatOf = null;
      nextTest();
    }, true),
    actionButton("repeat this one", () => repeatTest())
  );
  view.append(actions, hintLine());
}

function bigMetric(label, value) {
  const node = el("div", "tt-big");
  node.append(el("strong", "tt-big-value", value), el("span", "tt-big-label", label));
  return node;
}

function actionButton(label, onClick, primary = false) {
  const button = el("button", primary ? "button-primary" : "link-quiet", label);
  button.type = "button";
  button.addEventListener("click", () => {
    onClick();
    focusInput();
  });
  return button;
}

/**
 * Speed over the run, second by second.
 *
 * Drawn as an inline SVG rather than with a chart library: it is two paths and
 * a handful of dots, and lexis ships no bundler to hide a dependency behind.
 */
function chart(timeline) {
  const width = 640;
  const height = 120;
  const pad = 6;
  const max = Math.max(40, ...timeline.map((s) => s.raw));
  const x = (i) => pad + (i / Math.max(1, timeline.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - (value / max) * (height - pad * 2);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "tt-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Speed per second, peaking at ${Math.round(max)} words per minute over ${timeline.length} seconds`
  );

  const line = document.createElementNS(svg.namespaceURI, "path");
  line.setAttribute("class", "tt-chart-line");
  line.setAttribute(
    "d",
    timeline.map((sample, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(sample.raw).toFixed(1)}`).join(" ")
  );
  svg.append(line);

  timeline.forEach((sample, i) => {
    if (!sample.errors) return;
    const dot = document.createElementNS(svg.namespaceURI, "circle");
    dot.setAttribute("class", "tt-chart-error");
    dot.setAttribute("cx", x(i).toFixed(1));
    dot.setAttribute("cy", y(sample.raw).toFixed(1));
    dot.setAttribute("r", "3.5");
    svg.append(dot);
  });

  const wrap = el("div", "tt-chart-wrap");
  wrap.append(svg);
  return wrap;
}

/* ---- the bar above the test ---- */

function renderBar() {
  const bar = $("tt-bar");
  if (!bar) return;
  bar.replaceChildren();

  bar.append(
    chipGroup("mode", optionValues("mode"), settings.mode, (value) => {
      update({ mode: value });
    })
  );

  if (settings.mode === "time") {
    bar.append(chipGroup("seconds", TIME_PRESETS, settings.time, (value) => update({ time: value })));
  }
  if (settings.mode === "words") {
    bar.append(
      chipGroup("words", WORD_PRESETS, settings.wordCount, (value) => update({ wordCount: value }))
    );
  }
  if (settings.mode === "words" || settings.mode === "time") {
    bar.append(
      chipGroup("from", optionValues("wordSource"), settings.wordSource, (value) =>
        update({ wordSource: value })
      ),
      toggleChip("punctuation", settings.punctuation, () => update({ punctuation: !settings.punctuation })),
      toggleChip("numbers", settings.numbers, () => update({ numbers: !settings.numbers }))
    );
  }
  if (settings.mode === "quote") {
    bar.append(
      multiChipGroup("length", QUOTE_LENGTHS, settings.quoteLengths, (values) =>
        update({ quoteLengths: values })
      ),
      multiChipGroup("from", options("quoteKinds"), settings.quoteKinds, (values) =>
        update({ quoteKinds: values })
      ),
      chipGroup("by", optionValues("quoteSource"), settings.quoteSource, (value) =>
        update({ quoteSource: value })
      ),
      chipGroup("only", optionValues("bankFilter"), settings.bankFilter, (value) =>
        update({ bankFilter: value })
      )
    );
  }

  const tools = el("div", "tt-bar-tools");
  const settingsButton = el("button", "tt-chip tt-chip-wide", "all settings");
  settingsButton.type = "button";
  settingsButton.addEventListener("click", () => {
    const panel = $("tt-settings");
    panel.hidden = !panel.hidden;
    settingsButton.classList.toggle("tt-chip-on", !panel.hidden);
    if (!panel.hidden) renderSettingsPanel();
    else focusInput();
  });
  tools.append(settingsButton);
  bar.append(tools);

  renderStatusLine();
}

/** The one line under the bar that says what the test will be made of. */
function renderStatusLine() {
  const notes = [];
  if (settings.mode === "quote") {
    if (settings.bankFilter !== "off") {
      const words = filterWords();
      if (!words.length) {
        notes.push(
          settings.bankFilter === "bank"
            ? "Your bank is empty, so this filter has nothing to match — add a word first."
            : `Nothing on your ${settings.bankFilter === "today" ? "list for today" : "review queue"} yet.`
        );
      } else if (matchCount === 0) {
        notes.push(
          `No library passage uses ${words.length === 1 ? "that word" : "those words"} at this length. Widen the length, or let AI write them.`
        );
      } else if (matchCount != null && matchCount < 25) {
        notes.push(
          `${matchCount} library ${matchCount === 1 ? "passage uses" : "passages use"} your words — AI can write more.`
        );
      } else if (matchCount != null) {
        notes.push(`${matchCount} passages use your words.`);
      }
    } else if (matchCount != null) {
      notes.push(`${matchCount} passages.`);
    }

    if (wantsAi()) {
      if (!context?.aiReady?.()) {
        notes.push("AI passages need an OpenRouter key in settings → ai assist.");
      } else if (aiState.error) {
        notes.push(`AI passages paused — ${String(aiState.error.message ?? aiState.error)}`);
      } else if (aiState.ready > 0) {
        notes.push(`${aiState.ready} AI ${aiState.ready === 1 ? "passage" : "passages"} ready.`);
      } else if (aiState.filling) {
        notes.push("writing the first AI passages…");
      }
    }
  }
  if (settings.mode !== "quote" && settings.wordSource !== "common" && !allBankWords().length) {
    notes.push("Your bank is empty, so common words are used instead.");
  }

  showNotice(notes.join(" "), Boolean(aiState.error) || matchCount === 0);
}

function showNotice(text, isError = false) {
  const notice = $("tt-notice");
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = !text;
  notice.classList.toggle("tt-notice-warn", Boolean(isError));
}

function hideNotice() {
  renderStatusLine();
}

/** Options may be bare values or {value, label} — the label is what reads. */
function asOption(entry) {
  return entry && typeof entry === "object" ? entry : { value: entry, label: String(entry) };
}

function chipGroup(label, values, selected, onPick) {
  const group = el("div", "tt-chips");
  if (label) group.append(el("span", "tt-chips-label", label));
  for (const entry of values) {
    const { value, label: text } = asOption(entry);
    const chip = el("button", "tt-chip", text);
    chip.type = "button";
    chip.classList.toggle("tt-chip-on", value === selected);
    chip.setAttribute("aria-pressed", String(value === selected));
    chip.addEventListener("click", () => onPick(value));
    group.append(chip);
  }
  return group;
}

function toggleChip(label, on, onToggle) {
  const group = el("div", "tt-chips");
  const chip = el("button", "tt-chip", label);
  chip.type = "button";
  chip.classList.toggle("tt-chip-on", on);
  chip.setAttribute("aria-pressed", String(on));
  chip.addEventListener("click", onToggle);
  group.append(chip);
  return group;
}

/**
 * Lengths are a set, not a choice: "short or medium" is a perfectly ordinary
 * thing to want, and it is also how the corpus filter is shaped.
 */
function multiChipGroup(label, values, selected, onPick) {
  const group = el("div", "tt-chips");
  group.append(el("span", "tt-chips-label", label));
  for (const entry of values) {
    const { value, label: text } = asOption(entry);
    const on = selected.includes(value);
    const chip = el("button", "tt-chip", text);
    chip.type = "button";
    chip.classList.toggle("tt-chip-on", on);
    chip.setAttribute("aria-pressed", String(on));
    chip.addEventListener("click", () => {
      const next = on ? selected.filter((entry) => entry !== value) : [...selected, value];
      // Turning the last one off would leave nothing to draw from; read it as
      // "only this one" instead of as an error message.
      onPick(next.length ? next : [value]);
    });
    group.append(chip);
  }
  return group;
}

/* ---- the full settings panel ---- */

function renderSettingsPanel() {
  const panel = $("tt-settings");
  if (!panel || panel.hidden) return;
  panel.replaceChildren();

  for (const section of SETTINGS_SCHEMA) {
    const items = section.items.filter((item) => settingApplies(item, settings));
    if (!items.length) continue;

    const block = el("section", "tt-settings-block");
    block.append(el("h3", "tt-settings-title", section.title));
    if (section.blurb) block.append(el("p", "tt-settings-blurb", section.blurb));

    for (const item of items) block.append(settingRow(item));
    panel.append(block);
  }

  const actions = el("div", "tt-actions");
  actions.append(
    actionButton("done", () => {
      panel.hidden = true;
      renderBar();
    }, true),
    actionButton("reset to defaults", () => {
      settings = { ...DEFAULT_TYPING_SETTINGS };
      writeStore(SETTINGS_KEY, settings);
      applyAppearance();
      rebuildPool();
      refreshAiQueue();
      renderSettingsPanel();
      renderBar();
      nextTest();
    })
  );
  panel.append(actions);
}

function settingRow(item) {
  const row = el("div", "tt-setting");
  const label = el("div", "tt-setting-label");
  label.append(el("span", null, item.label));
  if (item.help) label.append(el("small", null, item.help));
  row.append(label);

  const control = el("div", "tt-setting-control");
  const value = settings[item.key];

  if (item.kind === "toggle") {
    const chip = el("button", "tt-chip", value ? "on" : "off");
    chip.type = "button";
    chip.classList.toggle("tt-chip-on", value);
    chip.setAttribute("aria-pressed", String(value));
    chip.addEventListener("click", () => {
      update({ [item.key]: !settings[item.key] }, { keepPanel: true });
    });
    control.append(chip);
  } else if (item.kind === "choice") {
    for (const option of item.options) {
      const chip = el("button", "tt-chip", option.label);
      chip.type = "button";
      chip.classList.toggle("tt-chip-on", option.value === value);
      chip.setAttribute("aria-pressed", String(option.value === value));
      chip.addEventListener("click", () => update({ [item.key]: option.value }, { keepPanel: true }));
      control.append(chip);
    }
  } else if (item.kind === "set") {
    for (const option of item.options) {
      const on = value.includes(option.value);
      const chip = el("button", "tt-chip", option.label);
      chip.type = "button";
      chip.classList.toggle("tt-chip-on", on);
      chip.setAttribute("aria-pressed", String(on));
      chip.addEventListener("click", () => {
        const next = on ? value.filter((entry) => entry !== option.value) : [...value, option.value];
        update({ [item.key]: next.length ? next : [option.value] }, { keepPanel: true });
      });
      control.append(chip);
    }
  } else {
    const input = el("input");
    input.type = "number";
    input.className = "tt-number";
    input.min = String(item.min);
    input.max = String(item.max);
    input.step = String(item.step);
    input.value = String(value);
    input.setAttribute("aria-label", item.label);
    input.addEventListener("change", () => {
      update({ [item.key]: input.value }, { keepPanel: true });
    });
    control.append(input);
  }

  row.append(control);
  return row;
}

/* ---- applying a change ---- */

/**
 * One place where a setting takes effect.
 *
 * Which of the four things has to happen — repaint, refilter, re-queue, or
 * start a different test — depends on what changed, and getting that wrong is
 * how a settings panel ends up either ignoring you or restarting your test
 * because you nudged the font size.
 */
function update(patch, { keepPanel = false } = {}) {
  const before = settings;
  settings = normalizeTypingSettings({ ...settings, ...patch });
  writeStore(SETTINGS_KEY, settings);

  const changed = (key) => JSON.stringify(before[key]) !== JSON.stringify(settings[key]);

  applyAppearance();

  const poolChanged =
    changed("quoteLengths") || changed("quoteKinds") || changed("bankFilter") || changed("minBankWords");
  if (poolChanged) rebuildPool();
  if (poolChanged || changed("quoteSource") || changed("mode")) refreshAiQueue();

  const needsNewTest =
    changed("mode") ||
    changed("time") ||
    changed("wordCount") ||
    changed("wordSource") ||
    changed("punctuation") ||
    changed("numbers") ||
    changed("quoteSource") ||
    poolChanged ||
    changed("difficulty") ||
    changed("stopOnError") ||
    changed("confidenceMode") ||
    changed("freedomMode") ||
    changed("strictSpace") ||
    changed("quickEnd") ||
    changed("hideExtraLetters") ||
    changed("lazyMode") ||
    changed("minWpm") ||
    changed("minAccuracy") ||
    changed("minBurst");

  if (keepPanel) renderSettingsPanel();
  renderBar();

  if (needsNewTest) {
    repeatOf = null;
    ensureWords().then(() => nextTest());
  } else {
    // Appearance only: repaint what is already on screen, keep the run.
    if (run) {
      renderPassage();
      requestAnimationFrame(moveCaret);
    }
    renderMeter();
  }
  if (!keepPanel) focusInput();
}

/** Everything that is a CSS variable or a class, rather than a rerun. */
function applyAppearance() {
  const view = $("view-typing");
  if (!view) return;
  view.style.setProperty("--tt-font-size", `${settings.fontSize}rem`);
  view.style.setProperty(
    "--tt-line-width",
    settings.maxLineWidth > 0 ? `${settings.maxLineWidth}ch` : "100%"
  );
  view.style.setProperty(
    "--tt-caret-speed",
    { off: "0ms", slow: "220ms", medium: "120ms", fast: "60ms" }[settings.smoothCaret] ?? "120ms"
  );
  view.style.setProperty("--tt-scroll-speed", settings.smoothLineScroll ? "180ms" : "0ms");
  view.dataset.caret = settings.caretStyle;
  view.dataset.highlight = settings.highlightMode;
  view.dataset.tape = settings.tapeMode;
  view.classList.toggle("tt-blind", settings.blindMode);
}

/* ---- when the pool is empty ---- */

function renderEmptyPool() {
  const words = $("tt-words");
  words.replaceChildren();
  $("tt-caret").hidden = true;
  $("tt-source").hidden = true;
  const foot = $("tt-foot");
  foot.replaceChildren(el("p", "empty", emptyPoolReason()), hintLine());
}

/**
 * Why there is nothing to type — which is four different problems wearing the
 * same blank screen, and only one of them is the typist's to fix.
 */
function emptyPoolReason() {
  if (corpusError) {
    return "The quote library didn’t load. Check the connection and reopen this view.";
  }
  if (settings.quoteSource === "ai") {
    if (!context?.aiReady?.()) {
      return "AI passages need an OpenRouter key — add one in settings → ai assist, or set quotes back to the library.";
    }
    if (aiState.error) {
      return `The model couldn’t write one: ${String(aiState.error.message ?? aiState.error)}`;
    }
    return "Writing the first passages… this only happens once; after this there is always one waiting.";
  }
  if (settings.bankFilter !== "off" && !filterWords().length) {
    return "That filter has no words to match yet — add words to your bank, or set “only” back to any quote.";
  }
  if (settings.quoteKinds.length < optionValues("quoteKinds").length) {
    return "Nothing matches. Try more shelves, another length, or turn the “only my words” filter off.";
  }
  return "No passage matches these filters. Widen the length, or turn the “only my words” filter off.";
}

function hintLine() {
  const hint = el("p", "tt-hint");
  const key = { tab: "tab", esc: "esc", enter: "enter", off: null }[settings.quickRestart];
  const bits = [];
  if (settings.mode === "zen") {
    bits.push(settings.quickRestart === "enter" ? "shift+enter to finish" : "enter to finish");
  }
  if (key) bits.push(`${key} to restart`, `shift+${key} for a new one`);
  if (settings.quickRestart !== "esc") bits.push("esc to leave the keyboard");
  bits.push("just start typing");
  hint.textContent = bits.join(" · ");
  return hint;
}

/* ---- sound ---- */

let audio = null;

/**
 * A click, synthesised.
 *
 * No audio files: lexis ships no assets it does not need, and a typing click
 * is a very short burst of filtered noise, which an oscillator and a gain ramp
 * do perfectly well. Created on the first keystroke, because a browser will
 * not let a page make noise before it has been touched.
 */
function playSound() {
  if (!settings.soundOnClick && !settings.soundOnError) return;
  if (!run) return;
  const input = run.typed[run.index] ?? "";
  const expected = run.words[run.index] ?? "";
  // The character just typed, judged on its own: the word may still be wrong
  // from three letters ago, and thudding at every key after one typo is how a
  // sound setting gets turned off within a minute.
  const at = input.length - 1;
  const wrong = at >= 0 && input[at] !== expected[at];
  if (wrong && !settings.soundOnError) return;
  if (!wrong && !settings.soundOnClick) return;

  try {
    audio ??= new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = wrong ? "sawtooth" : "triangle";
    osc.frequency.setValueAtTime(wrong ? 110 : 660, now);
    const peak = (settings.soundVolume / 100) * (wrong ? 0.16 : 0.06);
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (wrong ? 0.12 : 0.04));
    osc.connect(gain).connect(audio.destination);
    osc.start(now);
    osc.stop(now + (wrong ? 0.13 : 0.05));
  } catch {
    /* no audio here; the test is unaffected */
  }
}
