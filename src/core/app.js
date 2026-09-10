/**
 * The application service — everything the interface can ask lexis to do.
 *
 * This is the layer that used to live in Rust as Tauri commands. It now runs
 * identically in the desktop webview and in the browser; the only thing that
 * differs between them is the `storage` adapter handed in here. That is what
 * makes "the same features on both ends" a structural fact rather than a
 * promise to keep two implementations in step.
 */

import * as bankModel from "./bank.js";
import {
  archiveWordHistory,
  markExistingReviewHistory,
  markReviewHistoryCurrent,
  normalizeActivityArchive,
} from "./activity.js";
import { analyze } from "./essay.js";
import {
  clarifyDerivativeDefinitions,
  derivedFrom,
  fetchDefinition,
  fetchSynonyms,
  misspellingOf,
  needsDefinitionRepair,
  needsDerivativeClarification,
  NOT_FOUND,
} from "./dict.js";
import { mergeBanks } from "./merge.js";
import { todayISO } from "./srs.js";
import { isGrade } from "./srs.js";

/**
 * How many words of one batch are looked up at the same time.
 *
 * Three: enough that pasting a list of words no longer costs one round trip
 * per word laid end to end, and few enough to stay a well-mannered guest on
 * three free public APIs that ask for nothing in return.
 */
const LOOKUP_CONCURRENCY = 3;

function migrateBank(raw) {
  const migrated = bankModel.migrate(raw);
  migrated.activity_archive = normalizeActivityArchive(raw?.activity_archive);
  markExistingReviewHistory(migrated);
  return migrated;
}

function reviewEventCount(word) {
  return Object.keys(word?.review_events ?? {}).length;
}

/**
 * @param storage  `{ load(): Promise<object|null>, save(bank): Promise<void> }`
 * @param onChange called after every mutation, so the caller can schedule a sync
 * @param services optional dictionary overrides for deterministic tests
 */
export function createApp(storage, onChange = () => {}, services = {}) {
  let bank = bankModel.emptyBank();
  let mutationTail = Promise.resolve();
  let additionTail = Promise.resolve();
  const deleteGenerations = new Map();
  const lookupDefinition = services.fetchDefinition ?? fetchDefinition;
  const lookupSynonyms = services.fetchSynonyms ?? fetchSynonyms;
  const clarifyDefinition =
    services.clarifyDerivativeDefinitions ?? clarifyDerivativeDefinitions;
  /**
   * The two optional AI helpers, and the question that decides whether either
   * is worth asking.
   *
   * `aiReady` is asked *before* anything is done on their behalf, not just
   * before they are called. The interface installs the two functions once, at
   * boot, and only learns whether there is a key some moments later — so a
   * helper that is merely present is no evidence at all that it can answer,
   * and a keyless device would otherwise pay for a root-word lookup whose only
   * consumer immediately returns null. Absent, the answer is yes: a caller
   * that supplies a helper and no predicate means what it supplied.
   */
  const suggestSpelling = services.suggestSpelling ?? null;
  const writeDerivedDefinition = services.writeDerivedDefinition ?? null;
  const aiReady = services.aiReady ?? (() => true);
  const canRescue = (helper) => Boolean(helper) && aiReady() !== false;

  /**
   * Storage and sync are asynchronous, but bank mutations must commit in the
   * order they were requested. Without this queue, a slow essay save can
   * finish after a newer tick/sync and install its stale snapshot over it.
   */
  function enqueueMutation(action) {
    const result = mutationTail.then(action, action);
    mutationTail = result.catch(() => {});
    return result;
  }

  /**
   * Word additions also contain network lookups. Reserve their request order in
   * a separate queue so a later fast lookup cannot overtake an earlier one,
   * while unrelated bank mutations remain free to commit during network I/O.
   */
  function enqueueAddition(action) {
    const result = additionTail.then(action, action);
    additionTail = result.catch(() => {});
    return result;
  }

  async function persist() {
    await storage.save(bank);
    onChange(bank);
  }

  /** Save a candidate first, then expose it in memory only after success. */
  async function persistReplacement(next) {
    await storage.save(next);
    bank = next;
    onChange(bank);
  }

  function cloneBank() {
    // The bank is deliberately JSON-only because it is encrypted and synced as
    // JSON. Cloning gives multi-field mutations transactional save semantics.
    return JSON.parse(JSON.stringify(bank));
  }

  function dictionaryFields(entry) {
    return {
      phonetic: entry.phonetic ?? null,
      senses: entry.senses,
      source: entry.source,
      source_url: entry.source_url,
      clarification_url: entry.clarification_url ?? null,
    };
  }

  function newEssayLogId() {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Parses a submission into normalized, de-duplicated words without weakening
   * the bank model's single-word invariant. Invalid tokens reject the entire
   * submission before any network request or storage mutation starts.
   */
  function normalizeWordInput(input) {
    const raw = (input ?? "").trim();
    if (!raw) bankModel.normalize(raw); // preserves the established empty-input error
    const words = [];
    const seen = new Set();
    for (const token of raw.split(/\s+/u)) {
      const word = bankModel.normalize(token);
      if (seen.has(word)) continue;
      seen.add(word);
      words.push(word);
    }
    return words;
  }

  function alreadyStoredError(words) {
    if (words.length === 1) return new Error(`“${words[0]}” is already in your bank`);
    return new Error("those words are already in your bank");
  }

  function deleteGeneration(word) {
    return deleteGenerations.get(word) ?? 0;
  }

  function markDeleteRequested(word) {
    const key = typeof word === "string" ? word.trim().toLowerCase() : word;
    deleteGenerations.set(key, deleteGeneration(key) + 1);
  }

  /**
   * Whether `word` has been deleted since this add was requested.
   *
   * The baseline is a snapshot of *every* generation, not only the words that
   * were typed, because a word can be corrected into the batch after the fact:
   * "recieve" is banked as "receive", and the delete that has to win may be a
   * delete of "receive". A word with no generation recorded has never been
   * deleted, which is generation zero — reading a missing key as "nothing to
   * check" is what made this guard inert for exactly the word it was added
   * for.
   */
  function supersededWord(word, generations) {
    return deleteGeneration(word) !== (generations.get(word) ?? 0);
  }

  /**
   * The dictionary entry, synonyms, and — if the word needed rescuing on the
   * way — what was done about it.
   *
   * Two things can be wrong with a word by the time it reaches a dictionary,
   * and neither is the student's fault for typing it:
   *
   *   - **Nobody has heard of it.** Usually a typo. When the failure is
   *     specifically "no such entry" (never a timeout, never a 503 — those
   *     are the network having a bad day, and a word must not be rewritten
   *     on that evidence) the model is asked which word was meant, and the
   *     suggestion is only used if a dictionary then recognises it. So the
   *     correction is checked against the same source everything else here
   *     comes from, rather than believed.
   *
   *   - **The entry is a signpost.** "recieve" resolves happily to
   *     "Misspelling of receive", and Wiktionary has already done the
   *     diagnosis; taking it costs nothing and asks no model.
   *
   * Whatever happens, the word the student typed is carried alongside the one
   * that was banked, so nothing is substituted silently.
   */
  async function resolveWord(typed, notify) {
    // Both questions at once, as before — settled rather than raced, because
    // the definition's failure is now a question rather than an answer, and a
    // synonym request left unobserved while that question is asked would be an
    // unhandled rejection.
    const [definition, thesaurus] = await Promise.allSettled([
      lookupDefinition(typed),
      lookupSynonyms(typed),
    ]);

    let word = typed;
    let dict = null;
    let corrected = null;

    if (definition.status === "fulfilled") {
      dict = definition.value;
      const meant = misspellingOf(typed, dict);
      if (meant) {
        const real = await lookupDefinition(meant).catch(() => null);
        if (real) {
          word = meant;
          dict = real;
          corrected = { typed, word: meant, by: "dictionary" };
        }
      }
    } else {
      const failure = definition.reason;
      if (failure?.code !== NOT_FOUND || !canRescue(suggestSpelling)) throw failure;
      const suggestion = await Promise.resolve()
        .then(() => suggestSpelling(typed, notify))
        .catch(() => null);
      const meant = String(suggestion?.word ?? suggestion ?? "").trim().toLowerCase();
      if (!meant || meant === typed) throw failure;
      // If the model's word is no more findable than the typed one, the honest
      // thing to report is still the original failure.
      const real = await lookupDefinition(meant).catch(() => null);
      if (!real) throw failure;
      word = meant;
      dict = real;
      corrected = { typed, word: meant, by: "ai" };
    }

    // The typo's synonyms belong to the typo. A corrected word asks again.
    let synonyms;
    if (word === typed) {
      if (thesaurus.status === "rejected") throw thesaurus.reason;
      synonyms = thesaurus.value;
    } else {
      synonyms = await lookupSynonyms(word);
    }

    const explanation = await explained(word, dict, notify);
    return { word, dict: explanation.dict, synonyms, corrected, written: explanation.written };
  }

  /**
   * A definition that only names another word, replaced with one that says
   * what this word means.
   *
   * The model is not asked what the word means from memory — it is handed the
   * human-written entry for the root and asked to do the grammar, which is the
   * one step Wiktionary left out. The result has to survive the same test that
   * sent it there: if it comes back as another signpost, the editor-written
   * entry stays. So does it if anything at all goes wrong; this is an upgrade,
   * never a dependency.
   */
  /**
   * An entry for `root` that actually says something, following one pointer if
   * the first one only points again.
   *
   * The British spellings a student here types do this constantly: "realised"
   * points at "realise", whose whole entry is "Non-Oxford British standard
   * spelling of realize." Handing *that* to a model as its source material is
   * asking it to work from nothing while telling it to stay inside the
   * meanings given — which is the invitation to answer from memory that this
   * whole path exists to refuse. One hop is enough; a chain longer than that
   * is not a derivation any student needs explaining.
   */
  async function meaningfulEntry(root) {
    for (let hop = 0; hop < 2; hop++) {
      const entry = await lookupDefinition(root).catch(() => null);
      if (!entry?.senses?.length) return null;
      const onwards = derivedFrom(entry);
      if (!onwards) return { root, entry };
      if (onwards.root === root) return null;
      root = onwards.root;
    }
    return null;
  }

  /** Whether the model simply handed the unhelpful gloss back in its own words. */
  function echoesGloss(dict, rewritten) {
    const plain = (text) =>
      String(text ?? "")
        .toLowerCase()
        .replace(/[.!]+$/, "")
        .trim();
    const original = new Set((dict.senses ?? []).map((sense) => plain(sense.def)));
    return rewritten.senses.some((sense) => original.has(plain(sense.def)));
  }

  async function explained(word, dict, notify) {
    if (!canRescue(writeDerivedDefinition)) return { dict, written: null };
    const derived = needsDefinitionRepair(word, dict);
    if (!derived) return { dict, written: null };

    try {
      // The root's own entry is the whole point: without it there is nothing
      // to write *from*, and a model asked anyway would answer from memory —
      // which is the one thing this feature promises not to do.
      const source = await meaningfulEntry(derived.root);
      if (!source) return { dict, written: null };
      const written = await writeDerivedDefinition(
        {
          word,
          root: source.root,
          gloss: derived.gloss,
          rootSenses: source.entry.senses,
        },
        notify
      );
      const senses = (written?.senses ?? [])
        .map((sense) => ({
          pos: String(sense?.pos ?? "").trim().toLowerCase(),
          def: String(sense?.def ?? "").trim(),
          example: null,
        }))
        .filter((sense) => sense.def);
      if (!senses.length) return { dict, written: null };

      const rewritten = {
        ...dict,
        senses,
        source: `${dict.source} · written out by AI from “${source.root}”`,
        source_url: source.entry.source_url ?? dict.source_url,
      };
      // A reply that is itself a signpost, or that simply hands the gloss
      // back, has not answered — and the editor's text is better than either.
      if (derivedFrom(rewritten) || echoesGloss(dict, rewritten)) {
        return { dict, written: null };
      }
      return { dict: rewritten, written: { word, root: source.root } };
    } catch {
      return { dict, written: null };
    }
  }

  function additionSupersededError(word) {
    return new Error(`couldn’t add “${word}”: it was removed after this add was requested`);
  }

  return {
    async init() {
      return enqueueMutation(async () => {
        const raw = (await storage.load()) ?? bankModel.emptyBank();
        bank = migrateBank(raw);
        return bank;
      });
    },

    /** The in-memory bank — used by the sync layer as the local side of a merge. */
    getBank() {
      return bank;
    },

    /** Waits for pending local writes before giving sync a stable snapshot. */
    async getBankSnapshot() {
      return enqueueMutation(async () => cloneBank());
    },

    /** Replaces the bank wholesale after a sync, then persists it. */
    async replaceBank(next) {
      return enqueueMutation(async () => {
        const replacement = migrateBank(next);
        await storage.save(replacement);
        bank = replacement;
        return bank;
      });
    },

    /** Merges a completed network sync against the latest queued local state. */
    async mergeBank(next) {
      return enqueueMutation(async () => {
        const merged = mergeBanks(bank, next);
        await storage.save(merged);
        bank = merged;
        return bank;
      });
    },

    /**
     * Adds one or more whitespace-separated words.
     *
     * Addition *requests* are still serialized in request order — a later add
     * cannot overtake an earlier one — but the lookups inside one batch are
     * not. A word's definition and its synonyms come from different hosts and
     * have nothing to say to each other, so they go out together; and a few
     * words are looked up at a time rather than one, because five words used
     * to mean five round trips end to end while every host sat idle for four
     * of them. LOOKUP_CONCURRENCY is what keeps that a few requests rather
     * than a burst.
     *
     * Each word now stands or falls on its own. A batch used to be one
     * transaction in the strong sense: one unknown word and the other nine
     * were thrown away too, which is a defensible rule for a database and an
     * infuriating one for a list of words typed by hand — the fix for a typo
     * was to retype everything. So the words that resolved are added together
     * in a single save, and the ones that did not are named. Nothing is
     * half-added: the save is still one write of one bank, and a word is
     * either in it or reported.
     *
     * A word nobody can find is usually a word that was mistyped, and a word
     * whose only definition is "plural of gas" is not a definition at all.
     * Both are handled in `resolveWord`, and both are reported back so the
     * interface can say what happened rather than quietly substituting
     * something the student did not type.
     */
    async addWord(input, { onProgress } = {}) {
      const requested = normalizeWordInput(input);
      const deleteState = new Map(deleteGenerations);

      return enqueueAddition(async () => {
        const pending = requested.filter((word) => !bankModel.find(bank, word));
        if (!pending.length) throw alreadyStoredError(requested);

        const prepared = new Array(pending.length);
        const failures = new Array(pending.length);

        let cursor = 0;
        const worker = async () => {
          while (cursor < pending.length) {
            const at = cursor++;
            const typed = pending[at];
            // A delete requested since this add was asked for wins, and it
            // wins before the network is troubled on that word's behalf.
            if (supersededWord(typed, deleteState)) {
              failures[at] = additionSupersededError(typed);
              continue;
            }
            try {
              prepared[at] = await resolveWord(typed, onProgress ?? null);
            } catch (err) {
              failures[at] =
                requested.length === 1
                  ? err
                  : new Error(`couldn’t add “${typed}”: ${String(err.message ?? err)}`);
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(LOOKUP_CONCURRENCY, pending.length) }, worker)
        );

        return enqueueMutation(async () => {
          // Sync or another mutation may have completed while the network
          // requests above were in flight. Re-check against a transactional
          // clone and add only candidates that are still absent.
          const next = cloneBank();
          const today = todayISO();
          const added = [];
          const corrected = [];
          const written = [];
          const failed = [];

          for (let at = 0; at < pending.length; at++) {
            const typed = pending[at];
            if (failures[at]) {
              failed.push({ word: typed, message: String(failures[at].message ?? failures[at]) });
              continue;
            }
            const candidate = prepared[at];
            // A local delete requested after this add must win even if a sync
            // made the word visible while its lookup was running. Without this
            // guard, insertWord would clear the newer tombstone and resurrect
            // the word.
            if (
              supersededWord(typed, deleteState) ||
              supersededWord(candidate.word, deleteState)
            ) {
              const error = additionSupersededError(typed);
              failed.push({ word: typed, message: String(error.message) });
              failures[at] = error;
              continue;
            }
            if (bankModel.find(next, candidate.word)) {
              const error = candidate.corrected
                ? new Error(
                    `“${typed}” is a misspelling of “${candidate.word}”, which is already in your bank`
                  )
                : alreadyStoredError([candidate.word]);
              failed.push({ word: typed, message: String(error.message) });
              failures[at] = error;
              continue;
            }
            const entry = bankModel.newWord(
              candidate.word,
              candidate.dict,
              candidate.synonyms,
              today
            );
            bankModel.insertWord(next, entry, today);
            added.push(entry);
            if (candidate.corrected) corrected.push(candidate.corrected);
            if (candidate.written) written.push(candidate.written);
          }

          // Nothing survived: report the earliest failure, exactly as when a
          // batch was all-or-nothing — and as a single word always has.
          if (!added.length) {
            throw failures.find(Boolean) ?? alreadyStoredError(requested);
          }
          await persistReplacement(next);

          // Preserve the established single-word return contract. For a genuine
          // batch, return a presentation-compatible summary while keeping the
          // real entries available to callers that want them.
          const summary =
            added.length === 1
              ? { ...added[0] }
              : { ...added[0], word: added.map((entry) => entry.word).join(" · "), batch: added };
          summary.added = added;
          summary.corrected = corrected;
          summary.written = written;
          summary.failed = failed;
          return summary;
        });
      });
    },

    listWords(order) {
      return bankModel.listWords(bank, order);
    },

    getSettings() {
      return bankModel.settingsView(bank);
    },

    async setDailyTarget(target) {
      return enqueueMutation(async () => {
        const next = cloneBank();
        if (bankModel.setDailyTarget(next, target, todayISO())) {
          await persistReplacement(next);
        }
        return bankModel.settingsView(bank);
      });
    },

    /**
     * Reinstates a copy of a word the merge discarded. Committed as a normal
     * edit, so it propagates through GitHub and the Syncthing folder alike.
     */
    async restoreWord(record) {
      return enqueueMutation(async () => {
        const next = cloneBank();
        const entry = bankModel.reinstateWord(next, record);
        await persistReplacement(next);
        return entry;
      });
    },

    /**
     * Reinstates only the dictionary half of a discarded copy.
     *
     * Definitions carry their own merge clock, so a definition conflict can be
     * resolved without touching the schedule and practice count — which may
     * well have been kept from the *other* device. Restoring the whole record
     * here would silently undo that.
     */
    async restoreDefinition(record) {
      return enqueueMutation(async () => {
        const next = cloneBank();
        const changed = bankModel.updateDefinition(next, record.word, dictionaryFields(record));
        if (changed) await persistReplacement(next);
        return changed;
      });
    },

    async deleteWord(word) {
      // Record intent before entering the mutation queue. An addition can be
      // waiting on network I/O (or behind another addition) when this is called;
      // request order, not eventual save timing, decides which operation wins.
      markDeleteRequested(word);
      return enqueueMutation(async () => {
        const entry = bankModel.find(bank, word);
        if (entry) bank.activity_archive = archiveWordHistory(bank.activity_archive, entry);
        bankModel.removeWord(bank, word);
        await persist();
      });
    },

    async todayList({ clarifyDefinitions = false } = {}) {
      if (!clarifyDefinitions) {
        return enqueueMutation(async () => {
          // Only write when the list genuinely changed; this is called on every
          // count refresh, and persisting unconditionally would queue a sync.
          if (bankModel.ensureTodayList(bank, todayISO())) await persist();
          return bankModel.todayView(bank);
        });
      }

      // Build a candidate list from a clone, then release the mutation queue
      // while the independent lexical requests run in parallel. A slow network
      // must not prevent a tick, sync, or essay save from committing.
      const candidates = await enqueueMutation(async () => {
        const next = cloneBank();
        const listChanged = bankModel.ensureTodayList(next, todayISO());
        const entries = next.today.words
          .map((word) => bankModel.find(next, word))
          .filter((entry) => entry && needsDerivativeClarification(entry))
          .map((entry) => {
            const dictionary = dictionaryFields(entry);
            return {
              word: entry.word,
              dictionary,
              fingerprint: JSON.stringify(dictionary),
            };
          });

        if (!entries.length) {
          if (listChanged) await persistReplacement(next);
          return null;
        }
        return entries;
      });

      if (!candidates) return bankModel.todayView(bank);

      const clarified = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            return {
              ...candidate,
              dictionary: await clarifyDefinition(candidate.word, candidate.dictionary),
            };
          } catch {
            // Clarification is an opportunistic upgrade. Offline Today remains
            // fully usable with the original human-edited definition.
            return null;
          }
        })
      );

      return enqueueMutation(async () => {
        const next = cloneBank();
        let changed = bankModel.ensureTodayList(next, todayISO());
        const visible = new Set(next.today.words);
        for (const result of clarified) {
          if (!result || !visible.has(result.word)) continue;
          const current = bankModel.find(next, result.word);
          // A sync may have supplied a newer definition while the lookup was
          // pending. Never overwrite it with a result based on stale senses.
          if (
            !current ||
            !needsDerivativeClarification(current) ||
            JSON.stringify(dictionaryFields(current)) !== result.fingerprint
          ) {
            continue;
          }
          changed = bankModel.updateDefinition(next, result.word, result.dictionary) || changed;
        }
        if (changed) await persistReplacement(next);
        return bankModel.todayView(bank);
      });
    },

    async refreshTodayList() {
      return enqueueMutation(async () => {
        const next = cloneBank();
        if (bankModel.refreshTodayList(next, todayISO())) await persistReplacement(next);
        return bankModel.todayView(bank);
      });
    },

    async expandTodayList() {
      return enqueueMutation(async () => {
        const next = cloneBank();
        if (bankModel.expandTodayList(next, todayISO())) await persistReplacement(next);
        return bankModel.todayView(bank);
      });
    },

    async tickWord(word, ticked) {
      return enqueueMutation(async () => {
        const before = reviewEventCount(bankModel.find(bank, word));
        const view = bankModel.tick(bank, word, ticked, todayISO());
        const entry = bankModel.find(bank, word);
        if (entry && reviewEventCount(entry) > before) markReviewHistoryCurrent(entry);
        await persist();
        return view;
      });
    },

    dueWords() {
      return bankModel.dueWords(bank, todayISO());
    },

    async gradeWord(word, grade) {
      if (!isGrade(grade)) throw new Error("unknown grade");
      return enqueueMutation(async () => {
        const entry = bankModel.grade(bank, word, grade, todayISO());
        markReviewHistoryCurrent(entry);
        await persist();
        return entry;
      });
    },

    analyzeEssay(text) {
      const today = todayISO();
      const bankWords = bank.words.map((w) => w.word);
      const todayWords =
        bank.today && bank.today.date === today ? bank.today.words : [];
      return analyze(text, bankWords, todayWords);
    },

    /**
     * Records one deliberate essay import. Every matched bank-word occurrence
     * contributes to its essay-use total; matches on today's list also keep the
     * existing scheduling behaviour and are marked as practised.
     */
    async logEssay(text) {
      return enqueueMutation(async () => {
        const today = todayISO();
        const next = cloneBank();
        const listChanged = bankModel.ensureTodayList(next, today);
        const bankWords = next.words.map((w) => w.word);
        const report = analyze(text, bankWords, next.today?.words ?? []);
        const logged = bankModel.logEssayUses(next, report.used, newEssayLogId());
        const usedToday = report.used.filter((usage) => usage.in_today);
        for (const usage of usedToday) {
          const before = reviewEventCount(bankModel.find(next, usage.word));
          bankModel.tick(next, usage.word, true, today);
          const entry = bankModel.find(next, usage.word);
          if (entry && reviewEventCount(entry) > before) markReviewHistoryCurrent(entry);
        }
        if (listChanged || logged.length > 0) await persistReplacement(next);
        return {
          report,
          logged_words: logged.length,
          logged_uses: logged.reduce((sum, item) => sum + item.count, 0),
          practised_today: usedToday.length,
        };
      });
    },
  };
}