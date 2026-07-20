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
import { fetchDefinition, fetchSynonyms } from "./dict.js";
import { todayISO } from "./srs.js";
import { isGrade } from "./srs.js";

/**
 * @param storage  `{ load(): Promise<object|null>, save(bank): Promise<void> }`
 * @param onChange called after every mutation, so the caller can schedule a sync
 */
export function createApp(storage, onChange = () => {}) {
  let bank = bankModel.emptyBank();

  async function persist() {
    await storage.save(bank);
    onChange(bank);
  }

  return {
    async init() {
      bank = bankModel.migrate((await storage.load()) ?? bankModel.emptyBank());
      return bank;
    },

    /** The in-memory bank — used by the sync layer as the local side of a merge. */
    getBank() {
      return bank;
    },

    /** Replaces the bank wholesale after a sync, then persists it. */
    async replaceBank(next) {
      bank = bankModel.migrate(next);
      await storage.save(bank);
      return bank;
    },

    async addWord(word) {
      const w = bankModel.normalize(word);
      if (bankModel.find(bank, w)) {
        throw new Error(`“${w}” is already in your bank`);
      }
      const dict = await fetchDefinition(w);
      const synonyms = await fetchSynonyms(w);
      const today = todayISO();
      const entry = bankModel.newWord(w, dict, synonyms, today);
      bankModel.insertWord(bank, entry, today);
      await persist();
      return entry;
    },

    listWords() {
      return bankModel.listWords(bank);
    },

    async deleteWord(word) {
      bankModel.removeWord(bank, word);
      await persist();
    },

    async todayList() {
      // Only write when the list genuinely changed; this is called on every
      // render, and persisting unconditionally would queue a sync each time.
      if (bankModel.ensureTodayList(bank, todayISO())) await persist();
      return bankModel.todayView(bank);
    },

    async tickWord(word, ticked) {
      const view = bankModel.tick(bank, word, ticked, todayISO());
      await persist();
      return view;
    },

    dueWords() {
      return bankModel.dueWords(bank, todayISO());
    },

    async gradeWord(word, grade) {
      if (!isGrade(grade)) throw new Error("unknown grade");
      const entry = bankModel.grade(bank, word, grade, todayISO());
      await persist();
      return entry;
    },

    analyzeEssay(text) {
      const today = todayISO();
      const bankWords = bank.words.map((w) => w.word);
      const todayWords =
        bank.today && bank.today.date === today ? bank.today.words : [];
      return analyze(text, bankWords, todayWords);
    },
  };
}
