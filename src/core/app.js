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

/**
 * @param storage  `{ load(): Promise<object|null>, save(bank): Promise<void> }`
 * @param onChange called after every mutation, so the caller can schedule a sync
 * @param services optional dictionary overrides for deterministic tests
 */
export function createApp(storage, onChange = () => {}, services = {}) {
  let bank = bankModel.emptyBank();
  let mutationTail = Promise.resolve();
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

  return {
    async init() {
      return enqueueMutation(async () => {
        bank = bankModel.migrate((await storage.load()) ?? bankModel.emptyBank());
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
        const replacement = bankModel.migrate(next);
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

    async addWord(word) {
      const w = bankModel.normalize(word);
      if (bankModel.find(bank, w)) {
        throw new Error(`“${w}” is already in your bank`);
      }
      const dict = await lookupDefinition(w);
      const synonyms = await lookupSynonyms(w);
      return enqueueMutation(async () => {
        // Another lookup for the same word may have completed while the
        // network requests above were in flight.
        if (bankModel.find(bank, w)) {
          throw new Error(`“${w}” is already in your bank`);
        }
        const today = todayISO();
        const entry = bankModel.newWord(w, dict, synonyms, today);
        bankModel.insertWord(bank, entry, today);
        await persist();
        return entry;
      });
    },

    listWords(order) {
      return bankModel.listWords(bank, order);
    },

    async deleteWord(word) {
      return enqueueMutation(async () => {
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

    async tickWord(word, ticked) {
      return enqueueMutation(async () => {
        const view = bankModel.tick(bank, word, ticked, todayISO());
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
          bankModel.tick(next, usage.word, true, today);
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
