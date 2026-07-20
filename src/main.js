/**
 * The interface. Platform-agnostic: it talks to the shared core through the
 * app service, and to the host (desktop or browser) through a small adapter.
 */

import { createApp } from "./core/app.js";
import { createSyncController } from "./core/sync-controller.js";
import { isDesktop, createDesktopPlatform } from "./platform/desktop.js";
import { createWebPlatform } from "./platform/web.js";
import { hasVault, unlockVault, createVault, clearVault } from "./core/vault.js";
import { cryptoAvailable } from "./core/crypto.js";

/* ---- tiny DOM helper: everything is textContent, never innerHTML ---- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const $ = (id) => document.getElementById(id);

let platform = null;
let app = null;
let sync = null;

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

const railLinks = document.querySelectorAll(".rail-link");
railLinks.forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

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
  if (name === "essay") updateEssayCount();
  if (name === "sync") renderSync();
}

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

function entryNode(word, expanded) {
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
  body.hidden = !expanded;
  word.senses.forEach((s, i) => body.append(senseNode(s, i)));

  if (word.synonyms.length) {
    const syn = el("p", "synonyms");
    syn.append(el("span", "syn-label", "for essays"));
    syn.append(document.createTextNode(word.synonyms.map((s) => s.word).join(" · ")));
    syn.append(el("span", "syn-note", "suggestions only — not saved to your bank"));
    body.append(syn);
  }

  const meta = el("div", "entry-meta");
  meta.append(el("span", null, `${word.source} · practised ${word.times_used}×`));
  const src = el("button", "link-quiet", "view source");
  src.addEventListener("click", () => platform.openUrl(word.source_url));
  const del = el("button", "link-quiet", "remove");
  del.addEventListener("click", () =>
    mutate(async () => {
      await app.deleteWord(word.word);
      renderBank();
      refreshCounts();
    })
  );
  meta.append(src, del);
  body.append(meta);
  wrap.append(body);

  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
  });
  return wrap;
}

let expandedWord = null;

async function renderBank() {
  const words = app.listWords();
  const list = $("word-list");
  list.replaceChildren();
  words.forEach((w) => list.append(entryNode(w, w.word === expandedWord)));
  $("bank-empty").hidden = words.length > 0;

  const guide = $("guide-words");
  if (words.length >= 2) {
    const alpha = words.map((w) => w.word).sort();
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

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const word = addInput.value.trim();
  if (!word) return;
  addInput.disabled = true;
  addStatus.hidden = false;
  addStatus.classList.remove("error");
  addStatus.textContent = `finding “${word.toLowerCase()}”…`;
  try {
    const entry = await app.addWord(word);
    expandedWord = entry.word;
    addInput.value = "";
    addStatus.hidden = true;
    await renderBank();
  } catch (err) {
    addStatus.textContent = String(err.message ?? err);
    addStatus.classList.add("error");
  } finally {
    addInput.disabled = false;
    addInput.focus();
  }
});

/* ---- today ---- */

async function renderToday() {
  const view = await app.todayList();
  const date = new Date(`${view.date}T00:00:00`);
  $("today-date").textContent = date
    .toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })
    .toLowerCase();

  const list = $("today-list");
  list.replaceChildren();
  $("today-empty").hidden = view.items.length > 0;

  if (view.items.length) {
    $("today-lede").textContent =
      view.remaining === 0
        ? "All used. Your writing did the remembering today."
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
  const reviewActive = $("view-review").classList.contains("active");
  const typing = ["TEXTAREA", "INPUT"].includes(document.activeElement.tagName);
  if (reviewActive && currentReveal && !typing) {
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
essayText.addEventListener("input", () => {
  updateEssayCount();
  saveEssayDraft();
});

$("essay-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  essayText.value = await file.text();
  updateEssayCount();
  saveEssayDraft();
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
  if (usedToday.length) {
    const mark = el("button", "button-primary", "mark these as practised");
    mark.addEventListener("click", () =>
      mutate(async () => {
        for (const u of usedToday) {
          await app.tickWord(u.word, true);
        }
        mark.replaceWith(el("p", "report-summary", "Marked. They’ll return on schedule."));
        refreshCounts();
      })
    );
    out.append(mark);
  }
});

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
  clearVault();
  syncConfig = null;
  if (platform.kind === "web") {
    platform.clearCache();
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
    syncConfig = { ...config, salt };
    sync.enable(key, syncConfig);
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

$("gate-reset").addEventListener("click", () => {
  clearVault();
  platform.clearCache?.();
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
    onApplied: () => {
      // A sync can change anything; redraw whatever is on screen.
      const active = document.querySelector(".rail-link.active")?.dataset.view;
      if (active === "bank") renderBank();
      else if (active === "today") renderToday();
      else refreshCounts();
    },
  });
}

async function startWeb(key, config) {
  platform.setKey(key);
  hideGate();
  wireApp();
  syncConfig = config;
  await app.init();
  sync.enable(key, config);
  essayText.value = loadEssayDraft();
  updateEssayCount();
  await renderBank();
  addInput.focus();
  await sync.now(); // pull whatever the desktop app left behind
  await renderBank();
}

async function startDesktop() {
  wireApp();
  await app.init();
  essayText.value = loadEssayDraft();
  updateEssayCount();
  await renderBank();
  addInput.focus();

  // Sync is opt-in on desktop; the app works fully without it.
  if (hasVault()) {
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
  forget.addEventListener("click", () => {
    clearVault();
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
      syncConfig = config;
      sync.enable(key, config);
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
    $("rail-privacy").textContent = "your bank stays on this device";
    await startDesktop();
  } else {
    platform = createWebPlatform();
    $("rail-privacy").textContent = "encrypted before it leaves this device";
    if (!cryptoAvailable()) {
      document.body.replaceChildren(
        el("p", "empty", "lexis needs a browser with Web Crypto (and a secure https connection).")
      );
      return;
    }
    showGate(hasVault() ? "unlock" : "setup");
  }

  // Coming back to the tab is the moment another device's work is most
  // likely to be waiting.
  globalThis.addEventListener("focus", () => sync?.now());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync?.now();
  });
}

boot();
