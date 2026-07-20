/**
 * The sync controller's hostile-network behaviour: when a sync fails on a bad
 * link it must schedule its own quick, backing-off retry (not wait out the
 * five-minute poll), and when the link returns that retry must carry the sync
 * through and stand the ladder back down.
 *
 * Timers are mocked so the 5s retry fires on demand; setImmediate and the real
 * crypto/fetch are left alone, so the sync it retries is a genuine round trip.
 */

import { test, beforeEach, mock } from "node:test";
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

const OWNER = "scotej";
const REPO = "lexis-data";
const PATH = "bank.lexis.json";
const repoRoot = `/repos/${OWNER}/${REPO}`;

const server = {
  file: null,
  reset() {
    this.file = null;
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

function baseFetch(url, init = {}) {
  const u = new URL(url);
  if (u.pathname === repoRoot) return json(200, { private: true });
  if (u.pathname === `${repoRoot}/contents/${PATH}`) {
    if ((init.method ?? "GET") === "GET") {
      if (!server.file) return json(404, { message: "Not Found" });
      return json(200, {
        content: b64(server.file.content),
        encoding: "base64",
        sha: server.file.sha,
        git_url: `https://api.github.com${repoRoot}/blobs/${server.file.sha}`,
      });
    }
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      if ((body.sha ?? null) !== (server.file?.sha ?? null)) return json(409, { message: "stale" });
      server.file = { content: unb64(body.content), sha: "sha-next" };
      return json(200, { content: { sha: "sha-next" } });
    }
  }
  return json(404, { message: "Not Found" });
}
globalThis.fetch = (url, init) => baseFetch(url, init);

const { createSyncController } = await import("../src/core/sync-controller.js");
const { createVault } = await import("../src/core/vault.js");
const { setNetworkOptions } = await import("../src/core/sync.js");
const { newSrs } = await import("../src/core/srs.js");

// One attempt per request: a downed network should fail fast so the *controller*
// (not the transport) is the thing scheduling the retry we're testing.
setNetworkOptions({ timeoutMs: 60, retries: 1, backoffMs: 1, maxBackoffMs: 4 });

const PASSWORD = "correct horse battery";
const CONFIG = { token: "github_pat_test", owner: OWNER, repo: REPO, path: PATH };

function bank(words) {
  return { version: 2, words, deleted: [], today: null };
}
function word(name) {
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
    updated: Date.now(),
  };
}

function fakeApp(initial) {
  let b = initial;
  return {
    getBank: () => b,
    replaceBank: async (next) => {
      b = next;
      return b;
    },
  };
}

// Let real microtasks and the real crypto/fetch promises settle. setImmediate
// is deliberately left unmocked so this actually yields to the event loop.
async function flush() {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

// Wait until a condition holds, yielding to the event loop between checks. The
// retry under test finishes on a *real* crypto+fetch round trip, which takes an
// unpredictable number of turns under load; polling to a generous bound is
// deterministic where a fixed count of flushes races that work and flakes.
async function waitFor(predicate, tries = 1000) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  server.reset();
  localStorage.clear();
  globalThis.fetch = (url, init) => baseFetch(url, init);
});

test("a downed link schedules a retry that recovers when the link returns", async () => {
  const { key, salt } = await createVault({ password: PASSWORD, ...CONFIG });
  const config = { ...CONFIG, salt };

  const statuses = [];
  const controller = createSyncController({
    app: fakeApp(bank([word("demise")])),
    onStatus: (s) => statuses.push(s),
  });

  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    controller.enable(key, config);

    // The network is down: the first sync fails and must schedule a retry.
    globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    await controller.now();
    await waitFor(() => statuses.at(-1)?.kind === "error");

    const failed = statuses.at(-1);
    assert.equal(failed.kind, "error");
    assert.match(failed.text, /offline/i);

    // Bring the network back and let the scheduled retry (~5s) fire.
    globalThis.fetch = (url, init) => baseFetch(url, init);
    mock.timers.tick(7000);
    await waitFor(() => statuses.at(-1)?.kind === "ok");

    const recovered = statuses.at(-1);
    assert.equal(recovered.kind, "ok", "the scheduled retry carried the sync through");
    assert.equal(controller.lastError, null, "and cleared the error once it succeeded");
  } finally {
    mock.timers.reset();
    controller.disable();
  }
});

test("a fatal error is not put on the fast-retry ladder", async () => {
  const { key, salt } = await createVault({ password: PASSWORD, ...CONFIG });
  const config = { ...CONFIG, salt };

  const statuses = [];
  const controller = createSyncController({
    app: fakeApp(bank([word("demise")])),
    onStatus: (s) => statuses.push(s),
  });

  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    controller.enable(key, config);

    // A forbidden token is not a network blip; retrying on a 5s ladder is
    // pointless, so no timer should be armed to fire one.
    globalThis.fetch = (url, init) =>
      init?.method === "PUT" ? json(403, { message: "Forbidden" }) : baseFetch(url, init);
    await controller.now();
    await flush();

    const failed = statuses.at(-1);
    assert.equal(failed.kind, "error");
    assert.doesNotMatch(failed.text, /offline/i, "surfaced as a real error, not a retry");

    // Advancing past a would-be retry window changes nothing: no retry was armed.
    const countBefore = statuses.length;
    mock.timers.tick(30000);
    await flush();
    assert.equal(statuses.length, countBefore, "no fast retry was scheduled");
  } finally {
    mock.timers.reset();
    controller.disable();
  }
});
