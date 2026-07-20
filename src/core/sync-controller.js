/**
 * Drives sync on behalf of the interface: one sync at a time, coalesced
 * while you work, and never so eager that typing a word turns into a commit
 * per keystroke.
 */

import { syncOnce } from "./sync.js";
import { mergeBanks } from "./merge.js";

const DEBOUNCE_MS = 4000;
const POLL_MS = 5 * 60 * 1000;

export function createSyncController({ app, onStatus = () => {}, onApplied = () => {} }) {
  let key = null;
  let config = null;
  let running = false;
  let queued = false;
  let timer = null;
  let poll = null;
  let lastError = null;

  function status(text, kind = "idle") {
    onStatus({ text, kind, enabled: Boolean(key) });
  }

  async function run() {
    if (!key || !config) return;
    if (running) {
      queued = true; // fold this request into the run already in flight
      return;
    }
    running = true;
    try {
      const { bank } = await syncOnce({
        config,
        key,
        localBank: app.getBank(),
        onStatus: (t) => status(t, "busy"),
      });
      // A sync takes a second or two, and the user keeps working during it.
      // Merging the result against the *current* bank rather than assigning it
      // means a word added mid-flight isn't discarded by the swap. The merge is
      // idempotent, so this costs nothing when nothing changed; any edit it
      // picks up has already queued its own push via schedule().
      await app.replaceBank(mergeBanks(app.getBank(), bank));
      lastError = null;
      status(syncedLabel(), "ok");
      onApplied(bank);
    } catch (err) {
      lastError = err;
      status(offline(err) ? "offline — will retry" : String(err.message ?? err), "error");
    } finally {
      running = false;
      if (queued) {
        queued = false;
        run();
      }
    }
  }

  function syncedLabel() {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    return `synced ${hh}:${mm}`;
  }

  function offline(err) {
    return err instanceof TypeError || /failed to fetch|networkerror/i.test(String(err.message ?? err));
  }

  return {
    get enabled() {
      return Boolean(key && config);
    },
    get lastError() {
      return lastError;
    },

    enable(k, cfg) {
      key = k;
      config = cfg;
      status("sync on", "idle");
      clearInterval(poll);
      poll = setInterval(() => run(), POLL_MS);
    },

    disable() {
      key = null;
      config = null;
      clearTimeout(timer);
      clearInterval(poll);
      status("sync off", "idle");
    },

    /** Called after every local change; collapses a burst into one push. */
    schedule() {
      if (!key) return;
      clearTimeout(timer);
      status("changes pending…", "busy");
      timer = setTimeout(run, DEBOUNCE_MS);
    },

    /** Sync right now — on launch, on focus, or from the button. */
    async now() {
      clearTimeout(timer);
      await run();
    },
  };
}
