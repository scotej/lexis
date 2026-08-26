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
 * Two things travel with every completion by default, because the person
 * using this is a student sending unpublished school work to a router that
 * picks a provider per request:
 *
 *   - `provider: { data_collection: "deny", zdr: true }` keeps the draft away
 *     from providers that retain inputs or train on them. It can leave a
 *     narrow model with no eligible endpoint, so it is a setting rather than
 *     a constant — off is a deliberate choice, made in settings, not a
 *     default someone falls into.
 *   - `response_format` with a strict JSON schema, where the endpoint honours
 *     it. parseJSONLoose() stays as the fallback for everything else.
 */

const API_BASE = "https://openrouter.ai/api/v1";

/** Network-resilience knobs; tests shrink them with setAiNetworkOptions(). */
const net = {
  timeoutMs: 45000, // generation is slower than sync; give it room
  stallMs: 25000, // once streaming, silence for this long is a dead stream
  retries: 2, // total attempts per request for *transient* failures
  backoffMs: 600,
  maxBackoffMs: 4000,
};

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
 * The user changed their mind. Distinct from every other failure: nothing
 * went wrong, so the interface should say nothing rather than apologise.
 */
export function cancelledError() {
  const err = new Error("cancelled");
  err.cancelled = true;
  return err;
}

export function isCancelled(err) {
  return Boolean(err?.cancelled);
}

/**
 * Mirrors an external abort onto our own controller and returns the cleanup.
 *
 * Deliberately not `AbortSignal.any()`: that landed in WebKit far too
 * recently to bet the desktop webview on, and this is four lines.
 */
function linkAbort(external, ctrl) {
  if (!external) return () => {};
  if (external.aborted) {
    ctrl.abort();
    return () => {};
  }
  const onAbort = () => ctrl.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

/**
 * One OpenRouter request that cannot hang forever. Retries the transient
 * failure modes exactly the way sync does; surfaces everything else through
 * describeError so the message names the actual cause — an expired key reads
 * differently from an empty balance.
 *
 * The timeout covers reaching the response *headers*. A streaming body is
 * governed by the stall timer in readStream() instead, so a long answer that
 * is still arriving is never cut off for taking its time.
 */
async function apiFetch(path, apiKey, init = {}, signal = null) {
  const url = `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-Title": "lexis",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.headers ?? {}),
  };

  for (let attempt = 1; attempt <= net.retries; attempt++) {
    const last = attempt >= net.retries;
    if (signal?.aborted) throw cancelledError();
    const ctrl = new AbortController();
    const unlink = linkAbort(signal, ctrl);
    const timer = setTimeout(() => ctrl.abort(), net.timeoutMs);
    let resp;
    try {
      resp = await fetch(url, { ...init, headers, signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      unlink();
      // A cancelled request and a timed-out one both surface as AbortError;
      // only the external signal tells them apart.
      if (signal?.aborted) throw cancelledError();
      if (last) {
        throw transientError(
          err?.name === "AbortError"
            ? "OpenRouter didn’t respond in time."
            : "Couldn’t reach OpenRouter (network problem).",
          err
        );
      }
      await sleep(backoffDelay(attempt));
      continue;
    }
    clearTimeout(timer);
    unlink();

    // Throttling and server trouble are worth one polite retry.
    if ((resp.status === 429 || resp.status >= 500) && !last) {
      const wait = retryAfterMs(resp);
      if (wait == null || wait <= net.maxBackoffMs) {
        await sleep(wait ?? backoffDelay(attempt));
        continue;
      }
    }
    return resp;
  }
  // Unreachable: every path above returns or throws.
  throw transientError("Couldn’t reach OpenRouter.");
}

/** Turns a non-2xx response into the most specific honest message available. */
async function describeError(status, resp) {
  // Read through a clone: callers may need to inspect the same body to decide
  // whether the failure is worth one differently-shaped retry.
  const detail = await errorDetail(resp);

  // Strict privacy routing can empty the pool for a narrowly-hosted model.
  // Left unexplained that reads as "the model is broken"; it isn't, and the
  // way out is one checkbox away, so the message says which one.
  if (noEndpoints(status, detail)) {
    return (
      "No provider for this model meets the privacy setting (no data collection, " +
      "zero retention). Choose another model, or turn off strict privacy in AI assist."
    );
  }

  switch (status) {
    case 401:
      return "OpenRouter rejected the key — it may have been revoked or mistyped.";
    case 402:
      return "This OpenRouter key has run out of credits. Add credits at openrouter.ai/credits.";
    case 403:
      return detail || "The request was refused (moderation or key restrictions).";
    default:
      return detail
        ? `OpenRouter returned ${status} — ${detail}`
        : `OpenRouter returned ${status}.`;
  }
}

/** "Nothing matched your routing constraints", in the shapes OpenRouter says it. */
function noEndpoints(status, detail) {
  return (status === 404 || status === 400) && /no (?:allowed )?endpoints?/i.test(detail ?? "");
}

/** A 400 that is complaining specifically about the schema we attached. */
function rejectedResponseFormat(status, detail) {
  return status === 400 && /response_format|json_schema|structured output/i.test(detail ?? "");
}

/** Reads the error body once, so callers can inspect it and still report it. */
async function errorDetail(resp) {
  try {
    const body = await resp.clone().json();
    return body?.error?.message ?? (typeof body?.error === "string" ? body.error : "") ?? "";
  } catch {
    return "";
  }
}

async function apiJSON(path, apiKey, init = {}, signal = null) {
  const resp = await apiFetch(path, apiKey, init, signal);
  if (!resp.ok) throw new Error(await describeError(resp.status, resp));
  return resp.json();
}

/* ---- the chat completion core ---- */

/** Strict privacy is the default; only an explicit `false` turns it off. */
export function privacyPreference(settings) {
  return settings?.strictPrivacy === false ? null : { data_collection: "deny", zdr: true };
}

function completionBody(settings, opts, { schema, stream }) {
  const { system, prompt, maxTokens = 700, temperature = 0.4, schemaName = "reply" } = opts;
  const body = {
    model: normalizeModel(settings.model),
    max_tokens: maxTokens,
    temperature,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  };
  const provider = privacyPreference(settings);
  if (provider) body.provider = provider;
  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    };
  }
  if (stream) body.stream = true;
  return body;
}

/** OpenRouter returns usage on every response now; this is the shape we keep. */
export function normalizeUsage(usage) {
  if (!usage) return null;
  const cost = Number(usage.cost ?? usage.total_cost);
  return {
    cost: Number.isFinite(cost) ? cost : null,
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
  };
}

async function readWhole(resp) {
  const data = await resp.json();
  return { text: data?.choices?.[0]?.message?.content ?? "", usage: data?.usage ?? null };
}

/**
 * One read, under a stall timer.
 *
 * The overall timeout covers reaching the headers; from there a generation
 * may legitimately run for a minute. What is *not* legitimate is silence, so
 * the clock restarts on every chunk and only an actually-dead stream trips it.
 */
function readWithStall(reader) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject before cancelling, not after. Cancelling a reader resolves its
      // pending read as `{ done: true }`, and that resolution would win the
      // race below — handing back a truncated answer as though the model had
      // finished, which is the one outcome a stall must never produce.
      reject(transientError("OpenRouter stopped sending mid-answer."));
      reader.cancel().catch(() => {});
    }, net.stallMs);
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}

/**
 * Server-sent events into text, one line at a time.
 *
 * Chunk boundaries fall wherever the network puts them — routinely mid-line —
 * so lines are assembled in a buffer rather than parsed per chunk. Comment
 * frames (OpenRouter sends `: OPENROUTER PROCESSING` as a keep-alive) and the
 * terminating `[DONE]` are skipped; the final frame carries usage.
 */
async function readStream(resp, onDelta, signal) {
  // `stream: true` is a request, not a guarantee: a provider is free to
  // ignore it and answer with ordinary JSON, and a fetch polyfill may hand
  // back a response with no readable body at all. Either way the answer is
  // there — read it whole and deliver it in one piece rather than looking for
  // events that were never sent and reporting an empty response.
  const isEventStream = /text\/event-stream/i.test(resp.headers.get("content-type") ?? "");
  if (!isEventStream || !resp.body?.getReader) {
    const whole = await readWhole(resp);
    if (whole.text) onDelta(whole.text, whole.text);
    return whole;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  let buffer = "";
  let text = "";
  let usage = null;
  try {
    for (;;) {
      if (signal?.aborted) throw cancelledError();
      const { done, value } = await readWithStall(reader);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue; // a malformed frame is not worth losing the answer over
        }
        if (frame?.error) {
          throw new Error(frame.error.message ?? "OpenRouter reported an error mid-answer.");
        }
        const choice = frame?.choices?.[0];
        // Streamed deltas, plus the whole-message shape some providers emit.
        const piece = choice?.delta?.content ?? choice?.message?.content ?? "";
        if (piece) {
          text += piece;
          onDelta(piece, text);
        }
        if (frame?.usage) usage = frame.usage;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  // A cancelled stream ends as a clean `done`, so the check has to be here
  // too — otherwise a half-written answer would be returned as a whole one.
  if (signal?.aborted) throw cancelledError();
  return { text, usage };
}

/**
 * One completion. Returns `{ text, usage }` — the usage is what lets the
 * interface show a student what their own key just spent.
 *
 * Pass `onDelta` to stream: it is called with (piece, textSoFar) as the
 * answer arrives. Pass `signal` to let the user call it off. Pass `schema`
 * to have the endpoint enforce the JSON shape where it is able to.
 */
export async function chat(settings, opts = {}) {
  if (!settings?.key) throw new Error("Add your OpenRouter key in AI assist first.");
  const { signal = null, onDelta = null } = opts;
  const streaming = typeof onDelta === "function";

  // The schema is an optimisation, never a reason to fail: an endpoint that
  // rejects the parameter outright gets one more try without it, and
  // parseJSONLoose() handles whatever comes back either way.
  let schema = opts.schema ?? null;
  for (;;) {
    const resp = await apiFetch(
      "/chat/completions",
      settings.key,
      {
        method: "POST",
        body: JSON.stringify(completionBody(settings, opts, { schema, stream: streaming })),
        ...(streaming ? { headers: { Accept: "text/event-stream" } } : {}),
      },
      signal
    );

    if (!resp.ok) {
      const detail = await errorDetail(resp);
      if (schema && rejectedResponseFormat(resp.status, detail)) {
        schema = null;
        continue;
      }
      throw new Error(await describeError(resp.status, resp));
    }

    const { text, usage } = streaming
      ? await readStream(resp, onDelta, signal)
      : await readWhole(resp);
    if (!text.trim()) throw new Error("OpenRouter returned an empty response.");
    return { text: text.trim(), usage: normalizeUsage(usage) };
  }
}

/* ---- key + catalogue ---- */

/** Key facts: label, spend, and remaining credit. Cheap enough to show inline. */
export async function fetchKeyInfo(apiKey, { signal = null } = {}) {
  const data = await apiJSON("/key", apiKey, {}, signal);
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
export async function fetchModels(apiKey, { signal = null } = {}) {
  const data = await apiJSON("/models", apiKey, {}, signal);
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.map((m) => ({
    id: m.id ?? m.canonical_slug,
    name: m.name ?? m.id,
    context: m.context_length ?? null,
    pricing: m.pricing ?? null,
  }));
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

/** Pulls the outermost JSON object or array out of whatever came back. */
export function parseJSONLoose(text) {
  const cleaned = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates = [];
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
  if (start !== -1) {
    const opener = cleaned[start];
    const closer = opener === "{" ? "}" : "]";
    const last = cleaned.lastIndexOf(closer);
    if (last > start) candidates.push(cleaned.slice(start, last + 1));
  }
  candidates.push(cleaned);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")); // trailing commas
      } catch {
        /* try the next candidate */
      }
    }
  }
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

function jsonOnlyInstruction(schemaHint) {
  return `Respond with JSON only — no preamble, no markdown fences. Shape: ${schemaHint}`;
}

/* ---- the shapes, said twice ----
 *
 * Once in prose for models that only read the prompt, and once as a schema
 * the endpoint can enforce where it supports strict mode. Strict mode wants
 * every property required and no extras, which is also exactly what the
 * mappers below expect — so saying it this way costs nothing.
 */

const strictObject = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const stringList = { type: "array", items: { type: "string" } };

const ESSAY_REVIEW_SCHEMA = strictObject({
  summary: { type: "string" },
  strengths: stringList,
  improvements: {
    type: "array",
    items: strictObject({ title: { type: "string" }, detail: { type: "string" } }),
  },
  focus: stringList,
});

const SIMILAR_WORDS_SCHEMA = strictObject({
  words: {
    type: "array",
    items: strictObject({ word: { type: "string" }, note: { type: "string" } }),
  },
});

const SENTENCES_SCHEMA = strictObject({ sentences: stringList });

const NUANCE_SCHEMA = strictObject({
  distinctions: {
    type: "array",
    items: strictObject({ word: { type: "string" }, nuance: { type: "string" } }),
  },
  guidance: { type: "string" },
});

/**
 * Reads the `summary` field out of a half-finished JSON response.
 *
 * Streaming JSON can't be parsed until the braces close, so a progress line
 * would be the only thing to show for the whole generation. But `summary` is
 * the first field the model writes, and it is complete the moment its closing
 * quote arrives — which is early enough to start reading. Everything else
 * waits for the real parse.
 */
export function peekSummary(partial) {
  const match = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(partial ?? ""));
  if (!match) return "";
  try {
    return asString(JSON.parse(`"${match[1]}"`));
  } catch {
    return "";
  }
}

/* ---- feature: essay review ---- */

const ESSAY_MAX_CHARS = 40000;

/**
 * A structured read of the draft: what works, what to fix, and what to do
 * next. The bank's headwords ride along so the tutor can suggest where the
 * student's own vocabulary belongs.
 */
export async function aiEssayReview(
  settings,
  { essay, bankWords = [], topicNote = "", signal = null, onProgress = null }
) {
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

  // The one long-running feature, so it is the one that streams: the caller
  // gets the summary as soon as its closing quote lands, and a growing
  // character count before that, instead of a spinner for the whole minute.
  let seen = "";
  const { text: raw, usage } = await chat(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction(
      '{summary, strengths: string[], improvements: [{title, detail}], focus: string[]}'
    )}`,
    prompt,
    maxTokens: 1600,
    temperature: 0.6,
    schema: ESSAY_REVIEW_SCHEMA,
    schemaName: "essay_review",
    signal,
    onDelta: onProgress
      ? (_piece, soFar) => {
          seen = peekSummary(soFar) || seen;
          onProgress({ chars: soFar.length, summary: seen });
        }
      : null,
  });
  const parsed = parseJSONLoose(raw);

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
  return { summary, strengths, improvements, focus, usage };
}

/* ---- feature: similar words ---- */

/**
 * Kindred words for analytical writing. Deliberately *not* plain thesaurus
 * synonyms: each comes with a register note saying when it fits, which is
 * what a corpus listing can't tell you.
 */
export async function aiSimilarWords(settings, word, { signal = null } = {}) {
  const w = String(word ?? "").trim();
  if (!w) throw new Error("Name a word first.");
  const { text, usage } = await chat(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{words: [{"word": string, "note": string}]}')}`,
    prompt: [
      `Give six to eight words close in meaning to “${w}” that would suit formal analytical writing.`,
      'For each, "note" explains the difference in tone, intensity, or typical use in one short clause — what a thesaurus never tells you.',
      "Prefer precise upgrades over obscure ones; include one plainer option where useful.",
      "Exclude “" + w + "” itself and simple inflections of it.",
    ].join("\n"),
    maxTokens: 600,
    temperature: 0.5,
    schema: SIMILAR_WORDS_SCHEMA,
    schemaName: "similar_words",
    signal,
  });
  const parsed = parseJSONLoose(text);

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
  return { words: out, usage };
}

/* ---- feature: example sentences ---- */

const CONTEXT_CHARS = 2400;

/**
 * Three sentences using the word the way an analytical essay would. When the
 * student has a draft underway, its opening rides along as context, so the
 * examples speak about *their* text rather than a generic novel.
 */
export async function aiExampleSentences(settings, { word, context = "", signal = null }) {
  const w = String(word ?? "").trim();
  if (!w) throw new Error("Name a word first.");
  const excerpt = String(context ?? "").replace(/\s+/g, " ").trim().slice(0, CONTEXT_CHARS);
  const { text, usage } = await chat(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{sentences: string[]}')}`,
    prompt: [
      `Write three original sentences that use “${w}” the way a strong analytical essay would.`,
      excerpt
        ? `They should suit this piece the student is writing:\n"""${excerpt}"""`
        : "Keep them generic enough to fit literary-analysis writing, but never mention that they are generic.",
      "Vary sentence openings. No numbering, no explanation outside the JSON.",
    ].join("\n"),
    maxTokens: 400,
    temperature: 0.7,
    schema: SENTENCES_SCHEMA,
    schemaName: "example_sentences",
    signal,
  });
  const parsed = parseJSONLoose(text);

  const sentences = asStringArray(
    Array.isArray(parsed.sentences) ? parsed.sentences : Array.isArray(parsed) ? parsed : [],
    6
  );
  if (!sentences.length) throw new Error("No sentences came back. Try again.");
  return { sentences, usage };
}

/* ---- feature: nuance comparison ---- */

/**
 * Splits near-synonyms apart: what each word claims, connotes, and costs.
 * This is the question students actually ask — “can I swap these?”
 */
export async function aiNuance(settings, words, { signal = null } = {}) {
  const list = (Array.isArray(words) ? words : String(words ?? "").split(/[;,/]/))
    .map((w) => String(w ?? "").trim())
    .filter(Boolean);
  const unique = [...new Set(list.map((w) => w.toLowerCase()))];
  if (unique.length < 2) throw new Error("Give at least two words to compare.");
  if (unique.length > 6) throw new Error("Compare up to six words at a time.");

  const { text, usage } = await chat(settings, {
    system: `${REGISTER} ${jsonOnlyInstruction('{distinctions: [{"word": string, "nuance": string}], "guidance": string}')}`,
    prompt: [
      `A student is choosing between these near-interchangeable words: ${unique.join(", ")}.`,
      'For each, "nuance" states in one or two sentences what it specifically implies and where it would feel wrong.',
      '"guidance" then says in one or two sentences which to prefer for analytical essay writing, and why.',
    ].join("\n"),
    maxTokens: 800,
    temperature: 0.4,
    schema: NUANCE_SCHEMA,
    schemaName: "nuance",
    signal,
  });
  const parsed = parseJSONLoose(text);

  const byWord = new Map();
  const rows = Array.isArray(parsed.distinctions) ? parsed.distinctions : [];
  for (const row of rows) {
    const word = asString(row?.word).toLowerCase().replace(/[^a-z'-]/g, "");
    const nuance = asString(row?.nuance);
    if (word && nuance) byWord.set(word, nuance);
  }
  const distinctions = unique.map((word) => ({ word, nuance: byWord.get(word) ?? "" }));
  const guidance = asString(parsed.guidance);
  if (!guidance && distinctions.every((d) => !d.nuance)) {
    throw new Error("The comparison came back empty. Try again.");
  }
  return { distinctions, guidance, usage };
}
