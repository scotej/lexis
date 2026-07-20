/**
 * Sync over a private GitHub repository file.
 *
 * GitHub hosts the whole thing for free and needs no server of ours: the
 * Contents API stores one file, and its blob SHA gives real optimistic
 * concurrency — write with the SHA you read, and a device that changed the
 * file underneath you is rejected rather than silently overwritten.
 *
 * The file is an encrypted envelope (see crypto.js). GitHub stores
 * ciphertext and never holds the key.
 */

import { encryptJSON, decryptJSON, ITERATIONS } from "./crypto.js";
import { mergeBanks, stable } from "./merge.js";
import { migrate } from "./bank.js";

const API = "https://api.github.com";
const ENVELOPE_VERSION = 1;

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function describeError(status, body) {
  if (status === 401) return "GitHub rejected the token — it may be expired or mistyped.";
  if (status === 403) {
    return "The token lacks permission. It needs Contents: Read and write on this repository.";
  }
  if (status === 404) {
    return "Repository not found. Check owner/name, and that the token can see this repository.";
  }
  if (status === 422) return "GitHub rejected the write (the file changed underneath us).";
  return `GitHub returned ${status}${body ? ` — ${body}` : ""}`;
}

/**
 * Network-resilience knobs. Hostile networks — captive portals, flaky Wi-Fi,
 * throttling proxies — fail in ways a single fetch() can't survive: requests
 * that hang forever, drops mid-flight, 5xx blips, and rate limiting. So every
 * request runs under a timeout and a bounded, backing-off retry.
 *
 * The defaults suit real use; tests shrink them with setNetworkOptions().
 */
const net = {
  timeoutMs: 15000, // abort a request that stalls this long — sync must never wedge
  retries: 3, // total attempts per request for *transient* failures
  backoffMs: 500, // base of the exponential backoff between attempts
  maxBackoffMs: 4000, // never hold a single request open longer than this
};

/** Override the network knobs (used by tests to run fast). */
export function setNetworkOptions(partial) {
  Object.assign(net, partial);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A retryable "the network, not GitHub, is the problem" error. Tagged so the
 * sync controller keeps trying with its own backoff instead of surfacing a
 * dead end the user can do nothing about.
 */
function offlineError(message, cause) {
  const err = new Error(message);
  err.offline = true;
  if (cause) err.cause = cause;
  return err;
}

// 5xx and 429 are transient by definition; retrying is the correct response.
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// GitHub signals throttling as 429 (secondary limits) or 403 (primary), always
// with a Retry-After header or x-ratelimit-remaining: 0. A permission 403 has
// neither — which is how we tell a throttle from a genuinely forbidden token
// and avoid reporting "the token lacks permission" to someone behind a proxy.
function isRateLimited(resp) {
  if (resp.status === 429) return true;
  if (resp.status !== 403) return false;
  if (resp.headers.get("retry-after")) return true;
  return resp.headers.get("x-ratelimit-remaining") === "0";
}

// Prefer the server's own guidance — Retry-After seconds, or the epoch at which
// the rate-limit window resets — over a blind guess. Returns ms, or null.
function retryAfterMs(resp) {
  const ra = resp.headers.get("retry-after");
  if (ra != null && ra !== "") {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  const reset = resp.headers.get("x-ratelimit-reset");
  if (reset) {
    const delta = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(delta) && delta > 0) return delta;
  }
  return null;
}

function backoffDelay(attempt) {
  const base = Math.min(net.maxBackoffMs, net.backoffMs * 2 ** (attempt - 1));
  return base + Math.random() * net.backoffMs; // jitter so two devices don't lock step
}

// A single fetch that cannot hang: an internal timeout aborts a stalled
// request, and any caller-supplied signal is honoured too.
async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), net.timeoutMs);
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A GitHub request that survives a hostile network. Network failures, our own
 * timeout, 5xx, and rate limiting are retried with exponential backoff; a
 * server that asks us to wait longer than one backoff window hands off to the
 * caller's slower retry rather than holding the request open. Everything else
 * — 2xx, 401, 404, 409, 422, a genuine permission 403 — is returned untouched
 * for the caller to interpret.
 */
async function ghFetch(url, token, init = {}) {
  const merged = { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } };

  for (let attempt = 1; attempt <= net.retries; attempt++) {
    const last = attempt >= net.retries;
    let resp;
    try {
      resp = await fetchWithTimeout(url, merged);
    } catch (err) {
      // fetch() rejects with TypeError on a network drop and AbortError when
      // our timeout fires; both mean "try again in a moment".
      if (last) {
        throw offlineError(
          err?.name === "AbortError"
            ? "GitHub didn’t respond in time (a slow or blocked network)."
            : "Couldn’t reach GitHub (network problem).",
          err
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    }

    if (isRetryableStatus(resp.status) || isRateLimited(resp)) {
      const message = isRateLimited(resp)
        ? "GitHub is rate-limiting requests on this network."
        : `GitHub is temporarily unavailable (${resp.status}).`;
      const wait = retryAfterMs(resp);
      // Out of attempts, or told to wait longer than we hold a request open:
      // surface a retryable error and let the controller pace the next try.
      if (last || (wait != null && wait > net.maxBackoffMs)) throw offlineError(message);
      await sleep(wait ?? backoffDelay(attempt));
      continue;
    }

    return resp;
  }
  // Unreachable: every path above returns or throws.
  throw offlineError("Couldn’t reach GitHub.");
}

/** Reads the remote envelope. Returns `null` content when the file doesn't exist yet. */
export async function fetchRemote({ token, owner, repo, path }) {
  const url = `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  // `cache: no-store` matters: a stale 200 from the HTTP cache would make us
  // write against an old SHA and 409 forever.
  const resp = await ghFetch(url, token, { cache: "no-store" });
  if (resp.status === 404) return { envelope: null, sha: null };
  if (!resp.ok) throw new Error(describeError(resp.status, await resp.text().catch(() => "")));
  const json = await resp.json();

  // Above 1 MB the contents endpoint stops inlining the file: it answers 200
  // with an empty body and `encoding: "none"`. Parsing that would look exactly
  // like corruption, and would do so permanently once a bank grew past the
  // threshold. The blob endpoint has no such limit.
  let raw = json.content ?? "";
  if (json.encoding !== "base64" || !raw.trim()) {
    raw = await fetchBlob(json.git_url, token);
  }

  let envelope = null;
  try {
    envelope = JSON.parse(base64ToUtf8(raw));
  } catch {
    throw new Error("The synced file exists but isn't readable lexis data.");
  }
  return { envelope, sha: json.sha };
}

async function fetchBlob(gitUrl, token) {
  if (!gitUrl) throw new Error("The synced file is too large to read and has no blob link.");
  const resp = await ghFetch(gitUrl, token, { cache: "no-store" });
  if (!resp.ok) throw new Error(describeError(resp.status, await resp.text().catch(() => "")));
  const blob = await resp.json();
  if (blob.encoding !== "base64") {
    throw new Error("GitHub returned the synced file in an unexpected encoding.");
  }
  return blob.content ?? "";
}

async function putRemote({ token, owner, repo, path }, envelope, sha, message) {
  const url = `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(envelope, null, 2)),
  };
  if (sha) body.sha = sha;
  const resp = await ghFetch(url, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 409 || resp.status === 422) return { conflict: true };
  if (!resp.ok) throw new Error(describeError(resp.status, await resp.text().catch(() => "")));
  const json = await resp.json();
  return { conflict: false, sha: json.content?.sha ?? null };
}

/**
 * Creates the sync file for the first time, claiming this device's salt.
 *
 * Setting up two devices in the same sitting used to be quietly fatal: both
 * would see no file, both would mint their own salt, and the one that wrote
 * second could never decrypt what the first had written — so a correct
 * password was reported as wrong, forever. Writing immediately (with no SHA,
 * which GitHub rejects if the file already exists) turns that race into a
 * clean loss the caller can recover from by adopting the winner's salt.
 *
 * Returns false if another device got there first.
 */
export async function claimSalt(config, key, salt, bank) {
  const payload = await encryptJSON(key, bank);
  const result = await putRemote(
    config,
    makeEnvelope(salt, payload),
    null,
    "lexis: start sync"
  );
  return !result.conflict;
}

export function makeEnvelope(salt, payload) {
  return {
    lexis: ENVELOPE_VERSION,
    kdf: { algo: "PBKDF2-SHA256", salt, iterations: ITERATIONS },
    ...payload,
  };
}

/**
 * Confirms the repository exists and the token can see it.
 *
 * Deliberately does *not* try to pre-judge write access. A fine-grained token
 * with Contents: Read and write does not necessarily report `permissions.push`
 * on this endpoint, so treating that flag as authoritative risks refusing a
 * perfectly good token. The write itself is the real test: `putRemote` surfaces
 * a 403 with a clear message if the token turns out to be read-only.
 */
export async function checkAccess({ token, owner, repo }) {
  if (!token || !owner || !repo) {
    throw new Error("Fill in the owner, the repository, and the token.");
  }
  const resp = await ghFetch(`${API}/repos/${owner}/${repo}`, token);
  if (!resp.ok) throw new Error(describeError(resp.status, ""));
  const json = await resp.json();
  const warnings = [];
  if (json.private === false) {
    warnings.push(
      "That repository is public. Your data is encrypted, but a private repository is strongly preferred."
    );
  }
  if (json.permissions && json.permissions.push === false) {
    warnings.push("GitHub reports this token as read-only; saving may fail.");
  }
  return { ok: true, warning: warnings.join(" ") || null };
}

/**
 * Pulls, merges, and pushes in one pass.
 *
 * `localBank` is merged with whatever is on GitHub; the merged result is
 * returned so the caller can persist it locally *before* worrying about the
 * push. If another device wrote in between, the SHA check fails and we retry
 * from a fresh read rather than clobbering it.
 */
export async function syncOnce({ config, key, localBank, onStatus = () => {} }) {
  const MAX_ATTEMPTS = 3;
  let lastMerged = migrate(localBank);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onStatus(attempt === 1 ? "syncing…" : `retrying (${attempt})…`);

    const { envelope, sha } = await fetchRemote(config);

    let remoteBank = null;
    if (envelope) {
      if (envelope.lexis > ENVELOPE_VERSION) {
        throw new Error(
          "This file was written by a newer version of lexis. Update this device first."
        );
      }
      try {
        remoteBank = await decryptJSON(key, envelope);
      } catch {
        // Most often a different password, but the tag check fails the same
        // way for a truncated or hand-edited file — so don't assert a cause
        // that hasn't been established.
        throw new Error(
          "Could not decrypt the synced data. This usually means a different password was used on the other device."
        );
      }
    }

    const merged = remoteBank
      ? mergeBanks(lastMerged, remoteBank)
      : migrate(lastMerged);
    lastMerged = merged;

    // Nothing to push if the remote already matches the merge result.
    if (remoteBank && sameBank(remoteBank, merged)) {
      onStatus("up to date");
      return { bank: merged, pushed: false };
    }

    const salt = envelope?.kdf?.salt ?? config.salt;
    const payload = await encryptJSON(key, merged);
    const result = await putRemote(
      config,
      makeEnvelope(salt, payload),
      sha,
      `lexis: sync ${merged.words.length} word${merged.words.length === 1 ? "" : "s"}`
    );

    if (!result.conflict) {
      onStatus("synced");
      return { bank: merged, pushed: true };
    }
    // Someone else wrote first — loop and merge against their version.
  }

  throw new Error("Sync kept colliding with another device. Try again in a moment.");
}

/**
 * Structural comparison that ignores key order. Used only to skip
 * unnecessary writes, so a false negative costs one redundant commit.
 */
function sameBank(a, b) {
  return stable(a) === stable(b);
}
