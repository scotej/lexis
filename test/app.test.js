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

function legacyAdverb(word, adjective, today) {
  const value = entry(word, today);
  value.senses = [
    { pos: "adverb", def: `In a ${adjective} manner.`, example: null },
  ];
  value.synonyms = [{ word: `${adjective}ly`, score: 2 }];
  return value;
}

function fakeLexicon(log = [], failWord = null) {
  return {
    async fetchDefinition(word) {
      log.push(`definition:${word}`);
      if (word === failWord) throw new Error("lookup failed");
      return {
        phonetic: null,
        senses: [{ pos: "noun", def: `${word} definition`, example: null }],
        source: "test",
        source_url: "https://example.invalid",
      };
    },
    async fetchSynonyms(word) {
      log.push(`synonyms:${word}`);
      return [];
    },
  };
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

test("opening Today clarifies and persists definitions stored by older releases", async () => {
  const today = todayISO();
  const original = legacyAdverb("poignantly", "poignant", today);
  original.times_used = 4;
  original.srs = { ...original.srs, reps: 3, interval: 10, last: today };
  const initial = bankModel.emptyBank();
  initial.words = [original];
  const storage = new MemoryStorage(initial);
  const calls = [];
  let changes = 0;
  const app = createApp(
    storage,
    () => {
      changes += 1;
    },
    {
      async clarifyDerivativeDefinitions(word, dictionary) {
        calls.push(word);
        return {
          ...dictionary,
          senses: dictionary.senses.map((sense) => ({
            ...sense,
            def: "Depending on context: movingly or touchingly.",
          })),
          source: "Wiktionary · clarification via Datamuse",
          clarification_url: "https://api.datamuse.com/words?ml=poignantly",
        };
      },
    }
  );
  await app.init();

  const view = await app.todayList({ clarifyDefinitions: true });
  const upgraded = bankModel.find(app.getBank(), "poignantly");

  assert.deepEqual(calls, ["poignantly"]);
  assert.equal(view.items[0].def, "Depending on context: movingly or touchingly.");
  assert.equal(upgraded.senses[0].def, view.items[0].def);
  assert.equal(upgraded.source, "Wiktionary · clarification via Datamuse");
  assert.match(upgraded.clarification_url, /ml=poignantly/);
  assert.equal(upgraded.times_used, 4);
  assert.equal(upgraded.srs.reps, 3);
  assert.deepEqual(upgraded.synonyms, original.synonyms);
  assert.equal(storage.value.words[0].senses[0].def, view.items[0].def);
  assert.equal(storage.saves, 1, "the new checklist and clarification persist atomically");
  assert.equal(changes, 1);
});

test("counting Today does not look up legacy definitions before the view is opened", async () => {
  const today = todayISO();
  const initial = bankModel.emptyBank();
  initial.words = [legacyAdverb("poignantly", "poignant", today)];
  const storage = new MemoryStorage(initial);
  let calls = 0;
  const app = createApp(storage, undefined, {
    async clarifyDerivativeDefinitions() {
      calls += 1;
      throw new Error("should not run");
    },
  });
  await app.init();

  const view = await app.todayList();

  assert.equal(calls, 0);
  assert.equal(view.items[0].def, "In a poignant manner.");
});

test("Today only clarifies eligible words in the visible rotation", async () => {
  const today = todayISO();
  const initial = essayBank();
  const zenith = bankModel.find(initial, "zenith");
  Object.assign(zenith, legacyAdverb("zenith", "zenithal", today));
  const storage = new MemoryStorage(initial);
  const calls = [];
  const app = createApp(storage, undefined, {
    async clarifyDerivativeDefinitions(word, dictionary) {
      calls.push(word);
      return {
        ...dictionary,
        senses: [{ ...dictionary.senses[0], def: "At or near a zenith." }],
      };
    },
  });
  await app.init();

  let view = await app.todayList({ clarifyDefinitions: true });
  assert.equal(view.items.some((item) => item.word === "zenith"), false);
  assert.deepEqual(calls, []);

  await app.refreshTodayList();
  view = await app.todayList({ clarifyDefinitions: true });
  assert.equal(view.items.some((item) => item.word === "zenith"), true);
  assert.deepEqual(calls, ["zenith"]);
  assert.equal(bankModel.find(app.getBank(), "zenith").senses[0].def, "At or near a zenith.");
});

test("a failed legacy clarification leaves Today usable with its stored definition", async () => {
  const today = todayISO();
  const initial = bankModel.emptyBank();
  initial.words = [legacyAdverb("poignantly", "poignant", today)];
  const storage = new MemoryStorage(initial);
  const app = createApp(storage, undefined, {
    async clarifyDerivativeDefinitions() {
      throw new Error("offline");
    },
  });
  await app.init();

  const view = await app.todayList({ clarifyDefinitions: true });

  assert.equal(view.items[0].def, "In a poignant manner.");
  assert.equal(storage.saves, 1, "the checklist still persists while offline");
});

test("a pending clarification cannot overwrite a newer synced definition", async () => {
  const today = todayISO();
  const initial = bankModel.emptyBank();
  initial.words = [legacyAdverb("poignantly", "poignant", today)];
  const storage = new MemoryStorage(initial);
  let lookupStarted;
  let releaseLookup;
  const started = new Promise((resolve) => {
    lookupStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const app = createApp(storage, undefined, {
    async clarifyDerivativeDefinitions(word, dictionary) {
      lookupStarted();
      await gate;
      return {
        ...dictionary,
        senses: [{ ...dictionary.senses[0], def: "A stale clarification." }],
      };
    },
  });
  await app.init();

  const pending = app.todayList({ clarifyDefinitions: true });
  await started;
  const remote = structuredClone(initial);
  remote.words[0].senses[0].def = "In a deeply moving way.";
  remote.words[0].definition_updated = Date.now() + 1000;
  await app.mergeBank(remote);
  releaseLookup();
  const view = await pending;

  assert.equal(view.items[0].def, "In a deeply moving way.");
  assert.equal(bankModel.find(app.getBank(), "poignantly").senses[0].def, view.items[0].def);
});

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

test("multi-word input normalizes, de-duplicates, and persists as one transaction", async () => {
  const storage = new MemoryStorage(bankModel.emptyBank());
  const lookups = [];
  let changes = 0;
  const app = createApp(
    storage,
    () => {
      changes += 1;
    },
    fakeLexicon(lookups)
  );
  await app.init();

  const result = await app.addWord("  Deontic   modality\tdeontic  ");

  assert.deepEqual(app.listWords("word-asc").map((word) => word.word), ["deontic", "modality"]);
  assert.deepEqual(lookups, [
    "definition:deontic",
    "synonyms:deontic",
    "definition:modality",
    "synonyms:modality",
  ]);
  assert.equal(storage.saves, 1);
  assert.equal(changes, 1);
  assert.equal(result.word, "deontic · modality");
  assert.deepEqual(result.batch.map((word) => word.word), ["deontic", "modality"]);
});

test("multi-word input skips words already in the bank without re-fetching them", async () => {
  const initial = bankModel.emptyBank();
  initial.words.push(entry("deontic", todayISO()));
  const storage = new MemoryStorage(initial);
  const lookups = [];
  const app = createApp(storage, () => {}, fakeLexicon(lookups));
  await app.init();

  const result = await app.addWord("deontic modality");

  assert.deepEqual(app.listWords("word-asc").map((word) => word.word), ["deontic", "modality"]);
  assert.deepEqual(lookups, ["definition:modality", "synonyms:modality"]);
  assert.equal(storage.saves, 1);
  assert.equal(result.word, "modality");
});

test("an invalid token rejects a multi-word submission before any lookup or save", async () => {
  const storage = new MemoryStorage(bankModel.emptyBank());
  const lookups = [];
  const app = createApp(storage, () => {}, fakeLexicon(lookups));
  await app.init();

  await assert.rejects(() => app.addWord("deontic modality2"), /single word/);

  assert.deepEqual(lookups, []);
  assert.deepEqual(app.listWords(), []);
  assert.equal(storage.saves, 0);
});

test("a failed lookup leaves a multi-word submission completely unapplied", async () => {
  const storage = new MemoryStorage(bankModel.emptyBank());
  const lookups = [];
  const app = createApp(storage, () => {}, fakeLexicon(lookups, "modality"));
  await app.init();

  await assert.rejects(() => app.addWord("deontic modality"), /couldn’t add “modality”: lookup failed/);

  // A word's definition and its synonyms go out together, so the failing word
  // still costs both requests. One wasted call on the word that broke the
  // batch buys every other word its two round trips in parallel.
  assert.deepEqual(lookups, [
    "definition:deontic",
    "synonyms:deontic",
    "definition:modality",
    "synonyms:modality",
  ]);
  assert.deepEqual(app.listWords(), []);
  assert.equal(storage.saves, 0);
});

test("a failed save leaves no in-memory partial multi-word addition", async () => {
  const storage = new MemoryStorage(bankModel.emptyBank());
  const app = createApp(storage, () => {}, fakeLexicon());
  await app.init();
  storage.failNext = true;

  await assert.rejects(() => app.addWord("deontic modality"), /save failed/);

  assert.deepEqual(app.listWords(), []);
  assert.equal(storage.saves, 0);
});

test("overlapping add requests preserve request order without blocking unrelated mutations", async () => {
  const initial = bankModel.emptyBank();
  initial.words.push(entry("alpha", todayISO()));
  const storage = new MemoryStorage(initial);
  const lookups = [];
  let lookupStartedResolve;
  let releaseLookup;
  const lookupStarted = new Promise((resolve) => {
    lookupStartedResolve = resolve;
  });
  const lookupGate = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const lexicon = {
    async fetchDefinition(word) {
      lookups.push(`definition:${word}`);
      if (word === "deontic") {
        lookupStartedResolve();
        await lookupGate;
      }
      return {
        phonetic: null,
        senses: [{ pos: "noun", def: `${word} definition`, example: null }],
        source: "test",
        source_url: "https://example.invalid",
      };
    },
    async fetchSynonyms(word) {
      lookups.push(`synonyms:${word}`);
      return [];
    },
  };
  const app = createApp(storage, () => {}, lexicon);
  await app.init();

  const first = app.addWord("deontic");
  await lookupStarted;
  const second = app.addWord("deontic");
  const secondRejected = assert.rejects(second, /already in your bank/);
  await Promise.resolve();

  assert.deepEqual(
    lookups,
    ["definition:deontic", "synonyms:deontic"],
    "the later add must not start its lookup early"
  );

  await app.deleteWord("alpha");
  assert.equal(bankModel.find(app.getBank(), "alpha"), null, "unrelated mutations must not wait on the lookup");

  releaseLookup();
  const added = await first;
  await secondRejected;

  assert.equal(added.word, "deontic");
  assert.deepEqual(lookups, ["definition:deontic", "synonyms:deontic"]);
  assert.ok(bankModel.find(app.getBank(), "deontic"));
  assert.equal(storage.saves, 2);
});

test("a later same-word delete wins over an in-flight add", async () => {
  const storage = new MemoryStorage(bankModel.emptyBank());
  const lookups = [];
  let lookupStartedResolve;
  let releaseLookup;
  const lookupStarted = new Promise((resolve) => {
    lookupStartedResolve = resolve;
  });
  const lookupGate = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const lexicon = {
    async fetchDefinition(word) {
      lookups.push(`definition:${word}`);
      lookupStartedResolve();
      await lookupGate;
      return {
        phonetic: null,
        senses: [{ pos: "noun", def: `${word} definition`, example: null }],
        source: "test",
        source_url: "https://example.invalid",
      };
    },
    async fetchSynonyms(word) {
      lookups.push(`synonyms:${word}`);
      return [];
    },
  };
  const app = createApp(storage, () => {}, lexicon);
  await app.init();

  const adding = app.addWord("deontic");
  const rejected = assert.rejects(adding, /removed after this add was requested/);
  await lookupStarted;

  const remote = bankModel.emptyBank();
  remote.words.push(entry("deontic", todayISO()));
  await app.mergeBank(remote);
  assert.ok(bankModel.find(app.getBank(), "deontic"));

  await app.deleteWord("deontic");
  assert.equal(bankModel.find(app.getBank(), "deontic"), null);
  assert.ok(app.getBank().deleted.some((item) => item.word === "deontic"));

  releaseLookup();
  await rejected;

  assert.deepEqual(lookups, ["definition:deontic", "synonyms:deontic"]);
  assert.equal(bankModel.find(app.getBank(), "deontic"), null);
  assert.ok(app.getBank().deleted.some((item) => item.word === "deontic"));
  assert.equal(storage.saves, 2, "the cancelled add must not overwrite the merge and delete");
});

test("a delete supersedes an add that is still waiting behind an earlier add", async () => {
  const storage = new MemoryStorage(bankModel.emptyBank());
  const lookups = [];
  let firstLookupStartedResolve;
  let releaseFirstLookup;
  const firstLookupStarted = new Promise((resolve) => {
    firstLookupStartedResolve = resolve;
  });
  const firstLookupGate = new Promise((resolve) => {
    releaseFirstLookup = resolve;
  });
  const lexicon = {
    async fetchDefinition(word) {
      lookups.push(`definition:${word}`);
      if (word === "alpha") {
        firstLookupStartedResolve();
        await firstLookupGate;
      }
      return {
        phonetic: null,
        senses: [{ pos: "noun", def: `${word} definition`, example: null }],
        source: "test",
        source_url: "https://example.invalid",
      };
    },
    async fetchSynonyms(word) {
      lookups.push(`synonyms:${word}`);
      return [];
    },
  };
  const app = createApp(storage, () => {}, lexicon);
  await app.init();

  const first = app.addWord("alpha");
  await firstLookupStarted;
  const queued = app.addWord("deontic");
  const queuedRejected = assert.rejects(queued, /removed after this add was requested/);

  const remote = bankModel.emptyBank();
  remote.words.push(entry("deontic", todayISO()));
  await app.mergeBank(remote);
  await app.deleteWord("deontic");

  releaseFirstLookup();
  await first;
  await queuedRejected;

  assert.deepEqual(lookups, ["definition:alpha", "synonyms:alpha"]);
  assert.ok(bankModel.find(app.getBank(), "alpha"));
  assert.equal(bankModel.find(app.getBank(), "deontic"), null);
  assert.ok(app.getBank().deleted.some((item) => item.word === "deontic"));
  assert.equal(storage.saves, 3, "merge, delete, and the unrelated first add should be the only saves");
});
