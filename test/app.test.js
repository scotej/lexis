import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/core/app.js";
import * as bankModel from "../src/core/bank.js";
import { todayISO } from "../src/core/srs.js";

class MemoryStorage {
  constructor(value) {
    this.value = structuredClone(value);
    this.saves = 0;
    this.failNext = false;
    this.saveGate = null;
  }

  async load() {
    return structuredClone(this.value);
  }

  async save(value) {
    if (this.saveGate) {
      const gate = this.saveGate;
      this.saveGate = null;
      gate.startedResolve();
      await gate.wait;
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error("save failed");
    }
    this.value = structuredClone(value);
    this.saves += 1;
  }

  deferNextSave() {
    let startedResolve;
    let release;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    this.saveGate = { startedResolve, wait };
    return { started, release };
  }
}

function entry(word, today) {
  return bankModel.newWord(
    word,
    {
      phonetic: null,
      senses: [{ pos: "noun", def: `${word} definition`, example: null }],
      source: "test",
      source_url: "https://example.invalid",
    },
    [],
    today
  );
}

function essayBank() {
  const today = todayISO();
  const names = [
    "alpha",
    "bravo",
    "candid",
    "demise",
    "eloquent",
    "fervent",
    "gluttony",
    "hubris",
    "irony",
    "justice",
    "zenith",
  ];
  const bank = bankModel.emptyBank();
  bank.words = names.map((name) => entry(name, today));
  return bank;
}

test("logging an essay counts off-list words separately and practises today's matches", async () => {
  const storage = new MemoryStorage(essayBank());
  let changes = 0;
  const app = createApp(storage, () => {
    changes += 1;
  });
  await app.init();

  const result = await app.logEssay("Alpha alpha shapes this demise. Zenith follows.");
  const alpha = bankModel.find(app.getBank(), "alpha");
  const demise = bankModel.find(app.getBank(), "demise");
  const zenith = bankModel.find(app.getBank(), "zenith");

  assert.equal(result.logged_words, 3);
  assert.equal(result.logged_uses, 4);
  assert.equal(result.practised_today, 2);
  assert.equal(alpha.essay_uses, 2);
  assert.equal(demise.essay_uses, 1);
  assert.equal(zenith.essay_uses, 1);
  assert.equal(alpha.times_used, 1);
  assert.equal(demise.times_used, 1);
  assert.equal(zenith.times_used, 0, "an off-list match must not alter its SRS practice count");
  assert.equal(storage.saves, 1, "the entire essay log is persisted atomically");
  assert.equal(changes, 1);
});

test("each explicit essay log adds occurrences but cannot double-practise a day", async () => {
  const storage = new MemoryStorage(essayBank());
  const app = createApp(storage);
  await app.init();

  await app.logEssay("Alpha alpha.");
  await app.logEssay("Alpha alpha.");
  const alpha = bankModel.find(app.getBank(), "alpha");
  assert.equal(alpha.essay_uses, 4, "two deliberate logs are cumulative");
  assert.equal(alpha.times_used, 1, "today's SRS practice remains capped at once per day");
});

test("an essay with no bank matches creates no extra write", async () => {
  const storage = new MemoryStorage(essayBank());
  const app = createApp(storage);
  await app.init();
  await app.todayList();
  storage.saves = 0;

  const result = await app.logEssay("No matching vocabulary appears here.");
  assert.equal(result.logged_words, 0);
  assert.equal(result.logged_uses, 0);
  assert.equal(storage.saves, 0);
});

test("a failed essay save leaves no partial counts to double on retry", async () => {
  const storage = new MemoryStorage(essayBank());
  const app = createApp(storage);
  await app.init();
  storage.failNext = true;

  await assert.rejects(() => app.logEssay("Alpha."), /save failed/);
  let alpha = bankModel.find(app.getBank(), "alpha");
  assert.equal(alpha.essay_uses, 0);
  assert.equal(alpha.times_used, 0);

  await app.logEssay("Alpha.");
  alpha = bankModel.find(app.getBank(), "alpha");
  assert.equal(alpha.essay_uses, 1);
  assert.equal(alpha.times_used, 1);
  assert.equal(storage.saves, 1);
});

test("a failed manual refresh leaves the visible selection unchanged", async () => {
  const storage = new MemoryStorage(essayBank());
  const app = createApp(storage);
  await app.init();
  await app.todayList();
  storage.saves = 0;
  const before = structuredClone(app.getBank().today);
  storage.failNext = true;

  await assert.rejects(() => app.refreshTodayList(), /save failed/);
  assert.deepEqual(app.getBank().today, before);

  const refreshed = await app.refreshTodayList();
  assert.notDeepEqual(refreshed.items.map((item) => item.word), before.words);
  assert.equal(storage.saves, 1);
});

test("a slow essay save cannot overwrite a tick requested while it is pending", async () => {
  const storage = new MemoryStorage(essayBank());
  const app = createApp(storage);
  await app.init();
  const gate = storage.deferNextSave();

  const log = app.logEssay("Zenith.");
  await gate.started;
  const tick = app.tickWord("alpha", true);
  gate.release();
  await Promise.all([log, tick]);

  assert.equal(bankModel.find(app.getBank(), "zenith").essay_uses, 1);
  assert.equal(bankModel.find(app.getBank(), "alpha").times_used, 1);
  assert.equal(storage.saves, 2);
});

test("a sync merge queued behind an essay save preserves both changes", async () => {
  const initial = essayBank();
  const storage = new MemoryStorage(initial);
  const app = createApp(storage);
  await app.init();
  const remote = structuredClone(initial);
  remote.words.push(entry("quasar", todayISO()));
  const gate = storage.deferNextSave();

  const log = app.logEssay("Zenith.");
  await gate.started;
  const merge = app.mergeBank(remote);
  gate.release();
  await Promise.all([log, merge]);

  assert.equal(bankModel.find(app.getBank(), "zenith").essay_uses, 1);
  assert.ok(bankModel.find(app.getBank(), "quasar"));
});

test("listing a sorted bank is presentation-only", async () => {
  const storage = new MemoryStorage(essayBank());
  const app = createApp(storage);
  await app.init();

  const words = app.listWords("word-desc").map((word) => word.word);
  assert.equal(words[0], "zenith");
  assert.equal(words.at(-1), "alpha");
  assert.equal(storage.saves, 0);
});
