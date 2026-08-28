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

/** Network-resilience knobs; tests shrink them with setAiNetworkOptions(). */
const net = {
  timeoutMs: 45000, // generation is slower than sync; give it room
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
    "X-Title": "lexis",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(init.headers ?? {}),
  };

  for (let attempt = 1; attempt <= net.retries; attempt++) {
    const last = attempt >= net.retries;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), net.timeoutMs);
    let resp;
    let text;
    try {
      resp = await fetch(url, { ...init, headers, signal: ctrl.signal });
      text = await resp.text();
    } catch (err) {
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
    } finally {
      clearTimeout(timer);
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
      return "This OpenRouter key has run out of credits. Add credits at openrouter.ai/credits.";
    case 403:
      return detail || "The request was refused (moderation or key restrictions).";
    default:
      return detail
        ? `OpenRouter returned ${status} — ${detail}`
        : `OpenRouter returned ${status}.`;
  }
}

async function apiJSON(path, apiKey, init = {}, opts = {}) {
  const { ok, status, text } = await apiFetch(path, apiKey, init);
  if (!ok) throw new Error(describeError(status, text, opts));
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
  // OpenRouter reports `cost` on many routes but not all; absent is not zero,
  // so an unpriced request simply adds nothing rather than pretending.
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
 */
async function complete(settings, { system, prompt, maxTokens = 700, temperature = 0.4 }) {
  if (!settings?.key) throw new Error("Add your OpenRouter key in AI assist first.");
  const body = {
    model: normalizeModel(settings.model),
    max_tokens: maxTokens,
    temperature,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  };
  const provider = privacyRouting(settings);
  if (provider) body.provider = provider;

  const data = await apiJSON(
    "/chat/completions",
    settings.key,
    { method: "POST", body: JSON.stringify(body) },
    { strict: Boolean(provider) }
  );
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

/** Pulls the outermost JSON object or array out of whatever came back. */
export function parseJSONLoose(text) {
  const cleaned = stripFenceLines(String(text ?? "").replace(/^\uFEFF/, "")).trim();

  const attempt = (candidate) =>
    parseJSONObject(candidate) ??
    parseJSONObject(candidate.replace(/,\s*([}\]])/g, "$1")); // trailing commas

  // Each opening brace or bracket in turn, outermost first: a preamble may
  // contain one of its own (“Sure {here}: {…}”), so the first candidate
  // is not always the answer.
  let tried = 0;
  for (let i = 0; i < cleaned.length && tried < MAX_JSON_CANDIDATES; i++) {
    const ch = cleaned[i];
    if (ch !== "{" && ch !== "[") continue;
    tried++;
    const slice = balancedSlice(cleaned, i);
    if (!slice) continue;
    const value = attempt(slice);
    if (value !== undefined) return value;
  }

  const whole = attempt(cleaned);
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
    maxTokens: 1600,
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
    maxTokens: 600,
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
    maxTokens: 400,
    temperature: 0.7,
  });

  const sentences = asStringArray(
    Array.isArray(parsed.sentences) ? parsed.sentences : Array.isArray(parsed) ? parsed : [],
    6
  );
  if (!sentences.length) throw new Error("No sentences came back. Try again.");
  return { sentences };
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
    maxTokens: 800,
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
