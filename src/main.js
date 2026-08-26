/**
 * The interface. Platform-agnostic: it talks to the shared core through the
 * app service, and to the host (desktop or browser) through a small adapter.
 */

import { createApp } from "./core/app.js";
import { fetchDefinition } from "./core/dict.js";
import { createSyncController } from "./core/sync-controller.js";
import { isDesktop, createDesktopPlatform } from "./platform/desktop.js";
import { createWebPlatform } from "./platform/web.js";
import { hasVault, unlockVault, createVault, clearVault, updateVault } from "./core/vault.js";
import { cryptoAvailable } from "./core/crypto.js";
import { createMirror, newDeviceId, peerFileName } from "./core/mirror.js";
import {
  foldConflicts,
  loadConflictLog,
  saveConflictLog,
  clearConflictLog,
} from "./core/conflict.js";
import { installStatsView, renderStatsView } from "./stats-view.js";
import {
  aiEssayReview,
  aiExampleSentences,
  aiNuance,
  aiSessionUsage,
  aiSimilarWords,
  fetchKeyInfo,
  fetchModels,
  normalizeModel,
} from "./core/ai.js";
import {
  clearAiSettings,
  loadAiSettings,
  saveAiSettings,
} from "./core/ai-settings.js";

/* ---- tiny DOM helper: everything is textContent, never innerHTML ---- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const $ = (id) => document.getElementById(id);

function isEditingTarget(target = document.activeElement) {
  return Boolean(
    target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)
  );
}

let platform = null;
let app = null;
let sync = null;
// Held for as long as the app is unlocked: the mirror is sealed with it, and
// so is the conflict log. Never persisted anywhere in this form.
let sessionKey = null;

/**
 * Runs a bank mutation, surfacing failures instead of swallowing them.
 *
 * Every one of these writes to storage, and a write can fail — a full disk, a
 * revoked permission, a locked web platform. Without this the promise rejects
 * into nothing and the interface simply stops responding, which is the worst
 * possible way to tell someone their work isn't being saved.
 */
async function mutate(action) {
  try {
    await action();
  } catch (err) {
    console.error(err);
    applySyncStatus({
      text: `couldn’t save — ${String(err.message ?? err)}`,
      kind: "error",
      enabled: true,
    });
  }
}

/* ---- navigation ---- */

installStatsView();

const railLinks = document.querySelectorAll(".rail-link[data-view]");
railLinks.forEach((btn, i) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
  btn.title = `shortcut: ${i + 1}`;
  btn.setAttribute("aria-keyshortcuts", String(i + 1));
});

const aboutDialog = $("about-dialog");
$("rail-about").addEventListener("click", () => aboutDialog.showModal());

function switchView(name) {
  // The gate overlays the rail but doesn't inert it, so a keyboard user can
  // still reach these buttons before the app exists.
  if (!app) return;
  railLinks.forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${name}`);
  });
  if (name === "bank") renderBank();
  if (name === "today") renderToday();
  if (name === "review") startReview();
  if (name === "stats") renderStatsView(app.getBank());
  if (name === "essay") updateEssayCount();
  if (name === "sync") renderSync();
  if (name === "settings") {
    renderSettings();
    // Only a deliberate visit opens the AI panel. renderSettings() is also
    // called when a background sync lands, and repainting the panel there
    // would wipe a key the student was halfway through typing.
    openAiPanel();
  }
}

// 1–7 jump straight to a view, top to bottom, matching the rail. Bare digits
// rather than modifier chords — browsers keep ⌘/Ctrl+digit for their own
// tabs, and bare Space already works this way during review.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (aboutDialog.open) return;
  if (isEditingTarget()) return;
  if (!$("lookup").hidden) return;
  const digit = /^Digit([1-7])$/.exec(e.code);
  if (!digit) return;
  switchView(railLinks[Number(digit[1]) - 1].dataset.view);
});

async function refreshCounts() {
  try {
    const words = app.listWords();
    const due = app.dueWords();
    const today = await app.todayList();
    $("count-bank").textContent = words.length || "";
    $("count-review").textContent = due.length || "";
    $("count-today").textContent = today.remaining || "";
  } catch {
    /* counts are decorative */
  }
}

/* ---- bank ---- */

function senseNode(sense, index) {
  const p = el("p", "sense");
  p.append(
    el("span", "sense-num", `${index + 1}`),
    el("span", "sense-pos", sense.pos),
    document.createTextNode(sense.def)
  );
  if (sense.example) {
    p.append(el("span", "sense-example", `“${sense.example}”`));
  }
  return p;
}

function dueLabel(word) {
  const due = new Date(`${word.srs.due}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = Math.round((due - now) / 86400000);
  if (days <= 0) return { text: "due now", urgent: true };
  if (days === 1) return { text: "due tomorrow", urgent: false };
  return { text: `due in ${days}d`, urgent: false };
}

const expandedWords = new Set();

function entryNode(word) {
  const wrap = el("article", "entry");
  const head = el("button", "entry-head");
  head.append(el("span", "headword", word.word));
  if (word.phonetic) head.append(el("span", "phonetic", word.phonetic));
  const firstPos = word.senses[0]?.pos;
  if (firstPos) head.append(el("span", "entry-pos", firstPos));
  const due = dueLabel(word);
  head.append(el("span", `entry-due${due.urgent ? " due-now" : ""}`, due.text));
  wrap.append(head);

  const body = el("div", "entry-body");
  body.hidden = !expandedWords.has(word.word);
  word.senses.forEach((s, i) => body.append(senseNode(s, i)));

  if (word.synonyms.length) {
    const syn = el("p", "synonyms");
    syn.append(el("span", "syn-label", "for essays"));
    syn.append(document.createTextNode(word.synonyms.map((s) => s.word).join(" · ")));
    syn.append(el("span", "syn-note", "suggestions only — not saved to your bank"));
    body.append(syn);
  }

  const meta = el("div", "entry-meta");
  meta.append(
    el(
      "span",
      null,
      `${word.source} · practised ${word.times_used}× · essay uses ${word.essay_uses ?? 0}×`
    )
  );
  const src = el("button", "link-quiet", "view definition");
  src.addEventListener("click", () => platform.openUrl(word.source_url));
  const clarification = word.clarification_url
    ? el("button", "link-quiet", "view clarification")
    : null;
  clarification?.addEventListener("click", () => platform.openUrl(word.clarification_url));
  const del = el("button", "link-quiet", "remove");
  del.addEventListener("click", () =>
    mutate(async () => {
      await app.deleteWord(word.word);
      expandedWords.delete(word.word);
      renderBank();
      refreshCounts();
    })
  );
  meta.append(src);
  if (clarification) meta.append(clarification);
  meta.append(del);
  body.append(meta);

  // Built the first time the entry is opened, not once per row: a bank of
  // several hundred words would otherwise carry thousands of nodes for
  // drawers nobody has looked at.
  let toolsBuilt = false;
  const ensureWordTools = () => {
    if (toolsBuilt) return;
    toolsBuilt = true;
    attachWordTools(word.word, meta);
  };
  if (!body.hidden) ensureWordTools();
  wrap.append(body);

  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    if (body.hidden) {
      expandedWords.delete(word.word);
    } else {
      expandedWords.add(word.word);
      ensureWordTools();
    }
  });
  return wrap;
}

const bankSort = $("bank-sort");

bankSort.addEventListener("change", () => renderBank());

async function renderBank() {
  const words = app.listWords(bankSort.value);
  const liveWords = new Set(words.map((word) => word.word));
  for (const word of expandedWords) {
    if (!liveWords.has(word)) expandedWords.delete(word);
  }
  // A removed word's drawer state is meaningless, so it goes with the word.
  // The cached answers behind it stay: re-adding the word should not have to
  // pay for them a second time.
  for (const key of aiOpenDrawers) {
    const word = key.slice(0, key.indexOf("\u0000"));
    if (!liveWords.has(word)) aiOpenDrawers.delete(key);
  }
  const list = $("word-list");
  list.replaceChildren();
  words.forEach((w) => list.append(entryNode(w)));
  $("bank-empty").hidden = words.length > 0;
  $("bank-tools").hidden = words.length < 2;

  const guide = $("guide-words");
  if (words.length >= 2) {
    const alpha = app.listWords("word-asc").map((w) => w.word);
    guide.textContent = `${alpha[0]} — ${alpha[alpha.length - 1]}`;
    guide.hidden = false;
  } else {
    guide.hidden = true;
  }
  refreshCounts();
}

const addForm = $("add-form");
const addInput = $("add-input");
const addStatus = $("add-status");

addInput.addEventListener("input", () => {
  addStatus.hidden = true;
  addStatus.classList.remove("error");
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = addInput.value.trim();
  if (!word) return;
  addInput.disabled = true;
  addStatus.hidden = false;
  addStatus.classList.remove("error");
  addStatus.textContent = `finding “${word.toLowerCase()}”…`;
  try {
    const result = await app.addWord(word);
    const addedEntries = result.batch ?? [result];
    for (const entry of addedEntries) expandedWords.add(entry.word);
    addInput.value = "";
    await renderBank();
    addStatus.textContent = `added “${addedEntries.map((entry) => entry.word).join(" · ")}”`;
    addStatus.hidden = false;
  } catch (err) {
    addStatus.textContent = String(err.message ?? err);
    addStatus.classList.add("error");
  } finally {
    addInput.disabled = false;
    addInput.focus();
  }
});

/* ---- today ---- */

let todayRenderRequest = 0;

async function renderToday() {
  const request = ++todayRenderRequest;
  const view = await app.todayList();
  if (request !== todayRenderRequest) return;
  drawToday(view);

  // Stored entries are useful even when the lexical APIs are slow or offline.
  // Paint them first, then replace only this still-current render if an older
  // opaque definition can be clarified in the background. This second call can
  // persist an upgrade, so route failures through the normal save-error UI.
  await mutate(async () => {
    const clarified = await app.todayList({ clarifyDefinitions: true });
    if (request === todayRenderRequest) drawToday(clarified);
  });
}

function drawToday(view) {
  const date = new Date(`${view.date}T00:00:00`);
  $("today-date").textContent = date
    .toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })
    .toLowerCase();

  const list = $("today-list");
  list.replaceChildren();
  $("today-empty").hidden = view.items.length > 0;

  const refresh = $("today-refresh");
  refresh.disabled = !view.can_refresh;
  refresh.title = view.can_refresh
    ? `replace this list with another ${view.target}-word selection`
    : "no alternative selection is available";

  const moreWrap = $("today-more-wrap");
  const more = $("today-more");
  moreWrap.hidden = !view.can_expand;
  more.disabled = !view.can_expand;
  more.textContent = `another ${view.next_batch_size} word${view.next_batch_size === 1 ? "" : "s"}`;

  if (view.items.length) {
    $("today-lede").textContent =
      view.remaining === 0
        ? view.can_expand
          ? `All ${view.completed_today} used today. You can take another ${view.next_batch_size} word${view.next_batch_size === 1 ? "" : "s"} when you’re ready.`
          : "All used. Your writing did the remembering today."
        : `Work these into today’s writing — ${view.remaining} of ${view.items.length} to go. Ticking one schedules its next return.`;
  } else {
    $("today-lede").textContent = "";
  }

  view.items.forEach((item) => {
    const row = el("div", `today-item${item.ticked ? " ticked" : ""}`);
    const tick = el("button", "tick");
    tick.setAttribute("aria-label", `mark ${item.word} as used`);
    tick.setAttribute("aria-pressed", String(item.ticked));
    tick.addEventListener("click", () =>
      mutate(async () => {
        await app.tickWord(item.word, !item.ticked);
        renderToday();
        refreshCounts();
      })
    );
    row.append(tick, el("span", "today-word", item.word), el("span", "today-def", item.def));
    list.append(row);
  });
}

$("today-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  await mutate(async () => {
    await app.refreshTodayList();
    await renderToday();
    await refreshCounts();
  });
  // A failed save leaves the button in place; let the user retry. A successful
  // render decides whether another rotation is possible.
  if (button.isConnected && button.title.startsWith("replace")) button.disabled = false;
});

$("today-more").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  await mutate(async () => {
    await app.expandTodayList();
    await renderToday();
    await refreshCounts();
  });
  // On failure the existing completed batch is still visible and expandable.
  if (button.isConnected && !$("today-more-wrap").hidden) button.disabled = false;
});

/* ---- review ---- */

let queue = [];
let reviewed = 0;

function startReview() {
  queue = app.dueWords();
  reviewed = 0;
  renderCard();
}

function renderCard() {
  const area = $("review-area");
  area.replaceChildren();
  const stage = el("div", "review-stage");
  area.append(stage);

  if (!queue.length) {
    stage.append(
      el("p", "card-word", reviewed ? "done." : "nothing due."),
      el(
        "p",
        "reveal-hint",
        reviewed
          ? `${reviewed} word${reviewed === 1 ? "" : "s"} reviewed. Come back tomorrow.`
          : "Reviews return here as their intervals come up."
      )
    );
    refreshCounts();
    return;
  }

  const word = queue[0];
  stage.append(el("p", "review-progress", `${reviewed + 1} of ${reviewed + queue.length}`));
  stage.append(el("p", "card-word", word.word));
  if (word.phonetic) stage.append(el("p", "card-phonetic", word.phonetic));

  const hint = el("p", "reveal-hint", "click or press space to reveal");
  stage.append(hint);

  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    hint.remove();
    const back = el("div", "card-back");
    word.senses.forEach((s, i) => back.append(senseNode(s, i)));
    if (word.synonyms.length) {
      const syn = el("p", "synonyms");
      syn.append(el("span", "syn-label", "for essays"));
      syn.append(document.createTextNode(word.synonyms.map((s) => s.word).join(" · ")));
      back.append(syn);
    }
    const grades = el("div", "grade-row");
    [
      ["again", "grade grade-again"],
      ["hard", "grade"],
      ["good", "grade"],
      ["easy", "grade"],
    ].forEach(([g, cls]) => {
      const btn = el("button", cls, g);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        mutate(async () => {
          await app.gradeWord(word.word, g);
          queue.shift();
          if (g === "again") queue.push(word); // Anki-style: lapses return this session
          reviewed += 1;
          renderCard();
        });
      });
      grades.append(btn);
    });
    back.append(grades);
    stage.append(back);
  };

  stage.addEventListener("click", reveal);
  stage.tabIndex = -1;
  currentReveal = reveal;
}

let currentReveal = null;
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  if (aboutDialog.open) return;
  const reviewActive = $("view-review").classList.contains("active");
  const typing = isEditingTarget();
  if (reviewActive && currentReveal && !typing && $("lookup").hidden) {
    e.preventDefault();
    currentReveal();
  }
});

/* ---- essay ---- */

const essayText = $("essay-text");
const essayCount = $("essay-count");

// The draft survives restarts (including update relaunches).
//
// On the desktop it persists; in the browser it lives in sessionStorage
// instead, so an unfinished essay isn't left in plaintext on a shared or
// borrowed computer after the tab closes. Everything else the web build
// stores is encrypted, and the draft shouldn't be the exception.
const DRAFT_KEY = "lexis-essay-draft";

function draftStore() {
  return platform?.kind === "web" ? sessionStorage : localStorage;
}

function saveEssayDraft() {
  try {
    draftStore().setItem(DRAFT_KEY, essayText.value);
  } catch {
    /* storage full or unavailable — the draft simply isn't kept */
  }
}

function loadEssayDraft() {
  try {
    return draftStore().getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function updateEssayCount() {
  const n = essayText.value.split(/\s+/).filter(Boolean).length;
  essayCount.textContent = n ? `${n} words` : "";
}

function clearEssayReport() {
  $("essay-report").replaceChildren();
  // The AI review reads the same draft, so it is equally stale the moment the
  // draft moves — and so is any review still in flight. Bumping the sequence
  // here is what actually discards that one: without it, feedback on the text
  // the student has since rewritten would land in this freshly emptied panel.
  aiSeq++;
  $("ai-review-output").replaceChildren();
}

essayText.addEventListener("input", () => {
  updateEssayCount();
  saveEssayDraft();
  clearEssayReport();
});

$("essay-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  essayText.value = await file.text();
  updateEssayCount();
  saveEssayDraft();
  clearEssayReport();
});

$("essay-check").addEventListener("click", async () => {
  const text = essayText.value;
  const report = app.analyzeEssay(text);
  const out = $("essay-report");
  out.replaceChildren();

  if (!text.trim()) {
    out.append(el("p", "empty", "Nothing to check yet — paste your essay above."));
    return;
  }

  const summary = el("p", "report-summary");
  if (report.used.length === 0) {
    summary.textContent = `${report.essay_words} words read. None of your ${report.bank_size} bank words appear yet — the checklist in “today” is a good place to start.`;
  } else {
    summary.textContent = `${report.essay_words} words read. You used ${report.used.length} of your ${report.bank_size} bank words.`;
  }
  out.append(summary);

  if (report.used.length) {
    const section = el("div", "report-section");
    report.used.forEach((u) => {
      const row = el("div", "report-word");
      const head = el("div", "report-word-head");
      head.append(el("span", "headword", u.word));
      head.append(el("span", "report-count", `${u.count}×`));
      if (u.in_today) head.append(el("span", "flag", "on today’s list"));
      if (u.overused) head.append(el("span", "flag", "overused"));
      row.append(head);
      u.sentences.forEach((s) => row.append(el("p", "report-sentence", s)));
      section.append(row);
    });
    out.append(section);
  }

  if (report.notes.length) {
    const notes = el("ul", "note-list");
    report.notes.forEach((n) => notes.append(el("li", null, n)));
    out.append(notes);
  }

  if (report.unused_today.length) {
    out.append(
      el(
        "p",
        "report-summary",
        `Still unused from today’s list: ${report.unused_today.join(", ")}.`
      )
    );
  }

  const usedToday = report.used.filter((u) => u.in_today);
  if (report.used.length) {
    const label = usedToday.length
      ? "log essay uses & mark today’s words"
      : "log essay uses";
    const log = el("button", "button-primary", label);
    log.addEventListener("click", async () => {
      log.disabled = true;
      await mutate(async () => {
        const result = await app.logEssay(text);
        const confirmation = result.practised_today
          ? "Logged every match. Today’s matching words were also marked as practised."
          : "Logged every match to each word’s essay-use total.";
        log.replaceWith(el("p", "report-summary", confirmation));
        await refreshCounts();
      });
      // Re-enable only when the mutation failed and the original button is
      // still present. A successful log replaces it, preventing double-clicks.
      if (log.isConnected) log.disabled = false;
    });
    out.append(log);
  }
});

/* ---- AI essay review ---- */

$("essay-ai-review").addEventListener("click", async () => {
  const text = essayText.value;
  const out = $("ai-review-output");
  const seq = ++aiSeq;

  out.replaceChildren();
  if (!text.trim()) {
    out.append(el("p", "empty", "Nothing to review yet — paste your essay above."));
    return;
  }
  if (!aiReady()) {
    out.append(
      el("p", "empty", "Add your OpenRouter key in settings → ai assist first.")
    );
    return;
  }

  const button = $("essay-ai-review");
  button.disabled = true;
  button.textContent = "reading your draft…";
  const card = el("div", "ai-review-card");
  card.append(el("p", "add-status", "thinking — this takes a moment…"));
  out.append(card);

  try {
    // The bank's headwords ride along so the tutor can point at openings for
    // the student's own vocabulary; the draft itself is the payload.
    const review = await aiEssayReview(aiSettings, {
      essay: text,
      bankWords: app.listWords().map((w) => w.word),
    });
    if (seq !== aiSeq) return; // the draft moved, or a newer review superseded this
    out.replaceChildren();
    renderAiReview(review);
  } catch (err) {
    console.error(err);
    // Same test, plus the card itself: an error has nowhere to go once the
    // panel it was written into has been cleared out from under it.
    if (seq !== aiSeq || !card.isConnected) return;
    card.replaceChildren(
      el("p", "gate-error", String(err.message ?? err))
    );
  } finally {
    button.disabled = false;
    button.textContent = "ai feedback";
  }
});

function renderAiReview(review) {
  const out = $("ai-review-output");
  const card = el("div", "ai-review-card");

  card.append(el("h2", "ai-review-title", "how it reads"));
  if (review.summary) {
    card.append(el("p", "report-summary ai-summary", review.summary));
  }

  if (review.strengths.length) {
    const strengths = el("div", "report-section");
    strengths.append(el("p", "syn-label", "already working"));
    const list = el("ul", "note-list");
    review.strengths.forEach((s) => list.append(el("li", null, s)));
    strengths.append(list);
    card.append(strengths);
  }

  if (review.improvements.length) {
    const improvements = el("div", "report-section");
    improvements.append(el("p", "syn-label", "what would lift it most"));
    review.improvements.forEach((imp) => {
      const row = el("div", "report-word");
      const head = el("div", "report-word-head");
      head.append(el("span", "headword ai-imp-title", imp.title || "improvement"));
      row.append(head);
      if (imp.detail) row.append(el("p", "report-sentence", imp.detail));
      improvements.append(row);
    });
    card.append(improvements);
  }

  if (review.focus.length) {
    const focus = el("div", "report-section");
    focus.append(el("p", "syn-label", "practise next"));
    focus.append(el("p", "report-summary", review.focus.join(" · ")));
    card.append(focus);
  }

  const note = el("p", "ai-review-note");
  note.textContent =
    "AI feedback is advice, not marking. Your teacher decides what counts.";
  card.append(note);
  out.append(card);
}

/* ---- quick lookup ----
   A definition without commitment: “/” (or ⌘K) opens a small overlay that
   fetches the meaning of any word, with the option to bank it after all. */

const lookupBox = $("lookup");
const lookupInput = $("lookup-input");
const lookupStatus = $("lookup-status");
const lookupResult = $("lookup-result");
let lookupSeq = 0; // a stale response must not overwrite a newer one

function openLookup() {
  // Same guard as the rail: on the web the gate may still be up.
  if (!app) return;
  lookupBox.hidden = false;
  lookupInput.select();
  lookupInput.focus();
}

$("rail-lookup").addEventListener("click", openLookup);

lookupBox.addEventListener("click", (e) => {
  if (e.target === lookupBox) lookupBox.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (aboutDialog.open) return;
  const typing = isEditingTarget();
  // Bare “/” (the classic search key), or ⌘K/Ctrl+K even while typing.
  if (
    (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) ||
    (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey)
  ) {
    e.preventDefault();
    openLookup();
  } else if (e.key === "Escape" && !lookupBox.hidden) {
    lookupBox.hidden = true;
  }
});

$("lookup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = lookupInput.value.trim().toLowerCase();
  if (!word) return;
  const seq = ++lookupSeq;
  lookupResult.replaceChildren();
  lookupStatus.hidden = false;
  lookupStatus.classList.remove("error");
  lookupStatus.textContent = `finding “${word}”…`;
  try {
    const dict = await fetchDefinition(word);
    if (seq !== lookupSeq) return;
    lookupStatus.hidden = true;
    renderLookupResult(word, dict);
  } catch (err) {
    if (seq !== lookupSeq) return;
    lookupStatus.textContent = String(err.message ?? err);
    lookupStatus.classList.add("error");
  }
});
function renderLookupResult(word, dict) {
  lookupResult.replaceChildren();

  const head = el("p", "lookup-word");
  head.append(el("span", "headword", word));
  if (dict.phonetic) head.append(el("span", "phonetic", dict.phonetic));
  lookupResult.append(head);

  dict.senses.forEach((s, i) => lookupResult.append(senseNode(s, i)));

  const meta = el("div", "entry-meta");
  meta.append(el("span", null, dict.source));
  const src = el("button", "link-quiet", "view definition");
  src.addEventListener("click", () => platform.openUrl(dict.source_url));
  meta.append(src);
  if (dict.clarification_url) {
    const clarification = el("button", "link-quiet", "view clarification");
    clarification.addEventListener("click", () =>
      platform.openUrl(dict.clarification_url)
    );
    meta.append(clarification);
  }

  if (app.listWords().some((w) => w.word === word)) {
    meta.append(el("span", null, "in your bank"));
  } else {
    const add = el("button", "link-quiet", "add to bank");
    add.addEventListener("click", async () => {
      add.disabled = true;
      lookupStatus.hidden = false;
      lookupStatus.classList.remove("error");
      lookupStatus.textContent = `adding “${word}”…`;
      try {
        await app.addWord(word);
        expandedWords.add(word);
        await renderBank();
        lookupStatus.textContent = `“${word}” is in your bank now`;
        add.replaceWith(el("span", null, "in your bank"));
      } catch (err) {
        lookupStatus.textContent = String(err.message ?? err);
        lookupStatus.classList.add("error");
        add.disabled = false;
      }
    });
    meta.append(add);
  }
  lookupResult.append(meta);
  attachWordTools(word, meta);
}

/* ---- sync view ---- */

function renderSync() {
  const connected = Boolean(sync?.enabled);
  // Desktop can be configured-but-locked: settings exist, password not yet given.
  const locked = Boolean(desktopUnlockForm);
  $("sync-connected").hidden = !connected;
  $("sync-setup").hidden = connected || locked;
  $("sync-lede").textContent = connected
    ? "This device is syncing with GitHub. Your bank is encrypted with your password before it is stored."
    : locked
      ? "Sync is set up on this device but locked."
      : platform.kind === "desktop"
        ? "Connect this app to a private GitHub repository to share your bank with the web version."
        : "Connect to a private GitHub repository to sync this browser with your desktop app.";

  if (connected && syncConfig) {
    $("sync-repo").textContent = `${syncConfig.owner}/${syncConfig.repo}`;
    $("sync-path").textContent = syncConfig.path;
  }
  renderMirror();
  renderConflicts();
}

let syncConfig = null;

function applySyncStatus({ text, kind, enabled }) {
  const line = $("sync-line");
  line.hidden = !enabled;
  line.textContent = text;
  line.className = `sync-line sync-${kind}`;
  const status = $("sync-status");
  if (status) status.textContent = text;
}

$("sync-line").addEventListener("click", () => {
  switchView("sync");
  sync?.now();
});

$("sync-now").addEventListener("click", () => sync?.now());

$("sync-disconnect").addEventListener("click", async () => {
  sync?.disable();
  // Take our file out of the backup folder on the way out. Left behind, it
  // would age into a "stale peer" the other machine reports for six months —
  // and the settings that name it are about to be erased.
  const { mirrorRoot, deviceId } = syncConfig ?? {};
  if (platform.mirror?.supported && mirrorRoot && deviceId) {
    try {
      await platform.mirror.fs(mirrorRoot).remove(peerFileName(deviceId));
    } catch {
      /* the folder may be gone; the vault is cleared either way */
    }
  }
  await clearVault();
  // The log holds word records sealed under a key we are about to forget.
  await clearConflictLog();
  conflictLog = [];
  mirror = null;
  mirrorInfo = null;
  syncConfig = null;
  sessionKey = null;
  if (platform.kind === "web") {
    await forgetSessionSealedAiKey();
    await platform.clearCache();
    location.reload();
  } else {
    $("sync-line").hidden = true;
    renderSync();
  }
});

$("sync-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("ds-error");
  err.hidden = true;
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "connecting…";
  try {
    const { key, config, salt } = await createVault({
      password: $("ds-password").value,
      token: $("ds-token").value.trim(),
      owner: $("ds-owner").value.trim(),
      repo: $("ds-repo").value.trim(),
      path: $("ds-path").value.trim() || "bank.lexis.json",
    });
    await startSync(key, { ...config, salt });
    $("ds-token").value = "";
    $("ds-password").value = "";
    await sync.now();
    await renderBank();
    renderSync();
  } catch (e2) {
    err.textContent = String(e2.message ?? e2);
    err.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "connect";
  }
});

/* ---- the local backup folder ---- */

let mirror = null;
let mirrorInfo = null; // what the backend reported about the folder
let mirrorWarning = null; // sticky: a folder problem found when it was chosen
let mirrorNotes = []; // per-pass: stale peers, unreadable files, write failures

/**
 * Turns sync on for this session, across every channel this build has.
 *
 * Both ends come through here — the browser after the gate, the desktop after
 * its unlock or its first connect — so the folder, the conflict log, and the
 * session key are set up in exactly one place rather than three.
 */
async function startSync(key, config) {
  sessionKey = key;
  syncConfig = config;
  mirror = await attachMirror(config);
  sync.enable(key, config, mirror);
  conflictLog = await loadConflictLog(key);
  renderSync();
}

/**
 * Builds the mirror channel from the stored settings, if there are any.
 *
 * A folder that isn't there right now — an unmounted drive, an external disk
 * still in a bag — is a note, not a refusal. The channel is attached anyway so
 * it resumes by itself when the folder comes back, which is the whole point of
 * a backup you don't have to think about.
 */
async function attachMirror(config) {
  mirrorInfo = null;
  mirrorWarning = null;
  mirrorNotes = [];
  if (!platform.mirror?.supported || !config?.mirrorRoot || !config?.deviceId) return null;
  try {
    mirrorInfo = await platform.mirror.check(config.mirrorRoot);
    if (!mirrorInfo.syncthing) mirrorWarning = notWatchedWarning(mirrorInfo.root);
  } catch (err) {
    mirrorWarning = `${config.mirrorRoot} isn’t available right now — ${String(err.message ?? err)}`;
  }
  return createMirror({
    fs: platform.mirror.fs(config.mirrorRoot),
    device: config.deviceId,
    salt: config.salt,
  });
}

function notWatchedWarning(root) {
  return `No .stfolder marker was found at or above ${root}, so Syncthing may not be carrying it. The backup is still written; it just may not reach your other machine.`;
}

/**
 * The folder notice, with a way to silence it.
 *
 * lexis only asks for a folder both machines can see — Syncthing is the
 * obvious way to arrange that, but it is not the only one, and a standing
 * warning aimed at people who chose Dropbox or a network share would be a
 * scold rather than information. Silencing it is remembered in the vault
 * beside the folder itself.
 */
function warningNode(text) {
  const li = el("li", null, `${text} `);
  const quiet = el("button", "link-quiet", "don’t mention this again");
  quiet.type = "button";
  quiet.addEventListener("click", () =>
    mutate(async () => {
      await saveSyncConfig({ ...syncConfig, mirrorQuiet: true });
      renderMirror();
    })
  );
  li.append(quiet);
  return li;
}

/** Rewrites the vault under the same key, so the token is never re-entered. */
async function saveSyncConfig(next) {
  const { salt, ...stored } = next;
  await updateVault(sessionKey, salt, stored);
  syncConfig = next;
}

function renderMirror() {
  const block = $("mirror");
  block.hidden = !platform.mirror?.supported || !sync?.enabled;
  if (block.hidden) return;

  const on = Boolean(syncConfig?.mirrorRoot && syncConfig?.deviceId);
  $("mirror-lede").textContent = on
    ? "Every change is written here too, encrypted, for your other machine to pick up — no internet needed."
    : "Point lexis at a folder Syncthing carries between your machines and it will keep an encrypted copy there as well as on GitHub.";
  $("mirror-facts").hidden = !on;
  $("mirror-form").hidden = on;
  $("mirror-actions").hidden = !on;

  if (on) {
    $("mirror-path").textContent = mirrorInfo?.path ?? `${syncConfig.mirrorRoot}/lexis`;
    $("mirror-file").textContent = peerFileName(syncConfig.deviceId);
    const peers = mirror?.peerCount;
    $("mirror-peers").textContent =
      peers == null ? "—" : peers === 0 ? "none seen yet" : String(peers);
  }

  const notes = $("mirror-notes");
  const showWarning = mirrorWarning && !syncConfig?.mirrorQuiet;
  notes.replaceChildren(
    ...(showWarning ? [warningNode(mirrorWarning)] : []),
    ...mirrorNotes.map((n) => el("li", null, n))
  );
  notes.hidden = notes.childElementCount === 0;
}

$("mirror-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("mirror-error");
  err.hidden = true;
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "checking…";
  try {
    const typed = $("mirror-root").value.trim();
    if (!typed) throw new Error("Type the folder both machines share.");
    // Validate before committing anything: a folder that can't be written is
    // better refused here than discovered as a status line three syncs later.
    const info = await platform.mirror.check(typed);
    await saveSyncConfig({
      ...syncConfig,
      mirrorRoot: info.root,
      // Reused if the folder was turned off and on again, so an old file of
      // ours is refreshed rather than orphaned beside a new one.
      deviceId: syncConfig.deviceId ?? newDeviceId(),
    });
    mirror = await attachMirror(syncConfig);
    sync.setMirror(mirror);
    renderSync();
    await sync.now();
    await renderBank();
    renderSync();
  } catch (e2) {
    err.textContent = String(e2.message ?? e2);
    err.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "use this folder";
  }
});

$("mirror-off").addEventListener("click", () =>
  mutate(async () => {
    const { mirrorRoot, deviceId } = syncConfig ?? {};

    // Persist the decision *before* acting on it. A vault write can fail — a
    // full disk, a locked store — and if it does, the recoverable state is the
    // one where the folder is still running and the settings still describe
    // it. Deleting the file first would leave the panel insisting the backup
    // is on while the file it names is already gone.
    const next = { ...syncConfig };
    delete next.mirrorRoot; // deviceId is kept, so turning it back on reuses the name
    delete next.mirrorQuiet; // a different folder deserves to be judged afresh
    await saveSyncConfig(next);

    // Retiring the channel here also stops a pass already in flight from
    // rewriting the file a moment after we remove it.
    sync?.setMirror(null);
    mirror = null;

    // Take our file with us. Left behind it would age into a "stale peer" the
    // other machine reports for six months and then still refuses to merge.
    if (mirrorRoot && deviceId) {
      try {
        await platform.mirror.fs(mirrorRoot).remove(peerFileName(deviceId));
      } catch {
        /* the folder may already be gone; nothing here is load-bearing */
      }
    }
    mirrorInfo = null;
    mirrorWarning = null;
    mirrorNotes = [];
    renderSync();
  })
);

/* ---- conflicts ---- */

let conflictLog = [];

async function recordConflicts(fresh) {
  conflictLog = foldConflicts(conflictLog, fresh);
  try {
    if (sessionKey) await saveConflictLog(sessionKey, conflictLog);
  } catch (err) {
    console.error(err); // the list still works this session
  }
  renderConflicts();
}

/**
 * Marks a conflict dealt with rather than deleting it.
 *
 * Detection re-derives from the channels every pass, so a removed entry would
 * simply be found again on the next poll. The flag is what makes "dismiss"
 * and "use the other copy" stick.
 */
async function dropConflict(id) {
  conflictLog = conflictLog.map((c) => (c.id === id ? { ...c, dismissed: true } : c));
  try {
    if (sessionKey) await saveConflictLog(sessionKey, conflictLog);
  } catch (err) {
    console.error(err);
  }
  renderConflicts();
}

function conflictNode(entry) {
  const li = el("li", "conflict");
  li.append(el("p", "conflict-word", entry.word));

  const when = new Date(entry.at ?? 0);
  const stamp = Number.isFinite(when.getTime())
    ? `${when.toLocaleDateString()} ${String(when.getHours()).padStart(2, "0")}:${String(
        when.getMinutes()
      ).padStart(2, "0")}`
    : "";
  li.append(
    el(
      "p",
      "conflict-why",
      entry.kind === "delete"
        ? `Deleted on ${entry.keptSide}, but ${entry.lostSide} had edited it since. ${stamp}`
        : entry.kind === "definition"
          ? `Kept the definition from ${entry.keptSide}; ${entry.lostSide} had a different one. ${stamp}`
          : `Kept the copy from ${entry.keptSide}; the one from ${entry.lostSide} had ${entry.reasons.join(
              ", "
            )}. ${stamp}`
    )
  );

  const actions = el("div", "conflict-actions");
  const take = el(
    "button",
    "link-quiet",
    entry.kind === "delete"
      ? "put the word back"
      : entry.kind === "definition"
        ? "use the other definition"
        : "use the other copy"
  );
  take.addEventListener("click", () =>
    mutate(async () => {
      take.disabled = true;
      // Reinstated as an edit made now, so it wins on GitHub and in the folder
      // by the ordinary rules rather than by a local special case. A definition
      // conflict restores only the dictionary half — the schedule it was merged
      // with may have been kept from the other device, and is not in dispute.
      if (entry.kind === "definition") await app.restoreDefinition(entry.lost);
      else await app.restoreWord(entry.lost);
      await dropConflict(entry.id);
      await renderBank();
    })
  );
  const drop = el("button", "link-quiet", "dismiss");
  drop.addEventListener("click", () => mutate(() => dropConflict(entry.id)));
  actions.append(take, drop);
  li.append(actions);
  return li;
}

function renderConflicts() {
  const open = conflictLog.filter((c) => !c.dismissed);
  $("conflicts").hidden = open.length === 0;
  $("conflict-list").replaceChildren(...open.map(conflictNode));
}

$("conflicts-clear").addEventListener("click", async () => {
  // Dismiss rather than delete. Detection re-derives from the channels every
  // pass, so an emptied log simply refills on the next poll — the flag is the
  // only thing that makes "clear" mean anything.
  conflictLog = conflictLog.map((c) => ({ ...c, dismissed: true }));
  try {
    if (sessionKey) await saveConflictLog(sessionKey, conflictLog);
  } catch (err) {
    console.error(err);
  }
  renderConflicts();
});

/* ---- settings ---- */

const settingsForm = $("settings-form");
const settingsDailyTarget = $("settings-daily-target");
const settingsStatus = $("settings-status");

function renderSettings() {
  const settings = app.getSettings();
  settingsDailyTarget.min = String(settings.min_daily_target);
  settingsDailyTarget.max = String(settings.max_daily_target);
  settingsDailyTarget.value = String(settings.daily_target);
}

settingsDailyTarget.addEventListener("input", () => {
  settingsStatus.hidden = true;
  settingsStatus.classList.remove("error");
});

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  settingsStatus.hidden = true;
  settingsStatus.classList.remove("error");
  try {
    const settings = await app.setDailyTarget(settingsDailyTarget.value);
    settingsDailyTarget.value = String(settings.daily_target);
    settingsStatus.textContent = `Daily batches now contain ${settings.daily_target} word${settings.daily_target === 1 ? "" : "s"}.`;
    settingsStatus.hidden = false;
    await refreshCounts();
  } catch (err) {
    settingsStatus.textContent = String(err.message ?? err);
    settingsStatus.classList.add("error");
    settingsStatus.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/* ---- AI assist ---- */

let aiSettings = null; // decrypted in-memory copy: { key, model }
let aiModels = null; // the catalogue, fetched lazily for suggestions
let aiKeyInfo = null; // the last balance OpenRouter gave us, or null for "not asked"
let aiSeq = 0; // stale-response guard for the essay review

function aiReady() {
  return Boolean(aiSettings?.key);
}

function keyLabel(info) {
  return info.label || "OpenRouter key";
}

/**
 * Spend, in the currency OpenRouter actually bills in. `usage` and `limit`
 * arrive as bare numbers, and a bare "1.25 of 10.00" invites reading a US
 * dollar balance as whatever the student happens to think in.
 */
function keySpend(info) {
  const spent = `US$${info.usage.toFixed(2)} spent`;
  if (info.remaining == null) return `${spent} · no limit set`;
  return `${spent} of US$${info.limit.toFixed(2)} · US$${info.remaining.toFixed(2)} left`;
}

/** The one-line form, for the status message after a save. */
function describeKeyInfo(info) {
  return `${keyLabel(info)} · ${keySpend(info)}`;
}

/**
 * What this session has asked for. The client's own ledger, so it costs no
 * request — and it answers the question a balance can't: what has this sitting
 * spent, as against what the key has spent since it was minted.
 */
function describeSessionUsage() {
  const usage = aiSessionUsage();
  if (!usage.requests) return "nothing yet";
  const requests = `${usage.requests} request${usage.requests === 1 ? "" : "s"}`;
  const tokens = usage.totalTokens
    ? ` · ${usage.totalTokens.toLocaleString()} tokens`
    : "";
  const cost = usage.cost ? ` · about US$${usage.cost.toFixed(4)}` : "";
  return `${requests}${tokens}${cost}`;
}

function showAiStatus(text, isError = false) {
  const status = $("ai-status");
  status.textContent = text;
  status.classList.toggle("error", isError);
  status.hidden = false;
}

/**
 * Paints the panel from what is already known. Deliberately free of network
 * calls: the app promises that nothing leaves for OpenRouter until a feature
 * is asked for, and a panel that checked the balance on every render would
 * break that promise at every boot.
 */
function renderAiSettings() {
  const has = aiReady();
  $("essay-ai-review").hidden = !has;
  $("ai-remove").hidden = !has;
  $("ai-key-note").hidden = has;
  // The key field stays empty once saved; showing even a fragment invites copying.
  $("ai-key").value = "";
  $("ai-key").placeholder = has ? "saved — type to replace" : "sk-or-v1-…";
  $("ai-model").value = aiSettings?.model ?? "";
  $("ai-facts").hidden = !has;
  $("ai-facts-actions").hidden = !has;
  if (has) renderAiFacts();
}

/** The facts table, from the last answer OpenRouter gave — never a fresh one. */
function renderAiFacts() {
  $("ai-key-label").textContent = aiKeyInfo ? keyLabel(aiKeyInfo) : "saved";
  $("ai-key-spent").textContent = aiKeyInfo ? keySpend(aiKeyInfo) : "not checked yet";
  $("ai-session-usage").textContent = describeSessionUsage();
}

/**
 * The only place the settings panel asks OpenRouter anything — and it runs
 * when the panel is opened, not when the app starts. Asked once a session
 * unless the student presses refresh.
 */
async function refreshAiFacts(force = false) {
  if (!aiReady()) return;
  if (aiKeyInfo && !force) return renderAiFacts();
  $("ai-key-spent").textContent = "checking…";
  try {
    aiKeyInfo = await fetchKeyInfo(aiSettings.key);
  } catch (err) {
    aiKeyInfo = null;
    renderAiFacts();
    $("ai-key-spent").textContent = String(err.message ?? err);
    return;
  }
  renderAiFacts();
}

/**
 * Called when the settings view opens. The first moment the panel is actually
 * looked at is the first moment it is worth spending a request on it.
 */
function openAiPanel() {
  renderAiSettings();
  if (!aiReady()) return;
  refreshAiFacts();
  refreshModelSuggestions();
}

/** Fills the model datalist quietly; never an error worth showing. */
async function refreshModelSuggestions() {
  try {
    if (!aiModels) aiModels = await fetchModels(aiSettings.key);
    const options = aiModels.slice(0, 400).map((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.label = m.name;
      return opt;
    });
    $("ai-model-list").replaceChildren(...options);
  } catch {
    /* suggestions are decorative */
  }
}

/**
 * Whether OpenRouter would reject this model id, phrased for a human.
 *
 * A typo saves cleanly and verifies cleanly — `/key` doesn't check the model —
 * and then fails at first *use*, with a raw 400, long after this screen said
 * "saved". Better to catch it while the student is still looking at the field
 * they typed it into. Returns null when there is nothing to say, including
 * when the catalogue couldn't be fetched: a list we failed to load is no
 * grounds for refusing to save.
 */
async function modelObjection(key, model) {
  if (!model) return null; // blank is legitimate: openrouter/auto routes it
  const wanted = normalizeModel(model);
  if (!aiModels) {
    try {
      aiModels = await fetchModels(key);
    } catch {
      return null;
    }
  }
  if (!aiModels.length || aiModels.some((m) => m.id === wanted)) return null;
  const near = aiModels
    .filter((m) => m.id.includes(wanted) || wanted.includes(m.id))
    .slice(0, 3)
    .map((m) => m.id);
  return near.length
    ? `OpenRouter has no model called “${wanted}”. Did you mean ${near.join(", ")}?`
    : `OpenRouter has no model called “${wanted}”. Pick one from the list, or leave it blank for automatic routing.`;
}

$("ai-settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("ai-status");
  status.hidden = true;
  status.classList.remove("error");
  const typedKey = $("ai-key").value.trim();
  const model = $("ai-model").value.trim();
  if (!typedKey && !aiReady()) {
    showAiStatus("Paste your OpenRouter key first.", true);
    return;
  }

  const button = $("ai-save");
  button.disabled = true;
  try {
    const key = typedKey || aiSettings.key;
    const objection = await modelObjection(key, model);
    if (objection) {
      showAiStatus(objection, true);
      return;
    }
    const next = await saveAiSettings(platform, { key, model });
    aiSettings = next;
    aiKeyInfo = null; // a replaced key has its own balance
    // Prove the key works before celebrating it — but a verification failure
    // must not read as a failed *save*, which it isn't.
    let verified = null;
    try {
      verified = await fetchKeyInfo(next.key);
    } catch (verifyErr) {
      console.error(verifyErr);
      renderAiSettings();
      showAiStatus("Saved. Couldn’t reach OpenRouter to check the balance just now.");
      return;
    }
    aiKeyInfo = verified;
    renderAiSettings();
    showAiStatus(`Saved and working — ${describeKeyInfo(verified)}.`);
  } catch (err) {
    showAiStatus(String(err.message ?? err), true);
  } finally {
    button.disabled = false;
  }
});

$("ai-refresh").addEventListener("click", async () => {
  const button = $("ai-refresh");
  button.disabled = true;
  try {
    await refreshAiFacts(true);
  } finally {
    button.disabled = false;
  }
});

$("ai-remove").addEventListener("click", async () => {
  let erased = true;
  try {
    await clearAiSettings();
  } catch (err) {
    console.error(err); // the panel updates regardless, but don't claim more
    erased = false;
  }
  aiSettings = { key: "", model: "" };
  aiModels = null;
  aiKeyInfo = null;
  aiWordCache.clear();
  aiOpenDrawers.clear();
  renderAiSettings();
  showAiStatus(
    erased
      ? "Key removed. The stored ciphertext is gone."
      : "Key removed from this session, but the stored copy could not be erased — try again.",
    !erased
  );
  // Every entry on screen still carries AI triggers that now lead nowhere;
  // the bank has to be redrawn for them to disappear.
  await renderBank();
});

["ai-key", "ai-model"].forEach((id) =>
  $(id).addEventListener("input", () => {
    const status = $("ai-status");
    status.hidden = true;
    status.classList.remove("error");
  })
);

/**
 * Loads AI settings at unlock/boot. Never blocks or breaks startup: the app
 * is fully usable without a key, and an unreadable vault just reads as
 * "not set up". Nothing here touches the network — the balance is asked for
 * when the settings panel is opened, not when the app starts.
 */
async function initAi() {
  aiSettings = await loadAiSettings(platform);
  renderAiSettings();
  // The bank may already be on screen from boot; with a key present its
  // entries now grow their AI triggers.
  if (aiReady()) await renderBank();
}

/**
 * Forgets the AI key when the thing that sealed it is being thrown away.
 *
 * On the web that seal *is* the password-derived session key. Clearing the
 * vault without clearing this leaves an envelope nobody can open — and one
 * that would silently spring back to life if the same password and repository
 * were ever paired again, handing a re-paired session the previous account's
 * key. The desktop seals under a device key that has nothing to do with sync,
 * so disconnecting there must leave it exactly where it is.
 */
async function forgetSessionSealedAiKey() {
  if (platform?.kind !== "web") return;
  try {
    await clearAiSettings();
  } catch (err) {
    console.error(err); // best-effort; the reload follows either way
  }
  aiSettings = { key: "", model: "" };
  aiModels = null;
  aiKeyInfo = null;
  aiWordCache.clear();
  aiOpenDrawers.clear();
}

/* ---- AI word tools (bank + lookup) ---- */

/**
 * Answers already paid for, kept for the life of the session.
 *
 * A bank re-render happens on every add, delete and sort, and it rebuilds
 * every entry from scratch. Without this, a redraw silently discarded results
 * the student had just spent credit on — so adding one word threw away the
 * comparison they were reading. Cached, a redraw costs nothing and "ask
 * again" stays the only thing that spends money.
 */
const aiWordCache = new Map(); // word -> { similar, examples, examplesSeed, nuance: Map }

/** Which drawers were left open, so a redraw puts the view back as it was. */
const aiOpenDrawers = new Set(); // `${word}\u0000similar` | `${word}\u0000examples`

function wordCache(word) {
  let entry = aiWordCache.get(word);
  if (!entry) {
    entry = { similar: null, examples: null, examplesSeed: null, nuance: new Map() };
    aiWordCache.set(word, entry);
  }
  return entry;
}

/**
 * Exactly the draft excerpt aiExampleSentences() sends as context.
 *
 * Similar words and nuance depend only on the headword, so those answers stay
 * true for as long as the session lasts. Example sentences are seeded from the
 * open draft, so they are worth reusing only while that seed is unchanged —
 * otherwise the cache would quietly hand back sentences written about a
 * paragraph the student has since deleted.
 */
function exampleSeed() {
  return essayText.value.replace(/\s+/g, " ").trim().slice(0, 2400);
}

// A NUL separator, because a headword may contain a space: “big cat” with
// tool “x” must never collide with “big” and tool “cat x”.
const drawerKey = (word, tool) => `${word}\u0000${tool}`;

/**
 * One shared drawer for per-word AI results, wherever the word came from.
 * `stillWanted` lets a caller abandon a reply that a later click superseded.
 */
async function runWordTool(mount, work, render, stillWanted = () => true) {
  mount.replaceChildren();
  const statusLine = el("p", "add-status");
  statusLine.textContent = "thinking…";
  mount.append(statusLine);
  try {
    const result = await work();
    if (!stillWanted()) return;
    mount.replaceChildren();
    if (result) render(result);
  } catch (err) {
    console.error(err);
    if (!stillWanted()) return;
    statusLine.textContent = String(err.message ?? err);
    statusLine.classList.add("error");
    mount.replaceChildren(statusLine);
  }
}

/**
 * The shell every word tool sits in: a quiet trigger that says whether it is
 * expanded, a drawer that remembers whether it was open, and a body that
 * announces itself when the answer finally arrives — seconds after the click,
 * long after focus has moved on.
 *
 * A restored drawer re-opens only when its answer is already cached, so a
 * redraw can never quietly spend money re-fetching something.
 */
function toolDrawer({ word, tool, label, heading, note, cached, load }) {
  const wrap = el("div", "ai-tool-result");
  const head = el("p", "report-summary");
  head.append(el("span", "syn-label", heading), document.createTextNode(note));
  wrap.append(head);

  const body = el("div", "ai-tool-body");
  body.setAttribute("aria-live", "polite");
  wrap.append(body);

  const trigger = el("button", "link-quiet", label);
  trigger.type = "button";
  const key = drawerKey(word, tool);

  /** The visible state, with no opinion about what the student wanted. */
  const applyOpen = (open) => {
    wrap.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };

  /** A click: the visible state *and* the remembered intent. */
  const setOpen = (open) => {
    applyOpen(open);
    if (open) aiOpenDrawers.add(key);
    else aiOpenDrawers.delete(key);
  };

  trigger.addEventListener("click", () => {
    const opening = wrap.hidden;
    setOpen(opening);
    if (opening && !body.childElementCount) load(body);
  });

  // Restoring is a read, so it uses applyOpen: a redraw that lands while the
  // answer is still in flight must not be mistaken for the student closing
  // the drawer, which would erase the very intent this Set exists to keep.
  applyOpen(cached() && aiOpenDrawers.has(key));
  if (!wrap.hidden) load(body); // from cache: no request, no flicker
  return { node: wrap, trigger, body };
}

function similarWordsNode(word) {
  const cache = wordCache(word);
  // Where a “vs” comparison lands: beneath the list it belongs to.
  const detail = el("div", "ai-nuance-detail");
  detail.setAttribute("aria-live", "polite");
  // Only the most recently asked-for comparison may write here. Two rows
  // clicked in quick succession would otherwise land in whatever order the
  // network chose rather than the order the student asked for.
  let nuanceSeq = 0;

  const renderList = (body, { words }) => {
    words.forEach((entry) => {
      const row = el("div", "nuance-row");
      row.append(el("span", "headword nuance-word", entry.word));
      row.append(el("span", "nuance-note", entry.note || ""));
      // The question a list of near-synonyms always provokes — “so can I
      // swap them?” — answered in place rather than left hanging.
      const vs = el("button", "link-quiet", "vs");
      vs.type = "button";
      vs.setAttribute("aria-label", `compare ${word} with ${entry.word}`);
      vs.addEventListener("click", () => {
        const seq = ++nuanceSeq;
        vs.disabled = true;
        runWordTool(
          detail,
          async () => {
            const hit = cache.nuance.get(entry.word);
            if (hit) return hit;
            const result = await aiNuance(aiSettings, [word, entry.word]);
            cache.nuance.set(entry.word, result);
            return result;
          },
          ({ distinctions, guidance }) => {
            distinctions.forEach((d) => {
              if (!d.nuance) return;
              const line = el("p", "nuance-distinction");
              line.append(el("strong", null, d.word));
              line.append(document.createTextNode(` — ${d.nuance}`));
              detail.append(line);
            });
            if (guidance) detail.append(el("p", "nuance-guidance", guidance));
          },
          () => seq === nuanceSeq
        ).finally(() => {
          if (vs.isConnected) vs.disabled = false;
        });
      });
      row.append(vs);
      body.append(row);
    });
    body.append(againButton("ask again", () => load(body, true)));
  };

  const load = (body, force = false) =>
    runWordTool(
      body,
      async () => {
        if (!force && cache.similar) return cache.similar;
        const result = await aiSimilarWords(aiSettings, word);
        cache.similar = result;
        return result;
      },
      (result) => renderList(body, result)
    );

  const drawer = toolDrawer({
    word,
    tool: "similar",
    label: "similar words (AI)",
    heading: "similar words",
    note: ` — ways “${word}” can be said, with what makes each different`,
    cached: () => Boolean(cache.similar),
    load,
  });
  drawer.node.append(detail);
  return drawer;
}

function examplesNode(word) {
  const cache = wordCache(word);

  // The draft rides along as context when there is one, so the examples
  // speak about the student's own text rather than a generic novel.
  const load = (body, force = false) =>
    runWordTool(
      body,
      async () => {
        const seed = exampleSeed();
        if (!force && cache.examples && cache.examplesSeed === seed) return cache.examples;
        const result = await aiExampleSentences(aiSettings, {
          word,
          context: essayText.value,
        });
        cache.examples = result;
        cache.examplesSeed = seed;
        return result;
      },
      ({ sentences }) => {
        const list = el("ul", "note-list");
        sentences.forEach((s) => list.append(el("li", "ai-example", s)));
        body.append(list);
        body.append(againButton("ask for three more", () => load(body, true)));
      }
    );

  return toolDrawer({
    word,
    tool: "examples",
    label: "example sentences (AI)",
    heading: "in your writing",
    note: ` — three sentences that use “${word}”`,
    cached: () => Boolean(cache.examples) && cache.examplesSeed === exampleSeed(),
    load,
  });
}

/** The small "generate another batch" link at the foot of a result. */
function againButton(label, load) {
  const again = el("button", "link-quiet", label);
  again.type = "button";
  again.addEventListener("click", () => {
    again.disabled = true;
    load();
  });
  return again;
}

/**
 * Attaches the two AI tools beneath an entry's metadata line.
 *
 * Called the first time an entry is opened rather than once per row: a bank
 * of several hundred words would otherwise build thousands of nodes nobody
 * has looked at. Drawers left open — and the answers in them — come back
 * from the session cache, so a redraw costs neither a request nor the view.
 */
function attachWordTools(word, afterNode) {
  if (!aiReady()) return;
  const similar = similarWordsNode(word);
  const examples = examplesNode(word);
  const triggers = el("p", "ai-triggers");
  triggers.append(similar.trigger, document.createTextNode(" "), examples.trigger);
  afterNode.after(triggers, similar.node, examples.node);
}

/* ---- updates (desktop only) ---- */

async function offerUpdate() {
  if (!platform.updates?.supported) return;
  const line = $("update-line");
  let update;
  try {
    update = await platform.updates.check();
  } catch {
    return; // offline or endpoint unreachable — try again next launch
  }
  if (!update) return;

  line.textContent = `v${update.version} available — update`;
  line.hidden = false;
  await platform.updates.onProgress((pct) => {
    // At 100% the installer takes over and the app relaunches itself,
    // so the install call below never resolves on success.
    line.textContent = pct >= 100 ? "installing…" : `updating… ${pct}%`;
  });

  let installing = false;
  line.addEventListener("click", async () => {
    if (installing) return;
    installing = true;
    line.disabled = true;
    line.textContent = "updating…";
    saveEssayDraft();
    // Push local work before the app restarts underneath us.
    if (sync?.enabled) await sync.now().catch(() => {});
    try {
      await platform.updates.install();
    } catch (err) {
      installing = false;
      line.disabled = false;
      line.textContent = /read-only|os error 30/i.test(String(err))
        ? "move lexis to Applications, then update"
        : "update failed — try again";
      console.error(err);
    }
  });
}

/* ---- the gate (web only) ---- */

function showGate(which) {
  $("gate").hidden = false;
  $("gate-unlock").hidden = which !== "unlock";
  $("gate-setup").hidden = which !== "setup";
  const focus = which === "unlock" ? $("unlock-password") : $("setup-owner");
  setTimeout(() => focus.focus(), 0);
}

function hideGate() {
  $("gate").hidden = true;
}

$("gate-unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("unlock-error");
  err.hidden = true;
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "unlocking…";
  try {
    const { key, config } = await unlockVault($("unlock-password").value);
    $("unlock-password").value = "";
    await startWeb(key, config);
  } catch (e2) {
    err.textContent = String(e2.message ?? e2);
    err.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "unlock";
  }
});

$("gate-reset").addEventListener("click", async () => {
  await clearVault();
  await forgetSessionSealedAiKey();
  await platform.clearCache?.();
  location.reload();
});

$("gate-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("setup-error");
  err.hidden = true;
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "connecting…";
  try {
    const { key, config, salt, warning } = await createVault({
      password: $("setup-password").value,
      token: $("setup-token").value.trim(),
      owner: $("setup-owner").value.trim(),
      repo: $("setup-repo").value.trim(),
      path: $("setup-path").value.trim() || "bank.lexis.json",
    });
    if (warning) console.warn(warning);
    $("setup-token").value = "";
    $("setup-password").value = "";
    await startWeb(key, { ...config, salt });
  } catch (e2) {
    err.textContent = String(e2.message ?? e2);
    err.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "connect";
  }
});

/* ---- boot ---- */

function wireApp() {
  app = createApp(platform.storage, () => sync?.schedule());
  sync = createSyncController({
    app,
    onStatus: applySyncStatus,
    onConflicts: recordConflicts,
    onNotes: (notes) => {
      mirrorNotes = notes;
      renderMirror();
    },
    onApplied: () => {
      // A sync can change anything; redraw whatever is on screen.
      const active = document.querySelector(".rail-link.active")?.dataset.view;
      if (active === "bank") renderBank();
      else if (active === "today") renderToday();
      else if (active === "stats") renderStatsView(app.getBank());
      else if (active === "settings") renderSettings();
      else refreshCounts();
    },
  });
}

async function startWeb(key, config) {
  platform.setKey(key);
  hideGate();
  wireApp();
  await app.init();
  await startSync(key, config);
  essayText.value = loadEssayDraft();
  updateEssayCount();
  await renderBank();
  await initAi(); // after the session key exists; never blocks the UI
  addInput.focus();
  requestPersistence(); // upgrade local durability now that we have a gesture
  await sync.now(); // pull whatever the desktop app left behind
  await renderBank();
}

/**
 * Ask the browser to keep our storage instead of evicting it under pressure or
 * after a week away. Fire-and-forget and best-effort: the app works either way,
 * and the copy on GitHub stays the backstop, so this only ever upgrades things.
 * Called from within the unlock/setup submit — a user gesture — because that is
 * when a browser is most willing to grant persistence.
 */
async function requestPersistence() {
  try {
    const result = await platform.requestPersistence?.();
    if (result?.supported) {
      console.info(
        result.persisted
          ? "local storage is persistent — the browser will keep your bank"
          : "local storage is best-effort — the browser may evict it under pressure"
      );
    }
  } catch {
    /* durability is an upgrade, never a requirement */
  }
}
async function startDesktop() {
  wireApp();
  await app.init();
  essayText.value = loadEssayDraft();
  updateEssayCount();
  await renderBank();
  await initAi(); // the device key comes from Rust; never blocks the UI
  addInput.focus();

  // Sync is opt-in on desktop; the app works fully without it.
  if (await hasVault()) {
    // Ask for the password only to unlock sync — the bank itself is already
    // on disk, so the app stays usable if the prompt is never answered.
    const line = $("sync-line");
    line.hidden = false;
    line.textContent = "sync — unlock";
    line.className = "sync-line sync-idle";
    buildDesktopUnlock();
  }
  setTimeout(offerUpdate, 2500); // check quietly after the app settles
}

/**
 * Desktop's sync panel needs its own password prompt. Built here rather than
 * in the markup because the gate's form is web-only and its ids must stay
 * unique in the document.
 */
let desktopUnlockForm = null;

function buildDesktopUnlock() {
  const form = el("form", "gate-form sync-form");
  form.autocomplete = "off";
  form.append(
    el("p", "gate-lede", "Enter your password to turn sync back on for this device.")
  );

  const pw = el("input");
  pw.type = "password";
  pw.placeholder = "password";
  pw.autocomplete = "current-password";
  pw.setAttribute("aria-label", "Password");

  const submit = el("button", "button-primary", "unlock sync");
  submit.type = "submit";

  const errNode = el("p", "gate-error");
  errNode.hidden = true;

  const forget = el("button", "link-quiet", "forget these sync settings");
  forget.type = "button";
  forget.addEventListener("click", async () => {
    await clearVault();
    form.remove();
    desktopUnlockForm = null;
    $("sync-line").hidden = true;
    renderSync();
  });

  form.append(pw, submit, errNode, forget);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errNode.hidden = true;
    submit.disabled = true;
    submit.textContent = "unlocking…";
    try {
      const { key, config } = await unlockVault(pw.value);
      pw.value = "";
      await startSync(key, config);
      form.remove();
      desktopUnlockForm = null;
      await sync.now();
      await renderBank();
      renderSync();
    } catch (e2) {
      errNode.textContent = String(e2.message ?? e2);
      errNode.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "unlock sync";
    }
  });

  desktopUnlockForm = form;
  $("view-sync").append(form);
}

async function boot() {
  if (isDesktop()) {
    platform = createDesktopPlatform();
    await startDesktop();
  } else {
    platform = createWebPlatform();
    if (!cryptoAvailable()) {
      document.body.replaceChildren(
        el("p", "empty", "lexis needs a browser with Web Crypto (and a secure https connection).")
      );
      return;
    }
    showGate((await hasVault()) ? "unlock" : "setup");
  }

  // Coming back to the tab is the moment another device's work is most
  // likely to be waiting.
  globalThis.addEventListener("focus", () => sync?.now());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync?.now();
  });
  // Regaining connectivity — leaving a captive portal, Wi-Fi reconnecting — is
  // the moment to sync at once rather than waiting out a backoff.
  globalThis.addEventListener("online", () => sync?.now());
}

boot();