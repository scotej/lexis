/**
 * Desktop adapter — storage through Tauri, which keeps the bank as a plain
 * JSON file in the app data directory exactly as it always has.
 *
 * The desktop app stays usable without a password: its data is local, and
 * the password only comes into play when you turn sync on.
 */

import { fromBase64, toBase64 } from "../core/crypto.js";

const tauri = globalThis.__TAURI__;
const invoke = tauri?.core?.invoke;

export function isDesktop() {
  return Boolean(invoke);
}

/**
 * Imports raw key material as a non-extractable AES-GCM CryptoKey. The
 * bytes themselves are never exposed to callers.
 */
function importRawAesKey(rawB64) {
  return crypto.subtle.importKey(
    "raw",
    fromBase64(rawB64),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
}

export function createDesktopPlatform() {
  // Fetched once from Rust on first use and held only in this closure: the
  // raw key material crosses the IPC bridge exactly once per launch.
  let deviceKeyPromise = null;
  const loadDeviceKey = () => {
    if (!deviceKeyPromise) {
      deviceKeyPromise = invoke("ai_device_key").then(toBase64);
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
      return loadDeviceKey().then(importRawAesKey);
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
     * The Syncthing mirror's filesystem. Only the desktop build has one, which
     * is why it lives here rather than in the shared core: the four calls are
     * scoped to a directory the user nominates, and every byte crossing them is
     * already encrypted (see core/mirror.js).
     */
    mirror: {
      supported: true,
      check: (root) => invoke("mirror_check", { root }),
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
