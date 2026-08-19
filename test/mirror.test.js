/**
 * The Syncthing mirror, and a full pass across both channels.
 *
 * The filesystem is a fake in-memory folder, but everything above it is real:
 * the real crypto, the real envelope, the real merge, the real GitHub client
 * against the same stand-in server the sync tests use. What is actually being
 * checked here is the set of things that would each be quietly catastrophic:
 *
 *   - the folder holds ciphertext, never a readable bank;
 *   - two devices reconcile through the folder with no network at all;
 *   - our own file never triggers our own poll (a sync loop that never ends);
 *   - an unchanged bank is not rewritten (Syncthing churn on every keystroke);
 *   - a Syncthing conflict copy is absorbed and only then retired;
 *   - a peer file old enough to predate tombstone pruning is left alone
 *     rather than resurrecting words every live device has deleted;
 *   - either channel can fail without taking the other down with it.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  #map = new Map();
  getItem(k) {
    return this.#map.has(k) ? this.#map.get(k) : null;
  }
  setItem(k, v) {
    this.#map.set(k, String(v));
  }
  removeItem(k) {
    this.#map.delete(k);
  }
  clear() {
    this.#map.clear();
  }
}
globalThis.localStorage = new MemoryStorage();

// --- fake GitHub (the same shape as test/sync.test.js) -----------------

const OWNER = "scotej";
const REPO = "lexis-data";
const PATH = "bank.lexis.json";

const server = {
  file: null,
  writes: 0,
  nextSha: 1,
  down: false,
  reset() {
    this.file = null;
    this.writes = 0;
    this.nextSha = 1;
    this.down = false;
  },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

globalThis.fetch = async (url, init = {}) => {
  if (server.down) throw new TypeError("fetch failed");
  const u = new URL(url);
  const repoRoot = `/repos/${OWNER}/${REPO}`;
  if (u.pathname === repoRoot) return json(200, { private: true });
  if (u.pathname === `${repoRoot}/contents/${PATH}`) {
    if ((init.method ?? "GET") === "GET") {
      if (!server.file) return json(404, { message: "Not Found" });
      return json(200, {
        content: b64(server.file.content),
        encoding: "base64",
        sha: server.file.sha,
      });
    }
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      if ((body.sha ?? null) !== (server.file?.sha ?? null)) {
        return json(409, { message: "does not match" });
      }
      const sha = `sha${server.nextSha++}`;
      server.file = { content: unb64(body.content), sha };
      server.writes++;
      return json(200, { content: { sha } });
    }
  }
  return json(404, { message: "Not Found" });
};

// Imported after the shims exist, since the modules capture globals on load.
const { deriveKey, randomSalt } = await import("../src/core/crypto.js");
const { setNetworkOptions } = await import("../src/core/sync.js");
const { newSrs } = await import("../src/core/srs.js");
const mirrorModule = await import("../src/core/mirror.js");
const { createMirror, peerFileName, sealMirror, isConflictFile, newDeviceId, STALE_PEER_DAYS } =
  mirrorModule;
const { reconcile, FOLDER, GITHUB } = await import("../src/core/reconcile.js");

// One derivation, reused: PBKDF2 at 600k iterations is the slowest thing here
// and the tests are about the folder, not the KDF.
const SALT = randomSalt();
const KEY = await deriveKey("correct horse battery", SALT);
const OTHER_KEY = await deriveKey("a different password entirely", SALT);
const CONFIG = { token: "github_pat_test", owner: OWNER, repo: REPO, path: PATH, salt: SALT };

setNetworkOptions({ retries: 1, backoffMs: 1, maxBackoffMs: 2, timeoutMs: 500 });

// --- a folder that lives in memory --------------------------------------

function memoryFolder() {
  const files = new Map(); // name -> { text, modified }
  // Real mtimes are epoch milliseconds, and the staleness rule reads them; a
  // counter starting at 1 would make every file look fifty-odd years old.
  let clock = Date.now();
  const fs = {
    async list() {
      return [...files.entries()].map(([name, f]) => ({
        name,
        size: f.text.length,
        modified: f.modified,
      }));
    },
    async read(name) {
      return files.get(name)?.text ?? null;
    },
    async write(name, text) {
      files.set(name, { text, modified: clock++ });
    },
    async remove(name) {
      files.delete(name);
    },
  };
  return { files, fs };
}

const DAY = "2026-07-20";

function word(name, patch = {}) {
  return {
    word: name,
    phonetic: null,
    senses: [{ pos: "noun", def: `${name} means something`, example: null }],
    synonyms: [],
    source: "test",
    source_url: "https://example.invalid",
    added: DAY,
    srs: newSrs(DAY),
    times_used: 0,
    essay_uses: 0,
    essay_use_events: {},
    updated: 1000,
    created: 1000,
    ...patch,
  };
}

function bank(words, deleted = []) {
  return { version: 3, words, deleted, today: null };
}

const names = (folder) => [...folder.files.keys()];

beforeEach(() => {
  server.reset();
  localStorage.clear();
});

// --- the folder itself --------------------------------------------------

test("the folder holds ciphertext and never the words themselves", async () => {
  const folder = memoryFolder();
  const mirror = createMirror({ fs: folder.fs, device: "aa11bb22", salt: SALT });

  await mirror.push(KEY, bank([word("demise")]));

  const text = folder.files.get("bank.aa11bb22.lexis.json").text;
  assert.ok(!text.includes("demise"), "the bank is encrypted at rest");
  const envelope = JSON.parse(text);
  assert.equal(envelope.lexis, 2);
  assert.equal(envelope.mirror, 1);
  assert.equal(envelope.kdf.algo, "PBKDF2-SHA256");
  assert.ok(envelope.ct.length > 0);
});

test("a device reads its peers but not its own file", async () => {
  const folder = memoryFolder();
  const a = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  const b = createMirror({ fs: folder.fs, device: "bbbb", salt: SALT });

  await a.push(KEY, bank([word("demise")]));
  await b.push(KEY, bank([word("elegy")]));

  const seenByB = await b.pull(KEY);
  assert.deepEqual(
    seenByB.peers.map((p) => p.name),
    [peerFileName("aaaa")]
  );
  assert.equal(seenByB.peers[0].bank.words[0].word, "demise");
  assert.equal(seenByB.peers[0].device, "aaaa");
});

test("our own write does not make the poll think something changed", async () => {
  // The loop this prevents: push → listing moves → poll sees a change →
  // reconcile → push → for ever, touching the disk the whole time.
  const folder = memoryFolder();
  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });

  await me.pull(KEY);
  await me.push(KEY, bank([word("demise")]));
  assert.equal(await me.changed(), false);

  const peer = createMirror({ fs: folder.fs, device: "bbbb", salt: SALT });
  await peer.push(KEY, bank([word("elegy")]));
  assert.equal(await me.changed(), true);
});

test("an unchanged bank is not written again", async () => {
  const folder = memoryFolder();
  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  const b = bank([word("demise")]);

  assert.equal(await me.push(KEY, b), true);
  assert.equal(await me.push(KEY, JSON.parse(JSON.stringify(b))), false);
  assert.equal(await me.push(KEY, bank([word("demise"), word("elegy")])), true);
});

test("a peer written under a different password is reported, not fatal", async () => {
  const folder = memoryFolder();
  const stranger = createMirror({ fs: folder.fs, device: "cccc", salt: SALT });
  await stranger.push(OTHER_KEY, bank([word("elegy")]));

  const good = createMirror({ fs: folder.fs, device: "dddd", salt: SALT });
  await good.push(KEY, bank([word("demise")]));

  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  const seen = await me.pull(KEY);
  assert.equal(seen.peers.length, 1, "the readable peer still arrives");
  assert.equal(seen.unreadable.length, 1);
  assert.match(seen.unreadable[0].reason, /different password/);
});

test("a peer older than the tombstone lifetime is left alone", async () => {
  // Tombstones are pruned after this long, so merging such a file would
  // resurrect words with no tombstone left anywhere to delete them again.
  const folder = memoryFolder();
  const ancient = Date.now() - (STALE_PEER_DAYS + 5) * 86_400_000;
  await folder.fs.write(
    peerFileName("dead1234"),
    JSON.stringify(await sealMirror(KEY, SALT, bank([word("relic")]), "dead1234", ancient))
  );

  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  const seen = await me.pull(KEY);
  assert.equal(seen.peers.length, 0);
  assert.equal(seen.stale.length, 1);
  assert.ok(seen.stale[0].days >= STALE_PEER_DAYS);
});

test("device ids are distinct and make legal filenames", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newDeviceId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(peerFileName(id), /^bank\.[0-9a-f]{12}\.lexis\.json$/);
});

test("Syncthing's conflict names are recognised, ordinary ones are not", () => {
  assert.ok(
    isConflictFile("bank.aa11bb22.lexis.sync-conflict-20260819-101112-K3PLMNO.json")
  );
  assert.ok(!isConflictFile("bank.aa11bb22.lexis.json"));
  assert.ok(!isConflictFile("README.txt"));
});

// --- a full pass across both channels ------------------------------------

test("two devices reconcile through the folder with no network at all", async () => {
  server.down = true;
  const folder = memoryFolder();

  const laptopMirror = createMirror({ fs: folder.fs, device: "1111", salt: SALT });
  const laptop = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror: laptopMirror,
  });
  assert.ok(laptop.error, "GitHub failed");
  assert.equal(laptop.mirrored, true, "the folder still took the change");

  const deskMirror = createMirror({ fs: folder.fs, device: "2222", salt: SALT });
  const desk = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("elegy")]),
    mirror: deskMirror,
  });

  const words = desk.bank.words.map((w) => w.word).sort();
  assert.deepEqual(words, ["demise", "elegy"], "each device has both words");
  assert.equal(server.writes, 0, "nothing reached GitHub");
});

test("a failed push still writes the folder, and still reports the failure", async () => {
  server.down = true;
  const folder = memoryFolder();
  const mirror = createMirror({ fs: folder.fs, device: "1111", salt: SALT });

  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror,
  });

  assert.ok(result.error, "the caller is told GitHub is unreachable");
  assert.equal(result.error.offline, true, "and told it is worth retrying");
  assert.ok(names(folder).includes(peerFileName("1111")));
});

test("an unreadable folder does not stop the GitHub channel", async () => {
  const broken = {
    async list() {
      throw new Error("volume not mounted");
    },
    async read() {
      throw new Error("volume not mounted");
    },
    async write() {
      throw new Error("volume not mounted");
    },
    async remove() {},
  };
  const mirror = createMirror({ fs: broken, device: "1111", salt: SALT });

  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror,
  });

  assert.equal(result.error, null, "GitHub was fine");
  assert.equal(result.pushed, true);
  assert.ok(result.mirrorError, "the folder problem is reported separately");
  assert.equal(result.notes.length, 2, "read and write are both explained");
});

test("the folder's work reaches GitHub in the same pass", async () => {
  const folder = memoryFolder();
  const peer = createMirror({ fs: folder.fs, device: "2222", salt: SALT });
  await peer.push(KEY, bank([word("elegy")]));

  const mirror = createMirror({ fs: folder.fs, device: "1111", salt: SALT });
  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror,
  });

  assert.equal(result.error, null);
  assert.equal(server.writes, 1, "one commit carries both devices' work");
  assert.deepEqual(result.bank.words.map((w) => w.word).sort(), ["demise", "elegy"]);
});

test("a Syncthing conflict copy is merged, then named for removal", async () => {
  const folder = memoryFolder();
  const conflictName = "bank.2222.lexis.sync-conflict-20260819-101112-K3PLMNO.json";
  await folder.fs.write(
    conflictName,
    JSON.stringify(await sealMirror(KEY, SALT, bank([word("elegy")]), "2222"))
  );

  const mirror = createMirror({ fs: folder.fs, device: "1111", salt: SALT });
  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror,
  });

  assert.ok(
    result.bank.words.some((w) => w.word === "elegy"),
    "the conflicted copy's work is kept"
  );
  assert.deepEqual(result.retire, [conflictName]);
  // Still on disk: removal is the caller's, after the bank is saved.
  assert.ok(names(folder).includes(conflictName));

  await mirror.retire(result.retire);
  assert.ok(!names(folder).includes(conflictName));
});

test("nothing is retired when the folder could not be written", async () => {
  const folder = memoryFolder();
  const conflictName = "bank.2222.lexis.sync-conflict-20260819-101112-K3PLMNO.json";
  await folder.fs.write(
    conflictName,
    JSON.stringify(await sealMirror(KEY, SALT, bank([word("elegy")]), "2222"))
  );
  const readOnly = {
    ...folder.fs,
    async write() {
      throw new Error("read-only volume");
    },
  };

  const mirror = createMirror({ fs: readOnly, device: "1111", salt: SALT });
  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror,
  });

  assert.deepEqual(result.retire, [], "the only copy of that work stays put");
});

test("conflicts are reported with the channel each copy came from", async () => {
  // GitHub holds a well-reviewed copy; the folder holds a newer, emptier one.
  const folder = memoryFolder();
  const peer = createMirror({ fs: folder.fs, device: "2222", salt: SALT });
  await peer.push(
    KEY,
    bank([word("demise", { updated: 9000, times_used: 1, srs: { ...newSrs(DAY), reps: 1 } })])
  );

  const remote = createMirror({ fs: memoryFolder().fs, device: "3333", salt: SALT });
  await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([
      word("demise", { updated: 4000, times_used: 9, srs: { ...newSrs(DAY), reps: 8 } }),
    ]),
    mirror: remote,
  });

  const mirror = createMirror({ fs: folder.fs, device: "1111", salt: SALT });
  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise", { updated: 1000 })]),
    mirror,
  });

  const sides = new Set(result.conflicts.map((c) => c.lostSide));
  assert.ok(result.conflicts.length >= 1);
  assert.ok(
    sides.has(FOLDER) || sides.has(GITHUB),
    "each conflict names the channel whose copy lost"
  );
  assert.ok(result.conflicts.every((c) => c.word === "demise"));
});

test("with no folder configured, a pass is exactly the GitHub sync it always was", async () => {
  const result = await reconcile({
    config: CONFIG,
    key: KEY,
    localBank: bank([word("demise")]),
    mirror: null,
  });
  assert.equal(result.error, null);
  assert.equal(result.pushed, true);
  assert.equal(result.mirrored, false);
  assert.deepEqual(result.retire, []);
  assert.deepEqual(result.notes, []);
});

/* ---- the audit's correctness findings, pinned ---- */

test("a peer file of ours that vanished is written again on the next pass", async () => {
  // `push` skips a write whose shape it believes is already on disk. If the
  // file is deleted underneath us that belief is a lie, and the backup would
  // silently never come back.
  const folder = memoryFolder();
  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  const b = bank([word("demise")]);

  assert.equal(await me.push(KEY, b), true);
  folder.files.delete(peerFileName("aaaa"));

  await me.pull(KEY); // the listing shows our file is gone
  assert.equal(await me.push(KEY, b), true, "the same bank is rewritten");
  assert.ok(names(folder).includes(peerFileName("aaaa")));
});

test("a peer dated in the future is refused rather than made immortal", async () => {
  // Age is measured against a stamp the peer wrote. One far enough ahead would
  // never reach the staleness cutoff, so such a file could be merged for ever.
  const folder = memoryFolder();
  const ahead = Date.now() + 30 * 86_400_000;
  await folder.fs.write(
    peerFileName("fastclock"),
    JSON.stringify(await sealMirror(KEY, SALT, bank([word("relic")]), "fastclock", ahead))
  );

  const seen = await createMirror({ fs: folder.fs, device: "aaaa", salt: SALT }).pull(KEY);
  assert.equal(seen.peers.length, 0);
  assert.equal(seen.unreadable.length, 1);
  assert.match(seen.unreadable[0].reason, /future/);
});

test("a peer write during a pass still wakes the next poll", async () => {
  // `push` used to re-baseline the folder signature from a fresh listing,
  // quietly absorbing anything a peer wrote while GitHub was being talked to.
  const folder = memoryFolder();
  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  await me.pull(KEY);

  const peer = createMirror({ fs: folder.fs, device: "bbbb", salt: SALT });
  await peer.push(KEY, bank([word("elegy")])); // lands mid-pass
  await me.push(KEY, bank([word("demise")])); // our own write ends the pass

  assert.equal(await me.changed(), true, "the peer's work is still news");
});

test("a retired channel refuses to write, so switching the folder off sticks", async () => {
  const folder = memoryFolder();
  const me = createMirror({ fs: folder.fs, device: "aaaa", salt: SALT });
  me.stop();

  assert.equal(await me.push(KEY, bank([word("demise")])), false);
  assert.deepEqual(names(folder), []);
  assert.deepEqual(await me.retire(["bank.bbbb.lexis.sync-conflict-1-2-3.json"]), []);
});
