/**
 * The web build's durable local store: a tiny async key–value box.
 *
 * Why this exists. Everything the browser copy keeps — the encrypted bank and
 * the encrypted vault — used to sit in `localStorage`, which browsers treat as
 * *best-effort*: it is the first thing evicted under storage pressure, and
 * Safari clears script-writable storage after roughly a week of not visiting
 * the site. For a word bank you might not open for a fortnight, that means the
 * local copy — and the saved token — can simply vanish. (Sync would refill the
 * bank from GitHub, but only once you re-enter the token and password.)
 *
 * So this store does two things localStorage alone can't:
 *
 *   1. It keeps data in IndexedDB, the store the persistence guarantee below is
 *      designed around — asynchronous, roomy, and structured-clone native, so
 *      the encrypted envelopes go in as objects rather than re-stringified JSON.
 *   2. It exposes `requestPersistentStorage()`, which asks the browser to mark
 *      this origin's storage as persistent — exempt from the eviction and the
 *      week-long ITP wipe described above.
 *
 * localStorage remains the fallback, under the *same keys*, for the places
 * IndexedDB won't open: some private-browsing modes, sandboxed contexts, and
 * the Node test runner (which has no IndexedDB but does shim localStorage). A
 * browser that loses IndexedDB still finds its data where it always was.
 */

const DB_NAME = "lexis";
const DB_VERSION = 1;
const STORE_NAME = "kv";

/**
 * Opens (creating on first run) the object store. Rejects — rather than
 * throwing — for every failure mode so the caller can fall back cleanly.
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) return reject(new Error("no IndexedDB"));
    let request;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      return reject(err);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the schema, step aside instead of wedging it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

function indexedDBBackend(db) {
  function run(mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, mode);
      } catch (err) {
        return reject(err); // e.g. the connection was closed by a versionchange
      }
      const request = work(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  return {
    kind: "indexeddb",
    get: (k) => run("readonly", (s) => s.get(k)).then((v) => (v === undefined ? null : v)),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)).then(() => undefined),
    remove: (k) => run("readwrite", (s) => s.delete(k)).then(() => undefined),
  };
}

/**
 * The fallback. Values are JSON-encoded so structured data round-trips exactly
 * as it does through IndexedDB's structured clone — and so a legacy install
 * finds its bytes under the identical key it wrote them to.
 */
function localStorageBackend() {
  return {
    kind: "localstorage",
    async get(k) {
      const raw = globalThis.localStorage?.getItem(k);
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async set(k, v) {
      globalThis.localStorage?.setItem(k, JSON.stringify(v));
    },
    async remove(k) {
      globalThis.localStorage?.removeItem(k);
    },
  };
}

/**
 * Resolves the backend once. IndexedDB if it opens; localStorage otherwise.
 * Memoised so every call shares a single database connection.
 */
let backendPromise = null;
function backend() {
  if (!backendPromise) {
    backendPromise = openDatabase()
      .then(indexedDBBackend)
      .catch(() => localStorageBackend());
  }
  return backendPromise;
}

/**
 * Moves a value written by an older, localStorage-only build into IndexedDB the
 * first time it is read, then clears the old copy so nothing decryptable is
 * left in two places. Runs only when IndexedDB is the live backend and the key
 * isn't there yet; on the fallback backend the data is already in place.
 */
async function adoptLegacy(store, key) {
  if (store.kind !== "indexeddb") return null;
  const raw = globalThis.localStorage?.getItem(key);
  if (raw == null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null; // unreadable — leave it and let the caller treat the key as empty
  }
  await store.set(key, value);
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    /* best-effort cleanup; IndexedDB now holds the authoritative copy */
  }
  return value;
}

export async function storeGet(key) {
  const store = await backend();
  const value = await store.get(key);
  if (value !== null) return value;
  return adoptLegacy(store, key);
}

export async function storeSet(key, value) {
  const store = await backend();
  await store.set(key, value);
}

export async function storeRemove(key) {
  const store = await backend();
  await store.remove(key);
  // Also drop any legacy copy, so a removed key can't reappear from localStorage.
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Which backend is in use — for diagnostics only. */
export async function storeKind() {
  return (await backend()).kind;
}

/**
 * Asks the browser to keep this origin's storage rather than evict it under
 * pressure. Returns `{ supported, persisted }`; never throws.
 *
 * Browsers grant this differently — Firefox may prompt, Chrome decides from
 * engagement heuristics, Safari from a permission — so a `false` here isn't a
 * failure, just "best-effort for now". Best called from a user gesture, when
 * the odds of a grant are highest.
 */
export async function requestPersistentStorage() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) return { supported: false, persisted: false };
  try {
    const already = storage.persisted ? await storage.persisted() : false;
    const persisted = already || (await storage.persist());
    return { supported: true, persisted };
  } catch {
    return { supported: true, persisted: false };
  }
}
