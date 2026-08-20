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
import {
  storeGet,
  storeSet,
  storeRemove,
  storeKind,
  requestPersistentStorage,
} from "./store.js";

const BANK_KEY = "lexis-bank";
const HANDLE_KEY = "lexis-mirror-handle";
const SUBDIR = "lexis";

/**
 * The browser's half of the Syncthing mirror.
 *
 * A page cannot open a path, but since Chrome 86 it can be *handed* a
 * directory, and since Chrome 122 that grant can survive the session — so the
 * web build can be a real peer in the folder rather than a second-class one.
 * Safari and Firefox ship no picker at all; there the same envelope travels by
 * hand through export and import, which is why `manual` is unconditional.
 *
 * Two things differ from the desktop adapter, and both are the platform's
 * doing rather than ours:
 *
 *   - **Permission is a state, not a fact.** A stored handle can be `granted`
 *     (use it), `prompt` (dormant until the user clicks), or `denied`. Chrome
 *     also revokes a backgrounded tab's access, so `prompt` can appear
 *     mid-session; it is a reconnect button, not an error.
 *   - **There is no rename.** `move()` exists only inside the origin-private
 *     filesystem, so the desktop's temp-and-rename is unavailable. A writable
 *     stream is the equivalent: it stages into a `.crswap` file beside the
 *     target and swaps it in on `close()`, so a peer never reads half a bank.
 *     Syncthing may briefly see that staging file; it is transient and the
 *     mirror's own filename rules ignore it.
 */
function createDirectoryMirror() {
  const canPick = typeof globalThis.showDirectoryPicker === "function";
  let root = null; // the folder the user chose
  let permission = canPick ? "none" : "unsupported";

  /** Handles are structured-clone-only, so they cannot live in the localStorage fallback. */
  async function rememberHandle(handle) {
    try {
      if ((await storeKind()) !== "indexeddb") return false;
      await storeSet(HANDLE_KEY, handle);
      return true;
    } catch {
      // Private browsing, a quota refusal, or a handle that will not clone.
      // The folder still works for this session; it just will not come back.
      return false;
    }
  }

  function note(err) {
    // Chrome revokes a backgrounded tab's access. That is a reconnect, not a
    // dead folder, and the interface has to be able to tell them apart.
    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
      permission = "prompt";
    }
    throw err;
  }

  async function lexisDir() {
    if (!root) throw new Error("no folder has been chosen");
    try {
      return await root.getDirectoryHandle(SUBDIR, { create: true });
    } catch (err) {
      note(err);
    }
  }

  async function isSyncthingFolder(handle) {
    try {
      await handle.getDirectoryHandle(".stfolder");
      return true;
    } catch {
      return false; // only the chosen folder can be checked; there is no parent
    }
  }

  function describe(handle, syncthing) {
    return {
      root: handle.name,
      path: `${handle.name}/${SUBDIR}`,
      syncthing,
      remembered: permission === "granted",
    };
  }

  return {
    supported: canPick,
    automatic: canPick,
    manual: true,

    /** The live permission state, for the interface to render. */
    state() {
      return permission;
    },

    /** Nominate a folder. Must be called from a user gesture. */
    async choose() {
      if (!canPick) throw new Error("This browser cannot be given a folder.");
      root = await globalThis.showDirectoryPicker({
        id: "lexis-mirror",
        mode: "readwrite",
        startIn: "documents",
      });
      permission = "granted";
      const syncthing = await isSyncthingFolder(root);
      await root.getDirectoryHandle(SUBDIR, { create: true });
      const remembered = await rememberHandle(root);
      return { ...describe(root, syncthing), remembered };
    },

    /**
     * Reattaches the remembered folder at boot — reading the permission only,
     * never asking for it. Prompting needs a gesture we do not have here, and
     * a prompt fired on load is one a browser is entitled to ignore.
     */
    async attach() {
      if (!canPick) return { state: "unsupported" };

      // A handle already in hand wins over storage. It may have been chosen a
      // moment ago and never stored at all — handles cannot be kept where
      // IndexedDB is unavailable, and re-reading storage there would throw
      // away the folder the user just picked.
      if (root) {
        try {
          permission = await root.queryPermission({ mode: "readwrite" });
        } catch {
          permission = "prompt";
        }
        return { state: permission, info: describe(root, null) };
      }

      let handle;
      try {
        handle = await storeGet(HANDLE_KEY);
      } catch {
        handle = null;
      }
      if (!handle?.queryPermission) {
        // Nothing remembered at all — distinct from a folder we hold but may
        // not touch yet, which is a click away rather than a fresh setup.
        permission = "none";
        return { state: permission };
      }
      root = handle;
      try {
        permission = await handle.queryPermission({ mode: "readwrite" });
      } catch {
        permission = "prompt";
      }
      return { state: permission, info: describe(handle, null) };
    },

    /** Ask for the folder back. Must be called from a user gesture. */
    async grant() {
      if (!root?.requestPermission) return permission;
      try {
        permission = await root.requestPermission({ mode: "readwrite" });
      } catch {
        permission = "prompt";
      }
      return permission;
    },

    /** Forget the folder entirely — nothing readwrite-capable left behind. */
    async forget() {
      root = null;
      permission = canPick ? "none" : "unsupported";
      try {
        await storeRemove(HANDLE_KEY);
      } catch {
        /* best effort; the handle is unusable without the vault anyway */
      }
    },

    fs() {
      return {
        async list() {
          const dir = await lexisDir();
          const out = [];
          try {
            for await (const handle of dir.values()) {
              if (handle.kind !== "file") continue;
              const file = await handle.getFile();
              out.push({ name: handle.name, size: file.size, modified: file.lastModified });
            }
          } catch (err) {
            note(err);
          }
          return out;
        },

        async read(name) {
          const dir = await lexisDir();
          try {
            const handle = await dir.getFileHandle(name);
            return await (await handle.getFile()).text();
          } catch (err) {
            if (err?.name === "NotFoundError") return null;
            note(err);
          }
        },

        async write(name, text) {
          const dir = await lexisDir();
          let writable;
          try {
            const handle = await dir.getFileHandle(name, { create: true });
            writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
          } catch (err) {
            // Without this the staging file is left behind on every failure.
            try {
              await writable?.abort();
            } catch {
              /* already closed, or the stream never opened */
            }
            note(err);
          }
        },

        async remove(name) {
          const dir = await lexisDir();
          try {
            await dir.removeEntry(name);
          } catch (err) {
            if (err?.name === "NotFoundError") return;
            note(err);
          }
        },
      };
    },
  };
}

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

    mirror: createDirectoryMirror(),

    openUrl(url) {
      globalThis.open(url, "_blank", "noopener,noreferrer");
    },

    updates: { supported: false },
  };
}
