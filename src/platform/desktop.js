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

export function createDesktopPlatform() {
  return {
    kind: "desktop",

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
