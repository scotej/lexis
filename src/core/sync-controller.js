/**
 * Drives sync on behalf of the interface: one pass at a time, coalesced
 * while you work, and never so eager that typing a word turns into a commit
 * per keystroke.
 *
 * A pass covers both channels — the GitHub repository and, when it is turned
 * on, the Syncthing folder (see `reconcile.js`). The controller stays free of
 * anything platform-specific: the folder arrives as an already-built mirror
 * object, because the browser has no filesystem to build one from.
 */

import { reconcile } from "./reconcile.js";

const DEBOUNCE_MS = 4000;
const POLL_MS = 5 * 60 * 1000;

/**
 * The folder is on the local disk and costs one directory listing to check, so
 * it is checked far more often than GitHub — a word added on the machine next
 * to you shows up in seconds rather than minutes. Nothing is decrypted and no
 * sync runs unless the listing actually changed.
 */
const MIRROR_POLL_MS = 8000;

// When a sync fails on a bad network, waiting the full poll interval to try
// again leaves the two ends out of step for minutes. Instead retry quickly and
// back off — so a link that flickers back recovers in seconds, while a link
// that stays down doesn't hammer GitHub. Reset to the base on any success.
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60 * 1000;

export function createSyncController({
  app,
  onStatus = () => {},
  onApplied = () => {},
  onConflicts = () => {},
  onNotes = () => {},
}) {
  let key = null;
  let config = null;
  let mirror = null;
  let running = false;
  let queued = false;
  let inFlight = null;
  let timer = null;
  let poll = null;
  let mirrorPoll = null;
  let retryTimer = null;
  let backoff = 0;
  let lastError = null;

  function status(text, kind = "idle") {
    onStatus({ text, kind, enabled: Boolean(key) });
  }

  /**
   * Runs passes until nothing more is queued, and hands back a promise that
   * covers the lot.
   *
   * The coalescing matters to callers, not just to GitHub: `now()` is awaited
   * by the interface before it redraws, and a bare "folded into the run in
   * flight" return would have it report the folder's state a second before
   * the write that changes it.
   */
  function run() {
    if (!key || !config) return Promise.resolve();
    if (running) {
      queued = true; // fold this request into the run already in flight
      return inFlight ?? Promise.resolve();
    }
    running = true;
    inFlight = (async () => {
      do {
        queued = false;
        await pass();
      } while (queued && key && config);
    })().finally(() => {
      running = false;
    });
    return inFlight;
  }

  async function pass() {
    let outcome = null;
    try {
      const localBank = await app.getBankSnapshot();
      outcome = await reconcile({
        config,
        key,
        localBank,
        mirror,
        onStatus: (t) => status(t, "busy"),
      });

      // A sync takes a second or two, and the user keeps working during it.
      // Merging the result against the *current* bank rather than assigning it
      // means a word added mid-flight isn't discarded by the swap. The merge is
      // idempotent, so this costs nothing when nothing changed; any edit it
      // picks up has already queued its own push via schedule().
      const bank = await app.mergeBank(outcome.bank);

      // Only now — with the merged bank saved locally *and* written back to
      // our own file in the folder — is a Syncthing conflict copy safe to
      // remove. Two durable copies before the third goes.
      if (mirror && outcome.retire.length) await mirror.retire(outcome.retire);

      if (outcome.conflicts.length) onConflicts(outcome.conflicts);
      onNotes(outcome.notes);
      onApplied(bank);

      // The folder is written even when GitHub fails, so the error is raised
      // only after everything that could still succeed has.
      if (outcome.error) throw outcome.error;

      lastError = null;
      // The network came back (or never left): stand down the fast-retry ladder.
      clearTimeout(retryTimer);
      backoff = 0;
      status(syncedLabel(outcome), "ok");
    } catch (err) {
      lastError = err;
      if (offline(err)) {
        // A transient network problem — schedule our own quick, backing-off
        // retry rather than waiting for the next poll. When the folder took
        // the change, say so: the work is already on its way to the other
        // machine and "offline" alone would be misleading.
        status(
          outcome?.mirrored
            ? "saved to the folder — GitHub offline, will retry"
            : "offline — will retry",
          outcome?.mirrored ? "ok" : "error"
        );
        scheduleRetry();
      } else {
        // A real error (bad token, wrong password, oversized file): retrying
        // fast won't help, so leave it to the poll or the user.
        status(String(err.message ?? err), "error");
      }
    }
  }

  function syncedLabel(outcome) {
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    if (outcome?.mirrorError) return `synced ${hh}:${mm} — folder unavailable`;
    return `synced ${hh}:${mm}${mirror ? " · folder" : ""}`;
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

  /**
   * Watches the folder for the other machine's work. Cheap by construction:
   * one listing, compared against the last one, and a full pass only if it
   * moved. Our own file is excluded from that comparison (see `mirror.js`) —
   * counting it would make every push trigger the next poll for ever.
   */
  function watchMirror() {
    clearInterval(mirrorPoll);
    if (!mirror) return;
    mirrorPoll = setInterval(async () => {
      if (!key || running) return;
      try {
        if (await mirror.changed()) run();
      } catch {
        // The folder is unreachable — an unmounted drive, a folder the user
        // moved. The GitHub poll carries on regardless.
      }
    }, MIRROR_POLL_MS);
  }

  return {
    get enabled() {
      return Boolean(key && config);
    },
    get lastError() {
      return lastError;
    },
    get mirroring() {
      return Boolean(mirror);
    },
    get mirror() {
      return mirror;
    },

    enable(k, cfg, m = null) {
      key = k;
      config = cfg;
      if (mirror && mirror !== m) mirror.stop();
      mirror = m;
      clearTimeout(retryTimer);
      backoff = 0;
      status("sync on", "idle");
      clearInterval(poll);
      poll = setInterval(() => run(), POLL_MS);
      watchMirror();
    },

    /** Turns the folder on or off without disturbing the GitHub channel. */
    setMirror(m) {
      // Retire the outgoing channel so a pass still in flight cannot write to
      // a folder the user has just left.
      if (mirror && mirror !== m) mirror.stop();
      mirror = m;
      watchMirror();
    },

    disable() {
      key = null;
      config = null;
      mirror?.stop();
      mirror = null;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearInterval(poll);
      clearInterval(mirrorPoll);
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
