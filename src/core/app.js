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
  fetchDefinition,
  fetchSynonyms,
  needsDerivativeClarification,
} from "./dict.js";
import { mergeBanks } from "./merge.js";
import { todayISO } from "./srs.js";
import { isGrade } from "./srs.js";

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

  function supersededAddition(words, generations) {
    return words.find((word) => deleteGeneration(word) !== generations.get(word)) ?? null;
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
     * Adds one or more whitespace-separated words as one transaction.
     *
     * Addition requests are serialized in request order, and each batch's
     * lookups stay sequential to avoid bursting the public dictionary APIs. The
     * bank is not touched until every requested new word has been resolved, so
     * a bad lookup or failed save cannot leave a half-added batch behind.
     */
    async addWord(input) {
      const requested = normalizeWordInput(input);
      const deleteState = new Map(
        requested.map((word) => [word, deleteGeneration(word)])
      );

      return enqueueAddition(async () => {
        const pending = requested.filter((word) => !bankModel.find(bank, word));
        if (!pending.length) throw alreadyStoredError(requested);

        const staleBeforeLookup = supersededAddition(pending, deleteState);
        if (staleBeforeLookup) throw additionSupersededError(staleBeforeLookup);

        const prepared = [];
        for (const word of pending) {
          const stale = supersededAddition(pending, deleteState);
          if (stale) throw additionSupersededError(stale);
          try {
            const dict = await lookupDefinition(word);
            const synonyms = await lookupSynonyms(word);
            prepared.push({ word, dict, synonyms });
          } catch (err) {
            if (requested.length === 1) throw err;
            throw new Error(`couldn’t add “${word}”: ${String(err.message ?? err)}`);
          }
        }

        return enqueueMutation(async () => {
          // A local delete requested after this add must win even if a sync made
          // the word visible while its lookup was running. Without this guard,
          // insertWord would clear the newer tombstone and resurrect the word.
          const stale = supersededAddition(pending, deleteState);
          if (stale) throw additionSupersededError(stale);

          // Sync or another mutation may have completed while the network
          // requests above were in flight. Re-check against a transactional
          // clone and add only candidates that are still absent.
          const next = cloneBank();
          const today = todayISO();
          const added = [];
          for (const candidate of prepared) {
            if (bankModel.find(next, candidate.word)) continue;
            const entry = bankModel.newWord(candidate.word, candidate.dict, candidate.synonyms, today);
            bankModel.insertWord(next, entry, today);
            added.push(entry);
          }

          if (!added.length) throw alreadyStoredError(requested);
          await persistReplacement(next);

          // Preserve the established single-word return contract. For a genuine
          // batch, return a presentation-compatible summary while keeping the
          // real entries available to callers that want them.
          if (added.length === 1) return added[0];
          return {
            ...added[0],
            word: added.map((entry) => entry.word).join(" · "),
            batch: added,
          };
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