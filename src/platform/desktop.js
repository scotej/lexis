/**
 * Desktop adapter — storage through Tauri, which keeps the bank as a plain
 * JSON file in the app data directory exactly as it always has.
 *
 * The desktop app stays usable without a password: its data is local, and
 * the password only comes into play when you turn sync on.
 */

const tauri = globalThis.__TAURI__;
const invoke = tauri?.core?.invoke;

export function isDesktop() {
  return Boolean(invoke);
}

/**
 * Whatever shape the IPC bridge hands back for a Rust `Vec<u8>` — an array of
 * numbers today, possibly a buffer tomorrow — as bytes.
 */
function toBytes(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return Uint8Array.from(raw);
}

/**
 * Imports raw key material as a non-extractable AES-GCM CryptoKey. The bytes
 * go straight from the bridge into Web Crypto: no base64 detour, so the key
 * never exists as an immutable JS string that can't be dropped on demand.
 */
function importRawAesKey(raw) {
  return crypto.subtle.importKey("raw", toBytes(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function createDesktopPlatform() {
  // Fetched once from Rust on first use and held only in this closure: the
  // raw key material crosses the IPC bridge exactly once per launch.
  let deviceKeyPromise = null;
  const loadDeviceKey = () => {
    if (!deviceKeyPromise) {
      // A *rejection* must not be cached. One failed invoke would otherwise
      // disable AI for the rest of the session, with no way back but a
      // restart; forgetting it lets the next attempt try again.
      deviceKeyPromise = invoke("ai_device_key")
        .then(importRawAesKey)
        .catch((err) => {
          deviceKeyPromise = null;
          throw err;
        });
    }
    return deviceKeyPromise;
  };

  return {
    kind: "desktop",

    /**
     * The AES-GCM key that seals AI settings on this device. The desktop has
     * no master password by design, so the Rust side supplies a random
     * per-device key kept in a 0600 file beside the bank — see
     * `src-tauri/src/device_key.rs` for the honest threat model.
     */
    deviceKey() {
      return loadDeviceKey();
    },

    storage: {
      async load() {
        const json = await invoke("load_bank");
        if (!json) return null;
        try {
          return JSON.parse(json);
        } catch {
          // A corrupt file shouldn't wedge the app; start clean rather than
          // refusing to open. The old file stays on disk until the next save.
          console.error("bank.json is not valid JSON — starting empty");
          return null;
        }
      },
      async save(bank) {
        await invoke("save_bank", { json: JSON.stringify(bank, null, 2) });
      },
    },

    /**
     * The Syncthing mirror's filesystem. Every byte crossing these calls is
     * already encrypted (see core/mirror.js); the backend only moves them.
     *
     * The shape matches the browser adapter's deliberately, even where the
     * desktop has nothing to do. A native app is simply handed the filesystem,
     * so `grant` and `forget` are constants here and `state` never leaves
     * "granted" — but the interface can then drive both hosts through one set
     * of calls instead of asking which one it is talking to.
     */
    mirror: {
      supported: true,
      automatic: true,
      manual: true,

      state: () => "granted",
      grant: async () => "granted",
      forget: async () => {},

      /** Validates a typed path and prepares the subfolder inside it. */
      choose: (root) => invoke("mirror_check", { root }),

      /** Confirms a remembered folder is still there, without disturbing it. */
      async attach(root) {
        try {
          return { state: "granted", info: await invoke("mirror_check", { root }) };
        } catch (err) {
          return { state: "missing", reason: String(err?.message ?? err) };
        }
      },

      fs(root) {
        return {
          list: () => invoke("mirror_list", { root }),
          read: (name) => invoke("mirror_read", { root, name }),
          write: (name, contents) => invoke("mirror_write", { root, name, contents }),
          remove: (name) => invoke("mirror_remove", { root, name }),
        };
      },
    },

    openUrl(url) {
      tauri?.opener?.openUrl(url).catch(() => {});
    },

    updates: {
      supported: true,
      check: () => invoke("check_update"),
      install: () => invoke("install_update"),
      onProgress: (fn) => tauri.event.listen("update-progress", (e) => fn(e.payload)),
    },
  };
}
