/**
 * Drives sync on behalf of the interface: one sync at a time, coalesced
 * while you work, and never so eager that typing a word turns into a commit
 * per keystroke.
 */

import { syncOnce } from "./sync.js";
import { mergeBanks } from "./merge.js";

const DEBOUNCE_MS = 4000;
const POLL_MS = 5 * 60 * 1000;

// When a sync fails on a bad network, waiting the full poll interval to try
// again leaves the two ends out of step for minutes. Instead retry quickly and
// back off — so a link that flickers back recovers in seconds, while a link
// that stays down doesn't hammer GitHub. Reset to the base on any success.
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60 * 1000;

export function createSyncController({ app, onStatus = () => {}, onApplied = () => {} }) {
  let key = null;
  let config = null;
  let running = false;
  let queued = false;
  let timer = null;
  let poll = null;
  let retryTimer = null;
  let backoff = 0;
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
      // The network came back (or never left): stand down the fast-retry ladder.
      clearTimeout(retryTimer);
      backoff = 0;
      status(syncedLabel(), "ok");
      onApplied(bank);
    } catch (err) {
      lastError = err;
      if (offline(err)) {
        // A transient network problem — schedule our own quick, backing-off
        // retry rather than waiting for the next poll.
        status("offline — will retry", "error");
        scheduleRetry();
      } else {
        // A real error (bad token, wrong password, oversized file): retrying
        // fast won't help, so leave it to the poll or the user.
        status(String(err.message ?? err), "error");
      }
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
    return (
      err?.offline === true ||
      err instanceof TypeError ||
      err?.name === "AbortError" ||
      /failed to fetch|networkerror/i.test(String(err?.message ?? err))
    );
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** backoff) + Math.random() * 1000;
    backoff++;
    retryTimer = setTimeout(run, delay);
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
      clearTimeout(retryTimer);
      backoff = 0;
      status("sync on", "idle");
      clearInterval(poll);
      poll = setInterval(() => run(), POLL_MS);
    },

    disable() {
      key = null;
      config = null;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearInterval(poll);
      backoff = 0;
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
