/**
 * The local mirror: the same encrypted bank, in a folder Syncthing carries.
 *
 * GitHub is a fine backstop but it is someone else's computer, it needs a
 * token, and it needs the internet. Two machines sitting on the same desk
 * already have a faster, more private path between them — a Syncthing folder
 * — so lexis writes there too. Nothing about the GitHub channel changes; this
 * is a second, independent copy, and either one alone is enough to rebuild the
 * other. On a LAN it is also *much* quicker: the mirror is polled every few
 * seconds against a directory listing, where GitHub is polled every five
 * minutes against the network.
 *
 * **One file per device.** Each device writes only `bank.<id>.lexis.json` and
 * reads everyone else's. That is the whole trick, and it is worth being
 * explicit about why: a single shared file with two writers is precisely the
 * situation Syncthing cannot resolve, so it would sprout `.sync-conflict-…`
 * copies every time both machines were edited while apart. With one writer per
 * file there is nothing to conflict *over*, and reconciliation becomes what it
 * already is everywhere else in lexis — merging N copies of the bank, which
 * `mergeBanks` does associatively and idempotently.
 *
 * Conflict copies are still handled, because they can still appear: cloned
 * application data gives two machines the same device id, and people copy
 * files by hand. Anything matching Syncthing's conflict pattern is decrypted,
 * merged in like any other peer, and only then removed — and Syncthing's own
 * `.stversions` keeps a copy regardless.
 *
 * **Encryption is not optional here.** A Syncthing folder is a plain directory
 * on two machines and possibly an untrusted relay in between, so the mirror
 * uses the identical envelope the GitHub copy uses, sealed with the identical
 * password-derived key. The folder holds ciphertext and a README.
 *
 * The filesystem arrives as an injected adapter (`fs`) whose four calls are
 * scoped to the mirror directory. That keeps this module runnable under the
 * Node test runner against a fake, and keeps the only real implementation —
 * Tauri commands — on the desktop side where a filesystem exists at all.
 */

import { encryptJSON, decryptJSON } from "./crypto.js";
import { makeEnvelope, assertSupportedEnvelope } from "./sync.js";
import { migrate, TOMBSTONE_TTL_DAYS } from "./bank.js";
import { stable } from "./merge.js";
import { randomBytes } from "./crypto.js";

/** Bumped only for a change no older reader could cope with. */
export const MIRROR_VERSION = 1;

/**
 * A peer file older than the tombstone lifetime is not merged.
 *
 * Tombstones are pruned after this long, so a bank that has been sitting in
 * the folder since before the cutoff may still contain words every live device
 * has since deleted — and merging it would resurrect them with no tombstone
 * left anywhere to delete them again. A dead machine's last copy is a backup
 * to restore deliberately, not something to fold in silently.
 */
export const STALE_PEER_DAYS = TOMBSTONE_TTL_DAYS;

const DAY_MS = 86_400_000;

/* ---- names ---- */

const PEER_RE = /^bank\.([0-9a-z]{4,32})\.lexis\.json$/i;
// Syncthing splices `.sync-conflict-<date>-<time>-<device>` before the extension.
const CONFLICT_RE = /^bank\.([0-9a-z]{4,32})\.lexis\.sync-conflict-[0-9A-Za-z-]+\.json$/i;

export function peerFileName(device) {
  return `bank.${device}.lexis.json`;
}

export function isPeerFile(name) {
  return PEER_RE.test(name);
}

export function isConflictFile(name) {
  return CONFLICT_RE.test(name);
}

export function deviceFromName(name) {
  const m = PEER_RE.exec(name) ?? CONFLICT_RE.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/**
 * A device id, minted once per installation when the mirror is turned on.
 *
 * It only has to be unique among the handful of machines sharing one folder,
 * and it becomes a filename, so it is short and lower-case hex rather than a
 * UUID. It identifies a *file*, not a person: it is derived from nothing and
 * says nothing about the machine.
 */
export function newDeviceId() {
  return [...randomBytes(6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---- the envelope ---- */

/**
 * Seals a bank for the folder.
 *
 * The envelope is the GitHub one plus three fields. `device` and `written`
 * appear twice, once in the clear and once inside the ciphertext: the outer
 * copies exist so a listing can be read and logged without deriving a key,
 * and the inner copies are the ones anything is decided on — the outer pair is
 * unauthenticated and anyone with write access to the folder could set them to
 * whatever they liked.
 */
export async function sealMirror(key, salt, bank, device, written = Date.now()) {
  const payload = await encryptJSON(key, { bank, device, written });
  return {
    ...makeEnvelope(salt, payload),
    mirror: MIRROR_VERSION,
    device,
    written,
  };
}

/** Opens a mirror envelope, or throws. Only the authenticated fields are returned. */
export async function openMirror(key, envelope) {
  assertSupportedEnvelope(envelope);
  if ((envelope?.mirror ?? 0) > MIRROR_VERSION) {
    throw new Error("This mirror file was written by a newer version of lexis.");
  }
  const inner = await decryptJSON(key, envelope);
  // Pre-mirror shapes never existed, but a plain bank is trivially supportable
  // and costs one line, so a hand-restored file still reads.
  const bank = inner && typeof inner === "object" && inner.bank ? inner.bank : inner;
  return {
    bank: migrate(bank),
    device: inner?.device ?? envelope.device ?? null,
    written: inner?.written ?? 0,
  };
}

/* ---- the folder ---- */

/**
 * Wraps a filesystem adapter as the mirror channel.
 *
 * `fs` supplies, all relative to the mirror directory:
 *   - `list()`    → `[{ name, size, modified }]`
 *   - `read(name)`  → the file's text, or `null` if it is gone
 *   - `write(name, text)` → atomic replace
 *   - `remove(name)`
 *
 * The returned object remembers two things between calls: what it last wrote
 * (so an unchanged bank is not rewritten, which would make Syncthing broadcast
 * on every four-second debounce) and what the folder last looked like (so the
 * fast poll can ask "anything new?" for the price of one directory listing).
 */
export function createMirror({ fs, device, salt }) {
  let lastPushed = null;
  let lastSeen = null;
  let lastWrittenAt = 0;
  let lastPeers = null;

  const self = peerFileName(device).toLowerCase();

  /**
   * A cheap signature of everything *other devices* have put in the folder.
   *
   * Our own file is excluded deliberately. Including it would mean every push
   * changed the signature, the next poll would see a change, reconcile, push
   * again — a sync loop that never settles and never stops touching the disk.
   */
  function signature(entries) {
    return entries
      .filter((e) => isPeerFile(e.name) || isConflictFile(e.name))
      .filter((e) => e.name.toLowerCase() !== self)
      .map((e) => `${e.name}:${e.size}:${e.modified}`)
      .sort()
      .join("|");
  }

  return {
    device,

    /** The name this device writes to — shown in the interface, never guessed. */
    get fileName() {
      return peerFileName(device);
    },

    get lastWrittenAt() {
      return lastWrittenAt;
    },

    /** How many other devices were readable last time we looked; null before then. */
    get peerCount() {
      return lastPeers;
    },

    /**
     * Has another device touched the folder since we last looked? One listing,
     * no decryption — cheap enough to run every few seconds.
     */
    async changed() {
      const sig = signature(await fs.list());
      if (sig === lastSeen) return false;
      return true;
    },

    /**
     * Reads every other device's copy.
     *
     * Failures are collected rather than thrown: one unreadable file (written
     * under a different password, half-transferred, hand-edited) must not stop
     * the other peers — or the GitHub channel — from reconciling.
     */
    async pull(key, now = Date.now()) {
      const entries = await fs.list();
      lastSeen = signature(entries);

      const peers = [];
      const conflicts = [];
      const stale = [];
      const unreadable = [];

      for (const entry of entries) {
        const conflicted = isConflictFile(entry.name);
        if (!conflicted && !isPeerFile(entry.name)) continue;
        if (!conflicted && entry.name.toLowerCase() === self) continue;

        let text;
        try {
          text = await fs.read(entry.name);
        } catch (err) {
          unreadable.push({ name: entry.name, reason: String(err?.message ?? err) });
          continue;
        }
        if (text == null) continue; // vanished between the listing and the read

        let opened;
        try {
          opened = await openMirror(key, JSON.parse(text));
        } catch (err) {
          unreadable.push({
            name: entry.name,
            reason: /decrypt|operation-specific/i.test(String(err?.message ?? err))
              ? "written with a different password"
              : String(err?.message ?? err),
          });
          continue;
        }

        const ageDays = (now - (opened.written || 0)) / DAY_MS;
        if (ageDays > STALE_PEER_DAYS) {
          stale.push({ name: entry.name, written: opened.written, days: Math.round(ageDays) });
          continue;
        }

        (conflicted ? conflicts : peers).push({ ...opened, name: entry.name });
      }

      lastPeers = peers.length;
      peers.sort((a, b) => (a.written ?? 0) - (b.written ?? 0));
      conflicts.sort((a, b) => (a.written ?? 0) - (b.written ?? 0));
      return { peers, conflicts, stale, unreadable };
    },

    /**
     * Writes this device's copy, unless it would be byte-for-byte the work we
     * already did. Returns whether anything was written.
     */
    async push(key, bank, now = Date.now()) {
      const shape = stable(bank);
      if (shape === lastPushed) return false;
      const envelope = await sealMirror(key, salt, bank, device, now);
      await fs.write(peerFileName(device), JSON.stringify(envelope, null, 2));
      lastPushed = shape;
      lastWrittenAt = now;
      // Our own write changes the listing; re-baseline so the fast poll does
      // not read it back as somebody else's news.
      try {
        lastSeen = signature(await fs.list());
      } catch {
        lastSeen = null; // the next poll will simply do a full pass
      }
      return true;
    },

    /**
     * Retires conflict copies whose contents are now folded into the bank.
     *
     * Called only after the merged bank has been saved locally *and* written
     * back out to this device's own file — so the data exists in two durable
     * places before the third is removed. Syncthing's `.stversions` keeps a
     * copy besides.
     */
    async retire(names) {
      const removed = [];
      for (const name of names) {
        if (!isConflictFile(name)) continue;
        try {
          await fs.remove(name);
          removed.push(name);
        } catch {
          // Left in place; it will be absorbed again next time, which is
          // harmless — the merge is idempotent.
        }
      }
      return removed;
    },

    /** Forget the cached signature; the next poll does a full pass. */
    invalidate() {
      lastSeen = null;
      lastPushed = null;
    },
  };
}
