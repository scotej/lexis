/**
 * The OpenRouter client and the AI features built on it.
 *
 * Everything here talks to https://openrouter.ai/api/v1 with a key the user
 * pastes into settings (see ai-settings.js for where it lives at rest). No
 * request is made unless that key exists, and the only thing ever sent is
 * what a feature needs: an essay draft, a word, the bank's headwords.
 *
 * The network discipline mirrors sync.js — a hostile network is normal, so
 * every request runs under a timeout with bounded, backing-off retries for
 * the transient failure modes (drops, stalls, 5xx, throttling) — while the
 * permanent ones (bad key, empty credits, unknown model) come back as plain,
 * specific errors the interface can show verbatim.
 *
 * Every completion also carries a routing constraint by default — see
 * privacyRouting() — because OpenRouter is a router, and an essay draft is
 * the student's own unpublished work.
 */

const API_BASE = "https://openrouter.ai/api/v1";

/**
 * Network-resilience knobs; tests shrink them with setAiNetworkOptions().
 *
 * Two timeouts, because there are two kinds of request here and one number
 * cannot serve both. `/key` and `/models` are lookups: a database read and a
 * catalogue, and forty-five seconds of waiting for either means the endpoint
 * is gone. A completion is a model *writing*, and since the token ceiling came
 * off and reasoning was invited in, that is routinely a minute or more of
 * honest work — timed out at forty-five seconds it read as "OpenRouter didn't
 * respond in time", which sent students to check a network that was fine.
 */
const net = {
  timeoutMs: 30000, // /key and /models: a lookup, not a composition
  completionTimeoutMs: 210000, // a model thinking, then writing; the slow ones take minutes
  retries: 2, // total attempts per request for *transient* failures
  backoffMs: 600,
  maxBackoffMs: 4000,
};

/** Which of the two timeouts a path is entitled to. */
function timeoutFor(path) {
  return path === "/chat/completions" ? net.completionTimeoutMs : net.timeoutMs;
}

export function setAiNetworkOptions(partial) {
  Object.assign(net, partial);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffDelay(attempt) {
  const base = Math.min(net.maxBackoffMs, net.backoffMs * 2 ** (attempt - 1));
  return base + Math.random() * net.backoffMs;
}

function retryAfterMs(resp) {
  const ra = resp.headers.get("retry-after");
  if (ra != null && ra !== "") {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  return null;
}

/** A retryable "the network, not the API, is the problem" error. */
function transientError(message, cause) {
  const err = new Error(message);
  err.transient = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * One OpenRouter request that cannot hang forever. Retries the transient
 * failure modes exactly the way sync does; surfaces everything else through
 * describeError so the message names the actual cause — an expired key reads
 * differently from an empty balance.
 *
 * The timeout deliberately spans the *whole* exchange, body included. A
 * server that sends its headers promptly and then stalls mid-body is a real
 * failure mode, and clearing the timer at the headers would leave the read
 * hanging forever with the interface stuck on "thinking…".
 */
async function apiFetch(path, apiKey, init = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    // The pair OpenRouter attributes an app by. X-Title alone leaves lexis
    // unlinked on their side; both together are what the docs ask for, and
    // neither carries anything about the person using it.
    "HTTP-Referer": "https://scotej.github.io/lexis/",
    "X-Title": "lexis",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.headers ?? {}),
  };
  const timeoutMs = timeoutFor(path);

  for (let attempt = 1; attempt <= net.retries; attempt++) {
    init.signal?.throwIfAborted();
    const last = attempt >= net.retries;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(init.signal.reason);
    init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    let text;
    try {
      resp = await fetch(url, { ...init, headers, signal: ctrl.signal });
      text = await resp.text();
    } catch (err) {
      init.signal?.throwIfAborted();
      if (last) {
        throw transientError(
          err?.name === "AbortError"
            ? `OpenRouter didn’t respond within ${Math.round(timeoutMs / 1000)}s — the model may be slower than lexis waits. Try a faster one.`
            : "Couldn’t reach OpenRouter (network problem).",
          err
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }

    // Throttling and server trouble are worth one polite retry.
    if ((resp.status === 429 || resp.status >= 500) && !last) {
      const wait = retryAfterMs(resp);
      if (wait == null || wait <= net.maxBackoffMs) {
        await sleep(wait ?? backoffDelay(attempt));
        continue;
      }
    }
    return { ok: resp.ok, status: resp.status, text };
  }
  // Unreachable: every path above returns or throws.
  throw transientError("Couldn’t reach OpenRouter.");
}

/**
 * "Nothing matched your routing constraints", in the shapes OpenRouter says it
 * — it names endpoints, providers, or the data policy depending on the route.
 *
 * Strict privacy can empty the pool for a narrowly-hosted model. Left
 * unexplained that reads as "this model is broken" — it isn't, and the way
 * out is one checkbox away, so the message says which one.
 */
function noEndpointsLeft(status, detail) {
  if (status !== 404 && status !== 400) return false;
  return (
    /\bno (?:allowed |eligible |available )?(?:endpoints?|providers?)\b/i.test(detail) ||
    /\bdata policy\b/i.test(detail)
  );
}

/**
 * Turns a non-2xx response into the most specific honest message available.
 *
 * `strict` says whether this request actually carried the privacy constraint.
 * Without it an unrelated 404 would be blamed on a setting the student had
 * already turned off — sending them to uncheck a box that is not checked.
 */
function describeError(status, text, { strict = false } = {}) {
  let detail = "";
  try {
    const body = JSON.parse(text ?? "");
    const raw = body?.error?.message ?? (typeof body?.error === "string" ? body.error : "");
    // An `error.message` is not always a string — some gateways nest an object
    // there, and interpolating one prints "[object Object]" at the student.
    detail = typeof raw === "string" ? raw : "";
  } catch {
    /* HTML error pages and empty bodies happen */
  }

  if (strict && noEndpointsLeft(status, detail)) {
    return (
      "No provider for this model meets the privacy setting (no training on your " +
      "text, nothing retained). Pick another model, or turn off strict privacy in AI assist."
    );
  }

  switch (status) {
    case 401:
      return "OpenRouter rejected the key — it may have been revoked or mistyped.";
    case 402:
      // Two situations answer to 402 — a balance spent, and a key that never
      // had one because it only ever bought free models — and only OpenRouter
      // knows which. Its own words go first, because "add credits" is advice
      // for the first and a misdiagnosis of the second.
      return detail
        ? `OpenRouter wouldn’t bill this request — ${detail}`
        : "This OpenRouter key has run out of credits. Add credits at openrouter.ai/credits.";
    case 403:
      return detail || "The request was refused (moderation or key restrictions).";
    case 408:
    case 504:
      // The gateway gave up waiting on the provider. Naming it as a timeout
      // beats "OpenRouter returned 504": the fix is a different model, not a
      // different key.
      return detail || "The model took too long to answer. Try again, or pick a faster model.";
    case 429:
      // A bare "429" reads as a fault. It is a queue, and the two ways out —
      // wait, or stop sharing a free model with the world — are worth saying.
      return detail
        ? `Rate-limited by OpenRouter — ${detail}`
        : "Rate-limited by OpenRouter. Wait a moment, or pick a model with more capacity.";
    default:
      return detail
        ? `OpenRouter returned ${status} — ${detail}`
        : `OpenRouter returned ${status}.`;
  }
}

/**
 * A refusal OpenRouter itself issued, tagged with the status that caused it.
 *
 * The message is for the student and says everything they need; the number is
 * for the one caller that has somewhere else to go. Related-meanings ordering
 * asks for embeddings, every embedding model on OpenRouter is paid, and a key
 * that only buys free models therefore gets 402 for a feature it could still
 * have by another route — but it can only take that route if it can recognise
 * the refusal, and "402" survives rewording where a message does not.
 */
function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function apiJSON(path, apiKey, init = {}, opts = {}) {
  const { ok, status, text } = await apiFetch(path, apiKey, init);
  if (!ok) throw apiError(status, describeError(status, text, opts));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("OpenRouter sent a reply we couldn’t read.");
  }
}

/* ---- what this session has spent ----
 *
 * The settings panel can show a balance, but only by asking OpenRouter. This
 * ledger costs nothing: every completion already reports its own token usage,
 * so the running total for the session is free to keep and answers the
 * question the balance can't — "what have I spent *since I opened the app*".
 */

const session = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };

function recordUsage(usage) {
  session.requests += 1;
  session.promptTokens += Number(usage?.prompt_tokens ?? 0) || 0;
  session.completionTokens += Number(usage?.completion_tokens ?? 0) || 0;
  // `cost` arrives because the request asked for usage accounting — but an
  // absent one is still not a zero, so an unpriced reply adds nothing rather
  // than pretending the asking was free.
  session.cost += Number(usage?.cost ?? 0) || 0;
}

/** A snapshot of what this session has asked for. */
export function aiSessionUsage() {
  return { ...session, totalTokens: session.promptTokens + session.completionTokens };
}

export function resetAiSessionUsage() {
  session.requests = 0;
  session.promptTokens = 0;
  session.completionTokens = 0;
  session.cost = 0;
}

/** Semantic vectors use an embedding model, independently of the chat model. */
export async function aiEmbedWords(settings, input, { signal } = {}) {
  if (!settings?.key) throw new Error("Add your OpenRouter key in AI assist first.");
  const provider = privacyRouting(settings);
  const data = await apiJSON("/embeddings", settings.key, {
    method: "POST",
    signal,
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input,
      dimensions: 256,
      encoding_format: "float",
      ...(provider ? { provider } : {}),
    }),
  }, { strict: Boolean(provider) });
  recordUsage(data?.usage);
  const rows = data?.data;
  const invalid = () => new Error("OpenRouter returned incomplete or invalid word embeddings. Try again.");
  if (!Array.isArray(rows) || rows.length !== input.length) throw invalid();
  const vectors = new Array(input.length);
  let dimensions;
  for (const row of rows) {
    const { index, embedding } = row ?? {};
    if (!Number.isInteger(index) || index < 0 || index >= input.length || vectors[index] ||
        !Array.isArray(embedding) || !embedding.length ||
        embedding.some(value => !Number.isFinite(value))) throw invalid();
    dimensions ??= embedding.length;
    const magnitude = Math.hypot(...embedding);
    if (embedding.length !== dimensions || !Number.isFinite(magnitude) || magnitude === 0) throw invalid();
    vectors[index] = embedding.map(value => value / magnitude);
  }
  return vectors;
}

/* ---- the chat completion core ---- */

/**
 * The assistant's reply as text. Most routes answer with a plain string, but
 * some hand back an array of content parts (and a refusal hands back none at
 * all) — shapes that must read as "nothing came back" rather than throwing a
 * TypeError on `.trim()` in front of the student.
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return "";
}

/**
 * A model's own words for why it declined, when it gives any.
 *
 * A refusal arrives as an empty `content` beside a populated `refusal`.
 * Reporting it as "empty response" tells the student their key or the network
 * misbehaved, which sends them to fix something that isn't broken.
 */
function refusalText(message) {
  const refusal = message?.refusal;
  if (typeof refusal !== "string") return "";
  // Model-written text, so it has no length OpenRouter's own errors are held
  // to; a paragraph of it in the status line would push the form off screen.
  const trimmed = refusal.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 239)}…` : trimmed;
}

/**
 * Where the request is allowed to be routed.
 *
 * The person using this is a student sending unpublished school work to a
 * router that picks a provider per request, and some providers keep — and
 * train on — what they are sent. So the default is to exclude them, and
 * turning that off is a deliberate choice made in settings rather than a
 * default nobody was told about. Absent the flag entirely (settings saved
 * before the option existed) still counts as on.
 */
export function privacyRouting(settings) {
  return settings?.strictPrivacy === false
    ? null
    : { data_collection: "deny", zdr: true };
}

/**
 * One completion, plus the one fact a caller needs to read a bad answer: the
 * model was still talking when the token limit stopped it.
 *
 * There is no `max_tokens`. There used to be one per feature, worked out from
 * how long the answer ought to be — a reasonable-looking sum and a wrong one,
 * because the ceiling covers reasoning *and* answer together and the reasoning
 * goes first. A request for three short passages allowed 500 tokens, met a
 * model that spent 523 of them thinking, and came back with the field empty.
 * Rationing the part that has to happen before the answer only ever buys an
 * empty answer, so nothing here is rationed: the provider's own limit is the
 * limit.
 *
 * And reasoning is asked for rather than suppressed. None of this is a race,
 * the answers are better for the thinking, and it arrives in its own field —
 * `messageText()` reads `content`, so a model's deliberation never reaches
 * the parser.
 */
async function complete(settings, { system, prompt, temperature = 0.4, signal }) {
  if (!settings?.key) throw new Error("Add your OpenRouter key in AI assist first.");
  signal?.throwIfAborted();
  const body = {
    model: normalizeModel(settings.model),
    temperature,
    reasoning: { enabled: true },
    // Usage accounting, which OpenRouter only does when asked. Without this
    // flag a reply carries token counts but no `cost`, so the session ledger
    // added nothing up and the panel's "what this has cost you" line was
    // permanently, wrongly, silent. It costs no extra request — the figure
    // rides back on the completion itself.
    usage: { include: true },
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  };
  const provider = privacyRouting(settings);
  if (provider) body.provider = provider;

  const ask = (payload) =>
    apiJSON(
      "/chat/completions",
      settings.key,
      { method: "POST", signal, body: JSON.stringify(payload) },
      { strict: Boolean(provider) }
    );

  let data;
  try {
    data = await ask(body);
  } catch (err) {
    // Some endpoints refuse to be told about reasoning at all, exactly as
    // others refuse to have it turned off ("reasoning is mandatory for this
    // endpoint and cannot be disabled" is a real 400 from this pool). Neither
    // opinion is worth failing a student's request over, so the field comes
    // off and the ask goes again without it.
    if (!/reasoning/i.test(String(err?.message ?? ""))) throw err;
    const { reasoning, ...plain } = body;
    data = await ask(plain);
  }
  recordUsage(data?.usage);
  const choice = data?.choices?.[0];
  const text = messageText(choice?.message);
  if (!text.trim()) {
    throw new Error(refusalText(choice?.message) || "OpenRouter returned an empty response.");
  }
  return { text: text.trim(), truncated: choice?.finish_reason === "length" };
}

/**
 * One completion, as text. Kept as the plain shape callers outside this
 * module's own features expect.
 */
export async function chat(settings, options) {
  return (await complete(settings, options)).text;
}

/**
 * A completion parsed as the JSON every feature here asks for.
 *
 * A reply the token limit cut off mid-structure is the one failure worth
 * naming separately. It used to surface as "the response wasn't the shape we
 * asked for. Try again." — wrong about the cause, and useless as advice,
 * since the retry is cut off in exactly the same place. The check runs only
 * once parsing has actually failed, because a model that finishes its JSON
 * and is then cut off part-way through a sign-off has still answered.
 */
async function chatJSON(settings, options) {
  const { text, truncated } = await complete(settings, options);
  try {
    return parseJSONLoose(text);
  } catch (err) {
    if (!truncated) throw err;
    throw new Error(
      "The answer was cut off before it finished. Try again — and if it keeps happening, send a shorter draft."
    );
  }
}

/* ---- key + catalogue ---- */

/** Key facts: label, spend, and remaining credit. Cheap enough to show inline. */
export async function fetchKeyInfo(apiKey) {
  const data = await apiJSON("/key", apiKey);
  const d = data?.data ?? {};
  const usage = Number(d.usage ?? 0);
  // An absent/null limit means "no cap" — Number(null) would read as 0 and
  // make an unlimited key look bankrupt.
  const limit = d.limit == null ? null : Number(d.limit);
  return {
    label: d.label ?? "",
    usage,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - usage),
    freeTier: Boolean(d.is_free_tier),
  };
}

/** The model catalogue, cheapest-reasonable sort is the caller's problem. */
export async function fetchModels(apiKey) {
  const data = await apiJSON("/models", apiKey);
  const rows = Array.isArray(data?.data) ? data.data : [];
  const models = [];
  for (const m of rows) {
    const id = typeof m?.id === "string" && m.id ? m.id : m?.canonical_slug;
    // A row with no usable id can only break the callers that match on one:
    // the datalist would offer "undefined", and the save-time check would
    // throw reading `.includes` off it.
    if (typeof id !== "string" || !id) continue;
    models.push({
      id,
      name: typeof m.name === "string" && m.name ? m.name : id,
      context: m.context_length ?? null,
      pricing: m.pricing ?? null,
    });
  }
  return models;
}

/** Accepts bare ids and full openrouter.ai/c/<model> URLs pasted in haste.
 * A blank model is not an error at request time: it means "let OpenRouter
 * route it" (their `openrouter/auto`). Only an explicit empty *setting* with
 * no default falls back here. */
export function normalizeModel(model) {
  const m = String(model ?? "").trim();
  if (!m) return "openrouter/auto";
  const withoutScheme = m.replace(/^https?:\/\/openrouter\.ai\/(?:c\/)?/, "");
  return withoutScheme.replace(/^\/+/, "");
}

/* ---- tolerant output parsing ----
 *
 * Models are asked for JSON, and well-behaved ones comply — but a wrapper
 * fence, a chatty preamble, or single quotes must degrade gracefully rather
 * than showing the student a stack trace.
 */

/**
 * JSON.parse, but only an object or array counts as an answer.
 *
 * `null`, `42` and `true` all parse cleanly and then blow up in every caller,
 * which reads a field off the result — a bare TypeError in the student's face
 * instead of the "try again" this module promises. Returns undefined for
 * anything unusable so the next candidate gets its turn.
 */
function parseJSONObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A line that is nothing but a markdown fence, opening or closing.
 *
 * Stripping fences by line rather than by substring is what keeps a draft
 * that happens to discuss code intact: `{"detail": "wrap it in ``` marks"}`
 * is a perfectly good answer, and a global replace of every ``` in the text
 * quietly ate the student's own words out of the middle of it. JSON forbids a
 * raw newline inside a string, so a fence that occupies a whole line is never
 * part of a value — which makes this the one safe place to cut.
 */
const FENCE_LINE = /^[ \t]*```[A-Za-z0-9_+-]*[ \t]*$/;

function stripFenceLines(text) {
  if (!text.includes("```")) return text;
  const lines = text.split(/\r?\n/);
  return lines.some((line) => FENCE_LINE.test(line))
    ? lines.filter((line) => !FENCE_LINE.test(line)).join("\n")
    : text;
}

/**
 * The balanced JSON value that starts at `from`, or "" if it never closes.
 *
 * Counting depth — and knowing when it is inside a string — is the whole
 * point. Reaching for the *last* closing brace in the text instead is what
 * broke on the commonest chatty reply there is: a clean object followed by
 * “Tell me if you want more on {structure}.” takes the brace out of the
 * sign-off, and the JSON in front of it is thrown away with it.
 */
function balancedSlice(text, from) {
  const opener = text[from];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return text.slice(from, i + 1);
  }
  return ""; // ran off the end: the answer was cut short mid-structure
}

/** How many openers are worth trying before calling the reply unreadable. */
const MAX_JSON_CANDIDATES = 20;

/**
 * An object or array with nothing in it: parseable, but never the answer.
 *
 * Kept apart because a model that thinks out loud writes its own schema
 * first — “…each having "text": string and "words": string[]” — and that bare
 * `string[]` ends in a perfectly valid empty array. Reached before the real
 * JSON further down the reply, it wins, and every caller then reads an empty
 * list off it and reports that nothing came back.
 */
function isEmptyValue(value) {
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/** Pulls the outermost JSON object or array out of whatever came back. */
export function parseJSONLoose(text) {
  const cleaned = stripFenceLines(String(text ?? "").replace(/^\uFEFF/, "")).trim();

  const attempt = (candidate) =>
    parseJSONObject(candidate) ??
    parseJSONObject(candidate.replace(/,\s*([}\]])/g, "$1")); // trailing commas

  // Each opening brace or bracket in turn, outermost first: a preamble may
  // contain one of its own (“Sure {here}: {…}”), so the first candidate
  // is not always the answer.
  //
  // An empty one is held back rather than returned, because it is only the
  // answer if nothing else parses. It costs nothing to skip, either: an empty
  // value is at most an opener, whitespace and its closer, so it can never be
  // the expensive candidate MAX_JSON_CANDIDATES exists to bound — and counting it
  // would let a paragraph of reasoning exhaust the search before the search
  // ever reached the JSON underneath it.
  let fallback;
  let tried = 0;
  for (let i = 0; i < cleaned.length && tried < MAX_JSON_CANDIDATES; i++) {
    const ch = cleaned[i];
    if (ch !== "{" && ch !== "[") continue;
    const slice = balancedSlice(cleaned, i);
    if (!slice) continue;
    const value = attempt(slice);
    if (value === undefined) {
      tried++;
      continue;
    }
    if (!isEmptyValue(value)) return value;
    fallback ??= value;
  }

  const whole = attempt(cleaned);
  if (whole !== undefined && !isEmptyValue(whole)) return whole;
  if (fallback !== undefined) return fallback;
  if (whole !== undefined) return whole;
  throw new Error("The response wasn’t the shape we asked for. Try again.");
}

/** **bold**, __bold__, and *emphasis* markers are for humans, not interfaces. */
export function stripEmphasis(text) {
  return String(text ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)\*(?!\s)([^*]+?)\*/g, "$1$2");
}

function asString(value) {
  const s = stripEmphasis(String(value ?? "").trim());
  return s;
}

/**
 * Whether a field a model was asked for as a boolean actually says yes.
 *
 * Models answer booleans in JSON with strings about as often as with booleans,
 * and `"false"` is a perfectly ordinary truthy value. A guard written as "not
 * literally `false`" therefore lets both the string and the missing field
 * through, which is the wrong direction for every use here: absent evidence is
 * not consent.
 */
function affirms(value) {
  if (typeof value === "string") return /^(?:true|yes|y|1)$/i.test(value.trim());
  return value === true || value === 1;
}

function asStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : item?.text ?? item?.point ?? ""))
    .map(asString)
    .filter(Boolean)
    .slice(0, limit);
}

/* ---- shared prompt framing ---- */

const REGISTER = [
  "You are a precise, encouraging writing tutor for an Australian VCE English student.",
  "Their teacher values formal, analytical prose: exact verbs, concrete evidence, developed analysis.",
  "Be concrete and specific; quote the student's own words when you refer to them.",
  "Never invent quotations that are not in the material you are given.",
].join(" ");

/**
 * What the answer has to look like, said plainly enough to survive thinking.
 *
 * "Respond with JSON only" was written for a model that answers the instant
 * it is asked. Models here are now invited to think first, and a rule that
 * reads as "do not write anything but JSON" is in tension with that — so the
 * two are separated: think as long as you like, and then let the *reply* be
 * the object. Naming the fields as required, with a stated empty value, is
 * what stops the other half of the trouble: a shape that arrives a key short
 * and reads downstream as a blank answer.
 */
function jsonOnlyInstruction(schemaHint) {
  return [
    "Think it through for as long as you need to.",
    "Your reply itself must then be one JSON object and nothing else:",
    "no words before it, no markdown fences around it, no commentary after it.",
    `Shape: ${schemaHint}.`,
    "Include every field named there — where you have nothing for one, give an empty string or an empty list rather than dropping it.",
  ].join(" ");
}

/* ---- feature: essay review ---- */

const ESSAY_MAX_CHARS = 40000;

/**
 * A structured read of the draft: what works, what to fix, and what to do
 * next. The bank's headwords ride along so the tutor can suggest where the
 * student's own vocabulary belongs.
 */
export async function aiEssayReview(settings, { essay, bankWords = [], topicNote = "" }) {
  const text = String(essay ?? "");
  if (!text.trim()) throw new Error("There’s no essay to review yet.");
  const trimmed = text.length > ESSAY_MAX_CHARS ? text.slice(0, ESSAY_MAX_CHARS) : text;

  const bankList = bankWords.slice(0, 200).join(", ");
  const prompt = [
    "Review this draft.",
    topicNote ? `The assignment context: ${topicNote}` : "",
    bankList
      ? `These words are in the student's personal vocabulary bank; point out natural openings to use any of them: ${bankList}.`
      : "",
    "Return this JSON shape:",
    '{"summary": string, "strengths": string[], "improvements": [{"title": string, "detail": string}], "focus": string[]}',
    '"summary" is two or three sentences on the draft as a whole.',
    '"strengths" lists up to three things already working, each one sentence.',
    '"improvements" lists three to five concrete fixes ranked by impact; "detail" quotes the draft where relevant and says what to do instead.',
    '"focus" lists two or three things to practise in the next draft, each a short phrase.',
    "",
    "DRAFT:",
    trimmed,
  ]
    .filter(Boolean)
    .join("\n\n");

  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction(
      '{summary, strengths: string[], improvements: [{title, detail}], focus: string[]}'
    )}`,
    prompt,
    temperature: 0.6,
  });

  const improvements = Array.isArray(parsed.improvements)
    ? parsed.improvements
        .map((imp) => ({
          title: asString(typeof imp === "string" ? "" : imp?.title),
          detail: asString(typeof imp === "string" ? imp : imp?.detail),
        }))
        .filter((imp) => imp.title || imp.detail)
        .slice(0, 8)
    : [];

  const summary = asString(parsed.summary);
  const strengths = asStringArray(parsed.strengths, 5);
  const focus = asStringArray(parsed.focus, 5);
  if (!summary && !strengths.length && !improvements.length) {
    throw new Error("The response didn’t contain any readable feedback. Try again.");
  }
  return { summary, strengths, improvements, focus };
}

/* ---- feature: similar words ---- */

/**
 * Kindred words for analytical writing. Deliberately *not* plain thesaurus
 * synonyms: each comes with a register note saying when it fits, which is
 * what a corpus listing can't tell you.
 */
export async function aiSimilarWords(settings, word) {
  const w = String(word ?? "").trim();
  if (!w) throw new Error("Name a word first.");
  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{words: [{"word": string, "note": string}]}')}`,
    prompt: [
      `Give six to eight words close in meaning to “${w}” that would suit formal analytical writing.`,
      'For each, "note" explains the difference in tone, intensity, or typical use in one short clause — what a thesaurus never tells you.',
      "Prefer precise upgrades over obscure ones; include one plainer option where useful.",
      "Exclude “" + w + "” itself and simple inflections of it.",
    ].join("\n"),
    temperature: 0.5,
  });

  const words = Array.isArray(parsed.words) ? parsed.words : Array.isArray(parsed) ? parsed : [];
  const seen = new Set();
  const out = [];
  for (const row of words) {
    const entry =
      typeof row === "string"
        ? { word: row, note: "" }
        : { word: asString(row?.word), note: asString(row?.note) };
    const key = entry.word.toLowerCase();
    if (!entry.word || key === w.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= 10) break;
  }
  if (!out.length) throw new Error("No usable alternatives came back. Try again.");
  return { words: out };
}

/* ---- feature: example sentences ---- */

const CONTEXT_CHARS = 2400;

/**
 * Exactly the draft excerpt aiExampleSentences() sends as context.
 *
 * Exported because the caller caches answers against the seed that shaped
 * them: a second copy of this rule on that side would drift from this one and
 * silently hand back sentences written about a paragraph since deleted.
 */
export function exampleContext(context) {
  return String(context ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONTEXT_CHARS);
}

/**
 * Three sentences using the word the way an analytical essay would. When the
 * student has a draft underway, its opening rides along as context, so the
 * examples speak about *their* text rather than a generic novel.
 */
export async function aiExampleSentences(settings, { word, context = "" }) {
  const w = String(word ?? "").trim();
  if (!w) throw new Error("Name a word first.");
  const excerpt = exampleContext(context);
  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{sentences: string[]}')}`,
    prompt: [
      `Write three original sentences that use “${w}” the way a strong analytical essay would.`,
      excerpt
        ? `They should suit this piece the student is writing:\n"""${excerpt}"""`
        : "Keep them generic enough to fit literary-analysis writing, but never mention that they are generic.",
      "Vary sentence openings. No numbering, no explanation outside the JSON.",
    ].join("\n"),
    temperature: 0.7,
  });

  const sentences = asStringArray(
    Array.isArray(parsed.sentences) ? parsed.sentences : Array.isArray(parsed) ? parsed : [],
    6
  );
  if (!sentences.length) throw new Error("No sentences came back. Try again.");
  return { sentences };
}

/* ---- feature: passages to type ---- */

/** Character bounds for the four length classes the typing test offers. */
const PASSAGE_BOUNDS = {
  short: [45, 100],
  medium: [110, 300],
  long: [320, 600],
  thicc: [620, 1100],
};

/**
 * The voice a typing passage is written in, which is deliberately not the
 * tutor's.
 *
 * Everywhere else in this module the model is speaking *to* a student about
 * their own writing, and REGISTER holds it there: analytical, careful, quoting
 * the draft back. A passage is addressed to nobody. It is something to type,
 * and it sits beside a corpus of film dialogue, novels, speeches and proverbs
 * chosen because they are worth typing. Held to the tutor's register it wrote
 * the same batch every time — three paragraphs on criticism and machination,
 * whatever the bank words were — which is a dull thing to meet at speed.
 */
const PASSAGE_REGISTER = [
  "You write short passages for a typing test: clear, well-made prose that is a pleasure to type.",
  "Range widely — narrative, description, argument, reportage, reflection, an aside with some wit in it.",
  "Vary the subject and the voice from one passage to the next; three turns around one theme is one passage.",
].join(" ");

/**
 * Characters per word, the space after it included.
 *
 * A length class is measured in characters, but it cannot be *asked for* in
 * characters: a model never sees them, only tokens, so “between 110 and 300
 * characters — count them” asks for a number it can only guess at. It guesses
 * high. Passages of 420–440 characters came back for a class that stops at
 * 300, and every one was discarded — a whole batch thrown away, which is the
 * failure this constant exists to prevent. Worse, the instruction to count
 * sends a model that reasons aloud into doing exactly that, at length, instead
 * of writing.
 *
 * Words it can hold to, because words are what it emits. Analytical prose runs
 * a little over five letters a word; six with the space is close enough for a
 * budget whose only job is to land inside a range nearly three times as wide
 * as it is tall.
 */
const CHARS_PER_WORD = 6;

function wordBudget([lo, hi]) {
  // Eight words is the floor: below it the arithmetic starts asking for
  // sentences too short to be prose at all.
  return { lo: Math.max(8, Math.round(lo / CHARS_PER_WORD)), hi: Math.round(hi / CHARS_PER_WORD) };
}

/**
 * The character windows a passage may land in to be worth keeping.
 *
 * Plural, because the typist picks a *set* of lengths and a batch is written
 * for one of them. A passage aimed at medium that comes out long is still
 * exactly what was asked for if long is ticked too — judging it against only
 * the class it was aimed at threw that away, and when a batch overshot
 * together, as batches do, it threw away every passage in it. Someone who has
 * ticked every length should never see an empty batch, and now doesn't: the
 * four windows meet, so they cover 36 characters to 1375 without a gap.
 */
function acceptedWindows(classes) {
  const windows = classes
    .map((name) => PASSAGE_BOUNDS[name])
    .filter(Boolean)
    .map(([lo, hi]) => [lo * 0.8, hi * 1.25]);
  return windows.length ? windows : [[PASSAGE_BOUNDS.medium[0] * 0.8, PASSAGE_BOUNDS.medium[1] * 1.25]];
}

/**
 * Only what a keyboard has keys for.
 *
 * The corpus is built ASCII-clean; a model is not, and it reaches for typographic
 * quotes and em dashes unprompted. A curly apostrophe in a typing test is an
 * error the typist cannot correct, so it is flattened here rather than being
 * left for the engine's lazy mode to maybe catch.
 */
function typeable(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/…/g, "...")
    .replace(/[—―]/g, " - ")
    .replace(/[–‐‑−]/g, "-")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Passages written to be typed, using words the student is trying to learn.
 *
 * This is the one AI feature here that is asked for *ahead* of being wanted —
 * the caller keeps a few in hand so the next test starts instantly (see
 * prefetch.js). That shapes the request: several at once, because one round
 * trip for four passages costs a fraction of four round trips, and a batch is
 * what a cache wants anyway.
 *
 * What leaves the device is the requested length and the bank words to build
 * around — the same headwords essay review already sends, and no draft.
 */
export async function aiQuotes(
  settings,
  { bankWords = [], length = "medium", count = 3, avoid = [], accept = [] } = {}
) {
  const bounds = PASSAGE_BOUNDS[length] ?? PASSAGE_BOUNDS.medium;
  const budget = wordBudget(bounds);
  // What the batch is written for, and what it may come back as.
  const classes = accept.length ? accept : [length];
  const windows = acceptedWindows(classes);
  const wanted = Math.min(6, Math.max(1, Math.round(count)));
  const words = bankWords
    .map((word) => String(word ?? "").trim())
    .filter(Boolean)
    .slice(0, 40);

  const parsed = await chatJSON(settings, {
    system: `${PASSAGE_REGISTER} ${jsonOnlyInstruction('{passages: [{"text": string, "words": string[]}]}')}`,
    prompt: [
      `Write ${wanted} original passages for a typing practice test.`,
      // Length is a target, not a gate. It reads as a gate to a model — "must
      // be between" produced passages counted out to the letter and stiff with
      // it — and the one that matters is applied here anyway, on what comes
      // back. So this asks the way you would ask a person: roughly this long.
      `Aim for around ${Math.round((budget.lo + budget.hi) / 2)} words each — anywhere from about ${budget.lo} to ${budget.hi} sits comfortably, and a little either side of that is no disaster. Where you are torn, the shorter one is the safer guess.`,
      words.length
        ? `These are the words the typist is learning: ${words.join(", ")}. Two or three a passage is about right, inflected however the sentence wants them — but only where one genuinely belongs. A passage carrying one word well beats a passage straining to carry three. "words" lists the ones it actually used.`
        : 'Write on whatever subjects you like. "words" may be empty.',
      // The two rules the typing test itself imposes, and the reason they are
      // the only firm ones here: a line break or a curly quote is a keystroke
      // the typist cannot make, which is an error they cannot correct.
      "Keep each passage on a single line, as continuous prose — no line breaks, no lists, no headings.",
      "Stay inside what a standard keyboard can type: straight quotes and apostrophes, no em dashes, no accented letters.",
      avoid.length ? `Do not repeat the openings you have used before: ${avoid.slice(0, 8).join(" / ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    temperature: 0.95, // variety is the point; four near-identical passages are one passage
  });

  const rows = Array.isArray(parsed.passages)
    ? parsed.passages
    : Array.isArray(parsed)
      ? parsed
      : [];

  const seen = new Set();
  const out = [];
  let missized = 0;
  for (const row of rows) {
    const text = typeable(stripEmphasis(typeof row === "string" ? row : row?.text));
    if (!text) continue;
    // A word budget lands far closer than a character count did, but "close"
    // is not "inside": a model asked for fifty words still sometimes sends
    // ninety. Length is the whole basis of the length setting, so a passage
    // outside every length the typist asked for is dropped rather than filed
    // under one they didn't.
    if (!windows.some(([lo, hi]) => text.length >= lo && text.length <= hi)) {
      missized++;
      continue;
    }
    const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text,
      words: asStringArray(typeof row === "string" ? [] : row?.words, 10).map((w) => w.toLowerCase()),
    });
  }

  if (!out.length) {
    // "Try again" is the wrong advice when the batch was good prose that
    // simply came out the wrong size — the same model, at this temperature,
    // will do it again, and the typist presses the button all afternoon. Only
    // one of these two failures is worth a second press, so they say so.
    const where = classes.length === 1 ? `at the ${classes[0]} length` : "at any length you have picked";
    throw new Error(
      missized
        ? `The model wrote ${missized === 1 ? "a passage" : `${missized} passages`}, but nothing ${where}. ` +
          "Try another length, or a model that holds to a budget."
        : "No usable passages came back. Try again."
    );
  }
  return { passages: out };
}

/* ---- feature: nuance comparison ---- */

/**
 * One spelling rule for both sides of the match below.
 *
 * The model echoes a headword back with its own punctuation and accents, and
 * the words asked about are not always one bare ASCII token — “ad hominem”,
 * “naïve”, “cliché” are all ordinary bank entries. Folding both sides the same
 * way is what stops a perfectly good answer being dropped on the floor.
 */
function canonWord(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Splits near-synonyms apart: what each word claims, connotes, and costs.
 * This is the question students actually ask — “can I swap these?”
 */
export async function aiNuance(settings, words) {
  const list = (Array.isArray(words) ? words : String(words ?? "").split(/[;,/]/))
    .map((w) => String(w ?? "").trim())
    .filter(Boolean);
  const unique = [...new Set(list.map((w) => w.toLowerCase()))];
  if (unique.length < 2) throw new Error("Give at least two words to compare.");
  if (unique.length > 6) throw new Error("Compare up to six words at a time.");

  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{distinctions: [{"word": string, "nuance": string}], "guidance": string}')}`,
    prompt: [
      `A student is choosing between these near-interchangeable words: ${unique.join(", ")}.`,
      'For each, "nuance" states in one or two sentences what it specifically implies and where it would feel wrong.',
      '"guidance" then says in one or two sentences which to prefer for analytical essay writing, and why.',
    ].join("\n"),
    temperature: 0.4,
  });

  const byWord = new Map();
  const rows = Array.isArray(parsed.distinctions) ? parsed.distinctions : [];
  for (const row of rows) {
    const word = canonWord(asString(row?.word));
    const nuance = asString(row?.nuance);
    if (word && nuance) byWord.set(word, nuance);
  }
  const distinctions = unique.map((word) => ({
    word,
    nuance: byWord.get(canonWord(word)) ?? "",
  }));
  const guidance = asString(parsed.guidance);
  if (!guidance && distinctions.every((d) => !d.nuance)) {
    throw new Error("The comparison came back empty. Try again.");
  }
  return { distinctions, guidance };
}

/* ---- feature: grouping a bank by theme ---- */

/** How many words one grouping request carries. */
const THEME_MAX_WORDS = 60;

/**
 * Which of these words belong together, for when vectors are out of reach.
 *
 * Related-meanings ordering is an embeddings job and stays one where it can
 * be: a distance between every pair is exactly what "put like beside like"
 * wants, and no amount of prose replaces it. But every embedding model
 * OpenRouter carries is a paid one, and a key that has only ever bought free
 * models cannot call a single one of them — so the feature was unreachable
 * for those keys, and announced itself in the one way that reads as the
 * student's own fault: "this key has run out of credits", about a model they
 * never chose and a balance that was never spent.
 *
 * A chat model can still answer the question underneath, provided it is asked
 * in the shape models are reliable at. Not "sort these hundred words", which
 * invites a permutation with a word missing from the middle of it, but "say
 * which of these belong together" — names come back, and they are matched
 * against the bank here rather than trusted. A name the model invents, repeats
 * or spells its own way costs nothing, and a word it forgets is the caller's
 * to place, because the order is assembled from the bank and never from the
 * reply.
 */
export async function aiGroupWordsByTheme(settings, entries, { signal, knownThemes = [] } = {}) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) =>
      typeof entry === "string"
        ? { word: asString(entry), detail: "" }
        : { word: asString(entry?.word), detail: asString(entry?.detail) }
    )
    .filter((row) => row.word);
  if (!rows.length) return [];
  if (rows.length > THEME_MAX_WORDS) {
    throw new Error(`Group up to ${THEME_MAX_WORDS} words at a time.`);
  }

  // The words still looking for a group, under the folded spelling the match
  // below uses — so the reply may say “Naïve” for an entry filed as “naive”.
  const pending = new Map();
  for (const row of rows) {
    const key = canonWord(row.word);
    if (key && !pending.has(key)) pending.set(key, row.word);
  }

  const reuse = asStringArray(knownThemes, 24);
  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{groups: [{"theme": string, "words": string[]}]}')}`,
    signal,
    temperature: 0.2,
    prompt: [
      "Group these words by what they are about, so a reader meeting them in order stays in one area of meaning at a time.",
      '"theme" is a short noun phrase — two or three words — naming what a group shares.',
      "Put every word into exactly one group, spelled as it is given below, and add no word that is not in the list.",
      "Aim for groups of three to eight. A word that fits nowhere takes a group of its own rather than a wrong home.",
      reuse.length
        ? `Earlier words were grouped under these themes — reuse any that fit rather than coining a near-duplicate: ${reuse.join("; ")}.`
        : "",
      "",
      "WORDS:",
      rows.map((row) => `- ${row.word}${row.detail ? `: ${row.detail}` : ""}`).join("\n"),
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const groups = Array.isArray(parsed.groups) ? parsed.groups : Array.isArray(parsed) ? parsed : [];
  const out = [];
  for (const group of groups) {
    const theme = asString(typeof group === "string" ? "" : group?.theme);
    if (!theme) continue;
    const members = [];
    for (const name of asStringArray(group?.words, THEME_MAX_WORDS)) {
      const key = canonWord(name);
      const word = pending.get(key);
      // Absent means invented, already placed, or simply not ours. All three
      // are the same instruction: leave it out and keep going.
      if (word === undefined) continue;
      pending.delete(key);
      members.push(word);
    }
    if (members.length) out.push({ theme, words: members });
  }
  if (!out.length) throw new Error("Nothing came back that grouped these words. Try again.");
  return out;
}

/* ---- feature: spelling rescue ---- */

/**
 * How far a "correction" may travel from what was typed.
 *
 * A misspelling is a near miss: two or three letters wrong, occasionally four
 * in a long word. Anything further is not a correction but a substitution,
 * and a model asked to fix "xqzt" will happily produce one — which would put
 * a word the student never typed into their bank, under a notice claiming it
 * was their own. The bound is what keeps this feature honest.
 */
function editDistance(a, b) {
  const rows = a.length + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

function correctionBudget(word) {
  return word.length >= 12 ? 4 : word.length >= 7 ? 3 : 2;
}

const SPELLABLE = /^[a-z][a-z'-]*$/;

/**
 * The word the student meant, when no dictionary has heard of the one they
 * typed.
 *
 * The whole request is one word — nothing about their bank, their draft, or
 * what they were doing goes with it — and the answer is treated as a
 * suggestion to be checked against a dictionary, never as a fact. A model
 * that has nothing to offer says so, and `null` comes back rather than an
 * invented word.
 */
export async function aiSpellFix(settings, word) {
  const typed = String(word ?? "").trim().toLowerCase();
  if (!typed) throw new Error("Name a word first.");

  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{correction: string, confident: boolean}')}`,
    prompt: [
      `No English dictionary has an entry for “${typed}”.`,
      "If it is a misspelling of one ordinary English word, give that word in \"correction\".",
      "It must be a spelling fix — the word the writer was reaching for — not a different word that means something similar.",
      'If it is not a misspelling, or you cannot tell which word was meant, return "" and confident false.',
      '"correction" is one lowercase word, with no explanation around it.',
    ].join("\n"),
    temperature: 0.2,
  });

  const suggestion = asString(parsed?.correction).trim().toLowerCase().replace(/[.,!?]+$/, "");
  // Confidence has to be *stated*, not merely not-denied. A reply that drops
  // the field, or sends the string "false" — both of which the surrounding
  // instruction to give an empty value for anything unknown invites — was
  // reading as confident, and the correction went in under a notice claiming
  // the student had typed it.
  if (!suggestion || !affirms(parsed?.confident)) return null;
  if (!SPELLABLE.test(suggestion) || suggestion === typed) return null;
  if (editDistance(typed, suggestion) > correctionBudget(typed)) return null;
  return { word: suggestion };
}

/* ---- feature: what a derived word actually means ---- */

/** Never more than a dictionary entry's worth, however much comes back. */
const MAX_REPAIRED_SENSES = 3;
const MAX_ROOT_SENSES = 4;

/**
 * This is the only model-written text lexis stores, syncs, and shows as a
 * definition, so it is held to a dictionary's shape rather than a chat
 * reply's: a part of speech that is one, and a sense short enough to have
 * been the one sentence that was asked for. Anything longer is not a
 * definition that was trimmed, it is a different kind of answer.
 */
const MAX_DEF_CHARS = 400;
const PARTS_OF_SPEECH = new Set([
  "noun", "proper noun", "verb", "adjective", "adverb", "pronoun", "preposition",
  "conjunction", "interjection", "determiner", "article", "numeral", "particle",
  "phrase", "prefix", "suffix",
]);

/**
 * A definition for a word whose dictionary entry only points at another word.
 *
 * "interestingly" is *in an interesting way*; "gases" is *plural of gas*.
 * Both are true and neither is a meaning, and the student who typed the word
 * is left to make the last step themselves — which is exactly the step they
 * were asking about.
 *
 * The model is not asked what the word means from memory. It is handed the
 * human-written entry for the root and asked to say what the *derived* form
 * says, which keeps the answer anchored to Wiktionary's scholarship and
 * leaves the model doing the one thing it is good at here: the grammar.
 */
export async function aiRootMeaning(settings, { word, gloss = "", root, rootSenses = [] }) {
  const w = String(word ?? "").trim();
  const base = String(root ?? "").trim();
  if (!w || !base) throw new Error("Name a word and its root first.");

  const material = (Array.isArray(rootSenses) ? rootSenses : [])
    .slice(0, MAX_ROOT_SENSES)
    .map((sense) => {
      const pos = asString(sense?.pos);
      const def = asString(sense?.def);
      return def ? `${pos ? `(${pos}) ` : ""}${def}` : "";
    })
    .filter(Boolean);

  // No root entry, no request. The whole claim this feature makes is that the
  // meaning comes from Wiktionary's own words and the model only does the
  // grammar; asked with nothing to work from it would answer from memory,
  // and the answer would be banked, synced, and labelled as if it had not.
  if (!material.length) {
    throw new Error(`No dictionary entry for “${base}” to work from.`);
  }

  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{senses: [{"pos": string, "def": string}]}')}`,
    prompt: [
      `A dictionary defines “${w}” only as ${gloss ? `“${gloss}”` : `a form of “${base}”`},`,
      `which tells a student nothing. Write what “${w}” itself means.`,
      `The dictionary's own entry for “${base}” reads:\n${material.map((line) => `- ${line}`).join("\n")}`,
      "Give one or two senses. Each is one sentence, in the register a dictionary uses — a definition, not a usage note.",
      `"pos" is the part of speech of “${w}” itself (adverb, noun, verb, adjective), not of “${base}”.`,
      `Never restate the pointer: a definition that says “${w}” is a form of “${base}” is the answer that failed.`,
      "Stay inside the meanings above; do not invent a sense the root entry does not support.",
    ].join("\n"),
    temperature: 0.3,
  });

  const rows = Array.isArray(parsed?.senses) ? parsed.senses : [];
  const senses = [];
  for (const row of rows) {
    const def = asString(typeof row === "string" ? row : row?.def).trim();
    if (!def || def.length > MAX_DEF_CHARS) continue;
    const pos = asString(typeof row === "string" ? "" : row?.pos).trim().toLowerCase();
    senses.push({ pos: PARTS_OF_SPEECH.has(pos) ? pos : "", def, example: null });
    if (senses.length >= MAX_REPAIRED_SENSES) break;
  }
  if (!senses.length) throw new Error("No usable definition came back. Try again.");
  return { senses };
}

/* ---- feature: resolving sync conflicts ---- */

/** How much of a losing copy is worth showing a model, and no more. */
const BRIEF_SENSES = 3;
const BRIEF_SYNONYMS = 6;
const BRIEF_DEF_CHARS = 500;

function briefDefinition(record) {
  return (record.senses ?? [])
    .slice(0, BRIEF_SENSES)
    .map((sense) => `${sense?.pos ? `(${sense.pos}) ` : ""}${asString(sense?.def)}`.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, BRIEF_DEF_CHARS);
}

/**
 * What is actually in dispute, which depends on which of a word's two clocks
 * the merge had to choose on.
 *
 * A definition conflict is resolved through `restoreDefinition`, which by
 * design touches the dictionary fields and nothing else — so showing a model
 * the two copies' review counts there would be inviting it to decide the
 * question on evidence that has no bearing on the outcome, and to restore a
 * definition because the copy it came with had been practised more.
 */
function briefCopy(record, kind) {
  if (!record) return null;
  const definition = briefDefinition(record);
  if (kind === "definition") return { definition, source: asString(record.source) };
  return {
    definition,
    synonyms: (record.synonyms ?? [])
      .slice(0, BRIEF_SYNONYMS)
      .map((row) => asString(typeof row === "string" ? row : row?.word))
      .filter(Boolean),
    reviews: Number(record.srs?.reps ?? 0),
    lapses: Number(record.srs?.lapses ?? 0),
    practised: Number(record.times_used ?? 0),
  };
}

/**
 * Exactly what leaves the device for one conflict — built here, by naming the
 * fields rather than by deleting the ones that must not go.
 *
 * A word record carries a review log, an essay-use log, and the ids of the
 * drafts those uses came from. None of that helps anyone decide which copy to
 * keep, and an essay-log id is a fact about the student's own writing. A
 * whitelist is the only way to keep a field added later from quietly joining
 * the payload.
 */
export function conflictBrief(entry, ref) {
  const kind = asString(entry?.kind);
  return {
    // A number for this request, not the conflict's own id: that id encodes
    // the millisecond at which a word was deleted, which decides nothing here
    // and is nobody else's business. The caller maps the answer back.
    ref: String(ref),
    word: asString(entry?.word),
    kind,
    keptFrom: asString(entry?.keptSide),
    lostFrom: asString(entry?.lostSide),
    whatTheMergeDiscarded: asStringArray(entry?.reasons, 6),
    kept: briefCopy(entry?.kept, kind),
    discarded: briefCopy(entry?.lost, kind),
  };
}

/** How many conflicts one request may carry. Beyond this the answer thins out. */
const MAX_CONFLICTS_PER_ASK = 12;

/**
 * The two answers, in the words a model actually uses for them.
 *
 * Treating everything that is not the literal "other" as "keep" made the one
 * word the prompt itself uses to *describe* restoring — "restore the discarded
 * one" — mean its opposite. Anything still unreadable is no answer at all, and
 * an unanswered conflict stays open for a person, which is the safe end of
 * being wrong.
 */
const RESTORE_WORDS = new Set([
  "other", "restore", "restored", "discarded", "take-other", "take other", "other copy",
  "the other", "the other copy", "lost",
]);
// "none" is not on this list. It is how a model says it has no verdict, not
// how it says the merge was right, and reading it as a decision dismissed a
// conflict nobody had decided.
const KEEP_WORDS = new Set([
  "keep", "kept", "keep current", "current", "merge", "merged", "as-is", "as is",
]);

function readChoice(value) {
  const text = asString(value).trim().toLowerCase().replace(/[."'\s]+$/, "");
  if (RESTORE_WORDS.has(text)) return "other";
  if (KEEP_WORDS.has(text)) return "keep";
  return null;
}

/**
 * Reads the conflict list and says, for each one, whether the copy the merge
 * kept is the right one — with a reason a person can disagree with.
 *
 * The verdicts are advice, not an action: the caller applies them through the
 * same "use the other copy" path a student would have used by hand, so
 * nothing happens here that could not have been done, and undone, manually.
 */
export async function aiResolveConflicts(settings, conflicts) {
  const list = (Array.isArray(conflicts) ? conflicts : []).slice(0, MAX_CONFLICTS_PER_ASK);
  if (!list.length) throw new Error("There are no conflicts to resolve.");
  const briefs = list.map((entry, at) => conflictBrief(entry, at + 1));

  const parsed = await chatJSON(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction(
      '{verdicts: [{"ref": string, "choice": "keep" | "other", "reason": string}]}'
    )}`,
    prompt: [
      "Two of a student's devices edited the same vocabulary words while apart.",
      "A merge already chose one copy of each; the other was discarded. Say whether it chose well.",
      '"choice" is "keep" to let the merge\'s copy stand, or "other" to restore the discarded one.',
      '"reason" is one short sentence a student would understand — say what the copy you chose has.',
      "Prefer the copy with the fuller, more precise definition.",
      'Where practice history is shown, prefer the copy that is further along; where it is not — a "definition" conflict restores the dictionary entry alone — decide on the definitions only.',
      "A word deleted on one device after being edited on the other is usually worth putting back only if the discarded copy holds real work.",
      "When the two are equally good, choose \"keep\" — an unnecessary restore is still a change to their bank.",
      "Return one verdict per entry, using the \"ref\" numbers exactly as given.",
      "",
      JSON.stringify(briefs, null, 1),
    ].join("\n"),
    temperature: 0.3,
  });

  const rows = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
  const answers = new Map();
  for (const row of rows) {
    const ref = asString(row?.ref ?? row?.id).trim();
    if (!ref || answers.has(ref)) continue;
    const choice = readChoice(row?.choice);
    if (!choice) continue; // unreadable: the card stays open for a person
    answers.set(ref, { choice, reason: stripEmphasis(asString(row?.reason)).trim() });
  }

  // Back to the conflicts the caller knows about, in the order they were asked.
  const verdicts = briefs
    .map((brief, at) => {
      const answer = answers.get(brief.ref);
      return answer ? { id: asString(list[at]?.id), ...answer } : null;
    })
    .filter((verdict) => verdict && verdict.id);
  if (!verdicts.length) throw new Error("No usable verdicts came back. Try again.");
  return { verdicts, asked: briefs.length };
}
