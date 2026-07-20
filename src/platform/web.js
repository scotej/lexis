/**
 * Web adapter — storage in localStorage, encrypted under the session key.
 *
 * The browser copy is a cache of the synced bank, not a separate store: it
 * is written with the same password-derived key that protects the copy on
 * GitHub, so a shared or borrowed computer never leaves readable data behind
 * in the origin's storage.
 */

import { encryptJSON, decryptJSON } from "../core/crypto.js";

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
        const raw = localStorage.getItem(BANK_KEY);
        if (!raw) return null;
        try {
          return await decryptJSON(key, JSON.parse(raw));
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
        localStorage.setItem(BANK_KEY, JSON.stringify(await encryptJSON(key, bank)));
      },
    },

    clearCache() {
      localStorage.removeItem(BANK_KEY);
    },

    openUrl(url) {
      globalThis.open(url, "_blank", "noopener,noreferrer");
    },

    updates: { supported: false },
  };
}
