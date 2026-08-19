/**
 * One pass over every channel lexis syncs through.
 *
 * There are two, and they are deliberately independent: a private GitHub
 * repository, and a Syncthing folder on the local disk. Neither is the
 * authority. Both hold the same encrypted envelope, sealed with the same
 * password-derived key, and either one alone can rebuild the other — which is
 * the point of having two. A machine with no internet still syncs across the
 * desk; a machine on a network where Syncthing cannot see its peer still syncs
 * through GitHub.
 *
 * The pass, in order, and the order matters:
 *
 *   1. **Read the folder first.** Peers there are the freshest thing available
 *      (seconds old, not up to five minutes) and they are free to read. Merging
 *      them before touching the network means whatever we then push to GitHub
 *      already carries the other machine's work — one commit instead of two.
 *   2. **Then GitHub**, which pulls, merges, and pushes under its own SHA
 *      precondition exactly as it always has.
 *   3. **Then write the folder back**, whatever happened in step 2. A failed
 *      network must not cost the local mirror its update; that is the whole
 *      reason for having a second channel.
 *
 * A failure in either channel is reported, never fatal to the other. The
 * merged bank is returned regardless, because the caller has to save it either
 * way — losing a merge because a push failed would be the one genuinely
 * unrecoverable outcome here.
 *
 * Conflicts are detected between each pair of copies as they are folded
 * together (see `conflict.js`) and returned for the interface to show. They
 * are attributed by *channel* — "this device", "the Syncthing folder",
 * "GitHub" — which is as fine-grained as sequential folding can honestly be.
 */

import { syncOnce } from "./sync.js";
import { mergeBanks } from "./merge.js";
import { migrate } from "./bank.js";
import { detectConflicts } from "./conflict.js";

export const HERE = "this device";
export const FOLDER = "the Syncthing folder";
export const GITHUB = "GitHub";

/**
 * @param mirror  a `createMirror()` channel, or `null` when the folder is off
 * @returns `{ bank, pushed, mirrored, conflicts, retire, notes, error, mirrorError }`
 *
 * `retire` names the Syncthing conflict copies whose contents are now in
 * `bank`. The caller removes them *after* saving `bank` durably — never
 * before, so the data always exists somewhere else first.
 */
export async function reconcile({ config, key, localBank, mirror, onStatus = () => {} }) {
  let bank = migrate(localBank);
  const conflicts = [];
  const notes = [];
  const retire = [];
  let mirrorError = null;
  let mirrored = false;

  if (mirror) {
    onStatus("reading the folder…");
    try {
      const { peers, conflicts: copies, stale, unreadable } = await mirror.pull(key);

      for (const peer of peers) {
        conflicts.push(...detectConflicts(bank, peer.bank, { mine: HERE, theirs: FOLDER }));
        bank = mergeBanks(bank, peer.bank);
      }

      // A Syncthing conflict copy is merged like any other peer — the data in
      // it is real work someone did — and only then queued for removal.
      for (const copy of copies) {
        conflicts.push(...detectConflicts(bank, copy.bank, { mine: HERE, theirs: FOLDER }));
        bank = mergeBanks(bank, copy.bank);
        retire.push(copy.name);
      }

      for (const s of stale) {
        notes.push(
          `${s.name} is ${s.days} days old and was left alone — restore it by hand if you want it back.`
        );
      }
      for (const u of unreadable) notes.push(`${u.name} could not be read (${u.reason}).`);
    } catch (err) {
      mirrorError = err;
      notes.push(`The Syncthing folder could not be read (${String(err?.message ?? err)}).`);
    }
  }

  let pushed = false;
  let error = null;
  try {
    const result = await syncOnce({
      config,
      key,
      localBank: bank,
      onStatus,
      onRemote: (remoteBank, mineBank) => {
        conflicts.push(...detectConflicts(mineBank, remoteBank, { mine: HERE, theirs: GITHUB }));
      },
    });
    bank = result.bank;
    pushed = result.pushed;
  } catch (err) {
    // Held, not thrown: the folder still needs writing, and the caller still
    // needs the merged bank. The controller rethrows this once both are done.
    error = err;
  }

  if (mirror) {
    try {
      mirrored = await mirror.push(key, bank);
    } catch (err) {
      mirrorError ??= err;
      notes.push(`The Syncthing folder could not be written (${String(err?.message ?? err)}).`);
      retire.length = 0; // nothing was made durable there; keep the copies
    }
  }

  return { bank, pushed, mirrored, conflicts, retire, notes, error, mirrorError };
}
