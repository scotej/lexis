/**
 * End-to-end sync, against a stand-in for the GitHub Contents API.
 *
 * This exercises the real crypto, the real envelope format, the real merge,
 * and the real conflict retry — everything except the network itself. The
 * fake server enforces the same SHA precondition GitHub does, so the
 * "another device wrote first" path is genuinely tested rather than assumed.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- environment shims -------------------------------------------------

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

// --- fake GitHub -------------------------------------------------------

const OWNER = "scotej";
const REPO = "lexis-data";
const PATH = "bank.lexis.json";

const server = {
  file: null, // { content: <utf8 string>, sha: string }
  writes: 0,
  nextSha: 1,
  // Above 1 MB GitHub stops inlining file content on the contents endpoint.
  oversize: false,
  // Simulates a device whose read landed before another device created the file.
  pretend404Once: false,
  reset() {
    this.file = null;
    this.writes = 0;
    this.nextSha = 1;
    this.oversize = false;
    this.pretend404Once = false;
  },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}
function unb64(str) {
  return Buffer.from(str, "base64").toString("utf8");
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const repoRoot = `/repos/${OWNER}/${REPO}`;

  if (u.pathname === repoRoot) {
    // Deliberately omits `permissions`: a fine-grained token need not report
    // it, and setup must not depend on that flag.
    return json(200, { private: true });
  }

  if (u.pathname === `${repoRoot}/blobs/${server.file?.sha}`) {
    return json(200, { encoding: "base64", content: b64(server.file.content) });
  }

  if (u.pathname === `${repoRoot}/contents/${PATH}`) {
    if ((init.method ?? "GET") === "GET") {
      if (server.pretend404Once) {
        server.pretend404Once = false;
        return json(404, { message: "Not Found" });
      }
      if (!server.file) return json(404, { message: "Not Found" });
      if (server.oversize) {
        // What GitHub actually returns past 1 MB: success, but no content.
        return json(200, {
          content: "",
          encoding: "none",
          sha: server.file.sha,
          git_url: `https://api.github.com${repoRoot}/blobs/${server.file.sha}`,
        });
      }
      return json(200, {
        content: b64(server.file.content),
        encoding: "base64",
        sha: server.file.sha,
        git_url: `https://api.github.com${repoRoot}/blobs/${server.file.sha}`,
      });
    }
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      const currentSha = server.file?.sha ?? null;
      // GitHub requires the SHA you read; a stale one means someone else wrote.
      if ((body.sha ?? null) !== currentSha) {
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
const { createVault, unlockVault, clearVault } = await import("../src/core/vault.js");
const { syncOnce } = await import("../src/core/sync.js");
const { newSrs } = await import("../src/core/srs.js");

const PASSWORD = "correct horse battery";
const CONFIG = { token: "github_pat_test", owner: OWNER, repo: REPO, path: PATH };

function word(name, updated) {
  return {
    word: name,
    phonetic: null,
    senses: [{ pos: "noun", def: `${name} means something`, example: null }],
    synonyms: [],
    source: "test",
    source_url: "https://example.invalid",
    added: "2026-07-20",
    srs: newSrs("2026-07-20"),
    times_used: 0,
    updated,
  };
}

function bank(words) {
  return { version: 2, words, deleted: [], today: null };
}

beforeEach(() => {
  server.reset();
  localStorage.clear();
});

// --- tests -------------------------------------------------------------

test("first device creates the file and stores nothing in plaintext", async () => {
  const { key, salt } = await createVault({ password: PASSWORD, ...CONFIG });
  const local = bank([word("demise", Date.now())]);

  const { pushed } = await syncOnce({ config: { ...CONFIG, salt }, key, localBank: local });
  assert.equal(pushed, true);
  assert.ok(server.file, "the file was created");

  // What GitHub holds must not contain the word, the token, or the password.
  const stored = server.file.content;
  assert.ok(!stored.includes("demise"), "the bank is encrypted at rest");
  assert.ok(!stored.includes(CONFIG.token), "the token never reaches the repository");
  assert.ok(!stored.includes(PASSWORD));

  const envelope = JSON.parse(stored);
  assert.equal(envelope.lexis, 1);
  assert.equal(envelope.kdf.algo, "PBKDF2-SHA256");
  assert.ok(envelope.ct.length > 0);
});

test("the vault keeps the token encrypted in local storage", async () => {
  await createVault({ password: PASSWORD, ...CONFIG });
  const raw = localStorage.getItem("lexis-vault");
  assert.ok(!raw.includes(CONFIG.token), "the token is not stored in the clear");
  assert.ok(!raw.includes(PASSWORD));

  const { config } = await unlockVault(PASSWORD);
  assert.equal(config.token, CONFIG.token, "the right password recovers it");
});

test("a wrong password is rejected rather than yielding garbage", async () => {
  await createVault({ password: PASSWORD, ...CONFIG });
  await assert.rejects(() => unlockVault("not the password"), /Wrong password/);
});

test("a second device adopts the first device's salt and its data", async () => {
  // Device one.
  const first = await createVault({ password: PASSWORD, ...CONFIG });
  await syncOnce({
    config: { ...CONFIG, salt: first.salt },
    key: first.key,
    localBank: bank([word("demise", Date.now())]),
  });

  // Device two: fresh storage, same password.
  localStorage.clear();
  const second = await createVault({ password: PASSWORD, ...CONFIG });
  assert.equal(second.adopted, true, "it recognised an existing bank");
  assert.equal(second.salt, first.salt, "both devices derive the same key");

  const { bank: pulled } = await syncOnce({
    config: { ...CONFIG, salt: second.salt },
    key: second.key,
    localBank: bank([]),
  });
  assert.deepEqual(pulled.words.map((w) => w.word), ["demise"]);
});

test("setting up a second device with the wrong password fails loudly", async () => {
  const first = await createVault({ password: PASSWORD, ...CONFIG });
  await syncOnce({
    config: { ...CONFIG, salt: first.salt },
    key: first.key,
    localBank: bank([word("demise", Date.now())]),
  });

  localStorage.clear();
  await assert.rejects(
    () => createVault({ password: "a different password", ...CONFIG }),
    /doesn't match/,
    "a typo must not silently start a second, divergent bank"
  );
});

test("two devices' words both survive a round of sync", async () => {
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  const cfg = { ...CONFIG, salt: a.salt };

  const deviceA = bank([word("demise", Date.now())]);
  const deviceB = bank([word("cessation", Date.now())]);

  await syncOnce({ config: cfg, key: a.key, localBank: deviceA });
  const { bank: bMerged } = await syncOnce({ config: cfg, key: a.key, localBank: deviceB });
  assert.deepEqual(bMerged.words.map((w) => w.word).sort(), ["cessation", "demise"]);

  // A now pulls B's word back down.
  const { bank: aMerged } = await syncOnce({ config: cfg, key: a.key, localBank: deviceA });
  assert.deepEqual(aMerged.words.map((w) => w.word).sort(), ["cessation", "demise"]);
});

test("a stale write is retried against the winner instead of clobbering it", async () => {
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  const cfg = { ...CONFIG, salt: a.salt };
  await syncOnce({ config: cfg, key: a.key, localBank: bank([word("demise", Date.now())]) });

  // Simulate another device committing between our read and our write, by
  // mutating the server's SHA mid-flight exactly once.
  const realFetch = globalThis.fetch;
  let interfered = false;
  globalThis.fetch = async (url, init) => {
    if (init?.method === "PUT" && !interfered) {
      interfered = true;
      server.file = { content: server.file.content, sha: "sha-from-elsewhere" };
    }
    return realFetch(url, init);
  };

  try {
    const { bank: merged, pushed } = await syncOnce({
      config: cfg,
      key: a.key,
      localBank: bank([word("cessation", Date.now())]),
    });
    assert.equal(pushed, true, "the retry succeeded");
    assert.deepEqual(
      merged.words.map((w) => w.word).sort(),
      ["cessation", "demise"],
      "nothing was lost to the collision"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("syncing with no changes does not write again", async () => {
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  const cfg = { ...CONFIG, salt: a.salt };
  const local = bank([word("demise", Date.now())]);

  await syncOnce({ config: cfg, key: a.key, localBank: local });
  const writesAfterFirst = server.writes;

  const { pushed } = await syncOnce({ config: cfg, key: a.key, localBank: local });
  assert.equal(pushed, false);
  assert.equal(server.writes, writesAfterFirst, "no redundant commit was made");
});

test("a bank encrypted under another password cannot be read", async () => {
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  await syncOnce({
    config: { ...CONFIG, salt: a.salt },
    key: a.key,
    localBank: bank([word("demise", Date.now())]),
  });

  // Same salt, different password — the derived key must not decrypt.
  const { deriveKey } = await import("../src/core/crypto.js");
  const wrongKey = await deriveKey("some other password", a.salt);
  await assert.rejects(
    () =>
      syncOnce({
        config: { ...CONFIG, salt: a.salt },
        key: wrongKey,
        localBank: bank([]),
      }),
    /Could not decrypt/
  );
});

test("clearing the vault leaves no trace of the token", async () => {
  await createVault({ password: PASSWORD, ...CONFIG });
  await clearVault();
  assert.equal(localStorage.getItem("lexis-vault"), null);
  await assert.rejects(() => unlockVault(PASSWORD), /No sync is set up/);
});

test("setup does not depend on GitHub advertising write permission", async () => {
  // The repo endpoint above reports no `permissions` block at all, yet the
  // whole round trip must still work — the write is the real test.
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  const { pushed } = await syncOnce({
    config: { ...CONFIG, salt: a.salt },
    key: a.key,
    localBank: bank([word("demise", Date.now())]),
  });
  assert.equal(pushed, true);
});

test("a missing owner or token is refused before any request is made", async () => {
  await assert.rejects(
    () => createVault({ password: PASSWORD, token: "", owner: OWNER, repo: REPO, path: PATH }),
    /Fill in the owner/
  );
});

test("a short password is refused", async () => {
  await assert.rejects(() => createVault({ password: "short", ...CONFIG }), /at least 8/);
});


test("a bank too large to inline is read from the blob endpoint", async () => {
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  const cfg = { ...CONFIG, salt: a.salt };
  await syncOnce({ config: cfg, key: a.key, localBank: bank([word("demise", Date.now())]) });

  // Past 1 MB the contents endpoint answers 200 with an empty body. Parsing
  // that looked exactly like corruption, and did so permanently.
  server.oversize = true;
  const { bank: pulled } = await syncOnce({ config: cfg, key: a.key, localBank: bank([]) });
  assert.deepEqual(pulled.words.map((w) => w.word), ["demise"]);
});

test("setting up two devices at once does not strand the loser", async () => {
  // Device A creates the file.
  const a = await createVault({ password: PASSWORD, ...CONFIG });
  await syncOnce({
    config: { ...CONFIG, salt: a.salt },
    key: a.key,
    localBank: bank([word("demise", Date.now())]),
  });

  // Device B's read landed just before A's write, so it still believes the
  // repository is empty and will mint a salt of its own.
  localStorage.clear();
  server.pretend404Once = true;
  const b = await createVault({ password: PASSWORD, ...CONFIG });

  assert.equal(b.salt, a.salt, "B adopts the salt that actually won");
  assert.equal(b.adopted, true);

  // And B can genuinely read what A wrote.
  const { bank: pulled } = await syncOnce({
    config: { ...CONFIG, salt: b.salt },
    key: b.key,
    localBank: bank([]),
  });
  assert.deepEqual(pulled.words.map((w) => w.word), ["demise"]);
});

test("first-time setup creates the file immediately", async () => {
  await createVault({ password: PASSWORD, ...CONFIG });
  assert.ok(server.file, "the salt is claimed at setup, not left for the first sync");
});
