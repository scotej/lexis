/**
 * Hostile-network resilience for sync.
 *
 * The other suites prove sync is *correct* against a well-behaved server; this
 * one proves it *survives* the networks it will actually meet — captive
 * portals that hang, Wi-Fi that drops mid-request, proxies that throttle, and
 * GitHub's own transient 5xx. Each test wraps the same SHA-checked fake GitHub
 * with one specific misbehaviour and asserts sync either recovers or fails in a
 * way the controller can retry.
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

// --- a well-behaved fake GitHub, wrapped per-test ----------------------

const OWNER = "scotej";
const REPO = "lexis-data";
const PATH = "bank.lexis.json";
const repoRoot = `/repos/${OWNER}/${REPO}`;

const server = {
  file: null, // { content: <utf8 string>, sha: string }
  writes: 0,
  nextSha: 1,
  reset() {
    this.file = null;
    this.writes = 0;
    this.nextSha = 1;
  },
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

/** The honest server. Wrappers below inject failures in front of it. */
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
      const currentSha = server.file?.sha ?? null;
      if ((body.sha ?? null) !== currentSha) return json(409, { message: "does not match" });
      const sha = `sha${server.nextSha++}`;
      server.file = { content: unb64(body.content), sha };
      server.writes++;
      return json(200, { content: { sha } });
    }
  }
  return json(404, { message: "Not Found" });
}

globalThis.fetch = (url, init) => baseFetch(url, init);

// Imported after the shims exist, since the modules capture globals on load.
const { createVault } = await import("../src/core/vault.js");
const { syncOnce, setNetworkOptions } = await import("../src/core/sync.js");
const { newSrs } = await import("../src/core/srs.js");

// Shrink every delay so the retry paths run in milliseconds, not seconds.
setNetworkOptions({ timeoutMs: 60, retries: 3, backoffMs: 1, maxBackoffMs: 8 });

const PASSWORD = "correct horse battery";
const CONFIG = { token: "github_pat_test", owner: OWNER, repo: REPO, path: PATH };

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
function bank(words) {
  return { version: 2, words, deleted: [], today: null };
}

/** A vault (and its created file) built over the clean server. */
async function setup() {
  const { key, salt } = await createVault({ password: PASSWORD, ...CONFIG });
  return { config: { ...CONFIG, salt }, key };
}

beforeEach(() => {
  server.reset();
  localStorage.clear();
  globalThis.fetch = (url, init) => baseFetch(url, init);
});

// --- tests -------------------------------------------------------------

test("a dropped connection is retried and the sync still succeeds", async () => {
  const { config, key } = await setup();

  let dropped = false;
  globalThis.fetch = (url, init) => {
    if (!dropped) {
      dropped = true;
      return Promise.reject(new TypeError("Failed to fetch")); // a mid-request drop
    }
    return baseFetch(url, init);
  };

  const { pushed } = await syncOnce({ config, key, localBank: bank([word("demise")]) });
  assert.equal(pushed, true, "the retry carried the write through");
  assert.ok(dropped, "a drop really was injected");
});

test("a transient 5xx is retried rather than surfaced", async () => {
  const { config, key } = await setup();

  let blipped = false;
  globalThis.fetch = (url, init) => {
    if (!blipped) {
      blipped = true;
      return json(503, { message: "Service Unavailable" });
    }
    return baseFetch(url, init);
  };

  const { pushed } = await syncOnce({ config, key, localBank: bank([word("demise")]) });
  assert.equal(pushed, true);
});

test("rate limiting (429 with Retry-After) is waited out, not failed", async () => {
  const { config, key } = await setup();

  let throttled = false;
  globalThis.fetch = (url, init) => {
    if (!throttled) {
      throttled = true;
      return json(429, { message: "Too Many Requests" }, { "retry-after": "0" });
    }
    return baseFetch(url, init);
  };

  const { pushed } = await syncOnce({ config, key, localBank: bank([word("demise")]) });
  assert.equal(pushed, true);
});

test("a throttling 403 is retried, not mistaken for a bad token", async () => {
  const { config, key } = await setup();

  // GitHub's primary rate limit is a 403 carrying x-ratelimit-remaining: 0 —
  // the same status a permission failure uses, so the headers are the only tell.
  let throttled = false;
  globalThis.fetch = (url, init) => {
    if (!throttled) {
      throttled = true;
      return json(403, { message: "rate limit exceeded" }, { "x-ratelimit-remaining": "0", "retry-after": "0" });
    }
    return baseFetch(url, init);
  };

  const { pushed } = await syncOnce({ config, key, localBank: bank([word("demise")]) });
  assert.equal(pushed, true, "a throttle must not be reported as a dead token");
});

test("a genuine permission 403 is surfaced at once, without retrying", async () => {
  const { config, key } = await setup();

  // A forbidden token — no rate-limit headers — must fail fast and clearly.
  let puts = 0;
  globalThis.fetch = (url, init) => {
    if (init?.method === "PUT") {
      puts++;
      return json(403, { message: "Forbidden" });
    }
    return baseFetch(url, init);
  };

  await assert.rejects(
    () => syncOnce({ config, key, localBank: bank([word("demise")]) }),
    /permission/i
  );
  assert.equal(puts, 1, "a real permission error is not retried");
});

test("a request that hangs is aborted by the timeout, then retried", async () => {
  const { config, key } = await setup();

  // A captive portal accepts the connection and then answers nothing. Without a
  // timeout this wedges sync forever; with one it aborts and retries.
  let hung = false;
  globalThis.fetch = (url, init) => {
    if (!hung) {
      hung = true;
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    }
    return baseFetch(url, init);
  };

  const { pushed } = await syncOnce({ config, key, localBank: bank([word("demise")]) });
  assert.equal(pushed, true, "the stalled request was abandoned and retried");
});

test("a network that stays down gives up with a retryable offline error", async () => {
  const { config, key } = await setup();

  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.reject(new TypeError("Failed to fetch"));
  };

  await assert.rejects(
    () => syncOnce({ config, key, localBank: bank([word("demise")]) }),
    (err) => {
      assert.equal(err.offline, true, "tagged so the controller keeps retrying");
      assert.match(String(err.message), /reach GitHub|network/i);
      return true;
    }
  );
  assert.equal(calls, 3, "it gave up after exactly the configured number of attempts");
});
