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
