/**
 * Web adapter — storage in IndexedDB, encrypted under the session key.
 *
 * The browser copy is a cache of the synced bank, not a separate store: it
 * is written with the same password-derived key that protects the copy on
 * GitHub, so a shared or borrowed computer never leaves readable data behind
 * in the origin's storage.
 *
 * Where that copy lives is the store's concern (`./store.js`): IndexedDB when
 * the browser offers it, localStorage otherwise, and — either way — marked
 * persistent so the browser doesn't evict a bank you haven't opened in a while.
 */

import { encryptJSON, decryptJSON } from "../core/crypto.js";
import { storeGet, storeSet, storeRemove, requestPersistentStorage } from "./store.js";

const BANK_KEY = "lexis-bank";

export function createWebPlatform() {
  let key = null;

  return {
    kind: "web",

    /** Called once the password has been accepted; storage is inert until then. */
    setKey(k) {
      key = k;
    },

    storage: {
      async load() {
        if (!key) throw new Error("locked");
        const envelope = await storeGet(BANK_KEY);
        if (!envelope) return null;
        try {
          return await decryptJSON(key, envelope);
        } catch {
          // Written under a different password (or corrupt). Treat as empty
          // and let the next sync repopulate from GitHub — the authoritative
          // copy — rather than destroying anything here.
          console.warn("local cache could not be decrypted; falling back to sync");
          return null;
        }
      },
      async save(bank) {
        if (!key) throw new Error("locked");
        await storeSet(BANK_KEY, await encryptJSON(key, bank));
      },
    },

    async clearCache() {
      await storeRemove(BANK_KEY);
    },

    /**
     * Ask the browser to keep this origin's storage instead of evicting it.
     * Best invoked from a user gesture (unlock/setup), so this is called from
     * there rather than at boot.
     */
    requestPersistence() {
      return requestPersistentStorage();
    },

    // A browser has no filesystem to mirror into; the GitHub channel is the
    // web build's only path off the machine, and that is by design.
    mirror: { supported: false },

    /**
     * The key that seals AI settings at rest: the same password-derived
     * session key that already protects the bank cache and the conflict log.
     * A shared or borrowed computer therefore leaves the OpenRouter key just
     * as unreadable as everything else once the tab closes.
     */
    deviceKey: async () => {
      if (!key) throw new Error("locked");
      return key;
    },

    openUrl(url) {
      globalThis.open(url, "_blank", "noopener,noreferrer");
    },

    updates: { supported: false },
  };
}
