const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;

/* ---- tiny DOM helper: everything is textContent, never innerHTML ---- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const $ = (id) => document.getElementById(id);

/* ---- navigation ---- */

const railLinks = document.querySelectorAll(".rail-link");
railLinks.forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(name) {
  railLinks.forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${name}`);
  });
  if (name === "bank") renderBank();
  if (name === "today") renderToday();
  if (name === "review") startReview();
  if (name === "essay") updateEssayCount();
}

async function refreshCounts() {
  try {
    const [words, due, today] = await Promise.all([
      invoke("list_words"),
      invoke("due_words"),
      invoke("today_list"),
    ]);
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
  src.addEventListener("click", () => {
    tauri?.opener?.openUrl(word.source_url).catch(() => {});
  });
  const del = el("button", "link-quiet", "remove");
  del.addEventListener("click", async () => {
    await invoke("delete_word", { word: word.word });
    renderBank();
    refreshCounts();
  });
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
  const words = await invoke("list_words");
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
    const entry = await invoke("add_word", { word });
    expandedWord = entry.word;
    addInput.value = "";
    addStatus.hidden = true;
    await renderBank();
  } catch (err) {
    addStatus.textContent = String(err);
    addStatus.classList.add("error");
  } finally {
    addInput.disabled = false;
    addInput.focus();
  }
});

/* ---- today ---- */

async function renderToday() {
  const view = await invoke("today_list");
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
    tick.addEventListener("click", async () => {
      await invoke("tick_word", { word: item.word, ticked: !item.ticked });
      renderToday();
      refreshCounts();
    });
    row.append(tick, el("span", "today-word", item.word), el("span", "today-def", item.def));
    list.append(row);
  });
}

/* ---- review ---- */

let queue = [];
let reviewed = 0;

async function startReview() {
  queue = await invoke("due_words");
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
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await invoke("grade_word", { word: word.word, grade: g });
        queue.shift();
        if (g === "again") queue.push(word); // Anki-style: lapses return this session
        reviewed += 1;
        renderCard();
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
  if (reviewActive && currentReveal && document.activeElement.tagName !== "TEXTAREA") {
    e.preventDefault();
    currentReveal();
  }
});

/* ---- essay ---- */

const essayText = $("essay-text");
const essayCount = $("essay-count");

function updateEssayCount() {
  const n = essayText.value.split(/\s+/).filter(Boolean).length;
  essayCount.textContent = n ? `${n} words` : "";
}
essayText.addEventListener("input", updateEssayCount);

$("essay-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  essayText.value = await file.text();
  updateEssayCount();
});

$("essay-check").addEventListener("click", async () => {
  const text = essayText.value;
  const report = await invoke("analyze_essay", { text });
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
    mark.addEventListener("click", async () => {
      for (const u of usedToday) {
        await invoke("tick_word", { word: u.word, ticked: true });
      }
      mark.replaceWith(el("p", "report-summary", "Marked. They’ll return on schedule."));
      refreshCounts();
    });
    out.append(mark);
  }
});

/* ---- updates ---- */

async function offerUpdate() {
  const line = $("update-line");
  let update;
  try {
    update = await invoke("check_update");
  } catch {
    return; // offline or endpoint unreachable — try again next launch
  }
  if (!update) return;

  line.textContent = `v${update.version} available — update`;
  line.hidden = false;
  await tauri.event.listen("update-progress", (e) => {
    line.textContent = `updating… ${e.payload}%`;
  });

  let installing = false;
  line.addEventListener("click", async () => {
    if (installing) return;
    installing = true;
    line.disabled = true;
    line.textContent = "updating…";
    try {
      await invoke("install_update"); // relaunches on success
      line.textContent = "restarting…";
    } catch (err) {
      installing = false;
      line.disabled = false;
      line.textContent = "update failed — try again";
      console.error(err);
    }
  });
}

/* ---- boot ---- */

if (!invoke) {
  document.body.replaceChildren(
    el("p", "empty", "lexis needs to run inside the desktop app.")
  );
} else {
  renderBank();
  refreshCounts();
  addInput.focus();
  setTimeout(offerUpdate, 2500); // check quietly after the app settles
}
