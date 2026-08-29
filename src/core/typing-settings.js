/**
 * Every knob the typing test has, described once.
 *
 * The settings panel is generated from this schema and so is the validator
 * that reads a stored settings blob back. That is not tidiness for its own
 * sake: thirty-odd settings hand-written twice is thirty-odd chances for the
 * panel to offer a value the engine has never heard of, and the failure looks
 * like "the setting does nothing" rather than like a bug.
 *
 * The names and the defaults follow monkeytype, so muscle memory transfers.
 * These live on the device, not in the bank — they are preferences about a
 * keyboard, and the machine you sync to has a different one.
 */

export const TIME_PRESETS = [15, 30, 60, 120];
export const WORD_PRESETS = [10, 25, 50, 100];

const choice = (key, label, options, fallback, extra = {}) => ({
  kind: "choice",
  key,
  label,
  options,
  fallback,
  ...extra,
});

const toggle = (key, label, fallback, extra = {}) => ({
  kind: "toggle",
  key,
  label,
  fallback,
  ...extra,
});

const number = (key, label, { min, max, step = 1, fallback }, extra = {}) => ({
  kind: "number",
  key,
  label,
  min,
  max,
  step,
  fallback,
  ...extra,
});

const opts = (...pairs) => pairs.map(([value, label]) => ({ value, label: label ?? String(value) }));

/**
 * `when` hides a setting that cannot apply, rather than showing it greyed out:
 * quote length means nothing in a timed test, and a panel full of dead
 * controls is how a settings screen becomes something people stop reading.
 */
export const SETTINGS_SCHEMA = [
  {
    group: "test",
    title: "test",
    blurb: "What to type, and how much of it.",
    items: [
      choice(
        "mode",
        "mode",
        opts(["time", "time"], ["words", "words"], ["quote", "quote"], ["zen", "zen"]),
        "quote"
      ),
      choice(
        "time",
        "seconds",
        opts(...TIME_PRESETS.map((n) => [n, String(n)])),
        60,
        { when: (s) => s.mode === "time", numeric: true }
      ),
      choice(
        "wordCount",
        "words",
        opts(...WORD_PRESETS.map((n) => [n, String(n)])),
        50,
        { when: (s) => s.mode === "words", numeric: true }
      ),
      {
        kind: "set",
        key: "quoteLengths",
        label: "quote length",
        options: opts(
          ["short", "short"],
          ["medium", "medium"],
          ["long", "long"],
          ["thicc", "thicc"]
        ),
        fallback: ["medium"],
        when: (s) => s.mode === "quote",
        help: "Under 100, 300, 600 characters, and everything above.",
      },
      {
        kind: "set",
        key: "quoteKinds",
        label: "quotes from",
        options: opts(
          ["film", "films"],
          ["tv", "television"],
          ["book", "books"],
          ["speech", "speeches"],
          ["person", "people"],
          ["proverb", "proverbs"],
          ["prose", "literature"]
        ),
        fallback: ["film", "tv", "book", "speech", "person", "proverb", "prose"],
        when: (s) => s.mode === "quote",
        help: "Which shelf to draw from. Films and television are mostly short lines; speeches and literature are where the long ones live.",
      },
      choice(
        "quoteSource",
        "written by",
        opts(["library", "the library"], ["ai", "ai"], ["both", "both"]),
        "library",
        {
          when: (s) => s.mode === "quote",
          help: "The library is 16,000 attributed quotes. AI writes new ones around your bank words, a few ahead of you so there is nothing to wait for.",
        }
      ),
      choice(
        "wordSource",
        "words from",
        opts(["common", "common words"], ["bank", "my bank"], ["mixed", "both"]),
        "common",
        { when: (s) => s.mode === "words" || s.mode === "time" }
      ),
      toggle("punctuation", "punctuation", false, {
        when: (s) => s.mode === "words" || s.mode === "time",
      }),
      toggle("numbers", "numbers", false, {
        when: (s) => s.mode === "words" || s.mode === "time",
      }),
    ],
  },
  {
    group: "bank",
    title: "my words",
    blurb:
      "Practise the vocabulary you are actually learning: keep only the passages that use it.",
    items: [
      choice(
        "bankFilter",
        "only quotes using",
        opts(
          ["off", "any quote"],
          ["bank", "a word from my bank"],
          ["today", "a word from today's list"],
          ["due", "a word due for review"]
        ),
        "off",
        { when: (s) => s.mode === "quote" }
      ),
      choice("minBankWords", "at least", opts([1, "1 word"], [2, "2 words"], [3, "3 words"]), 1, {
        when: (s) => s.mode === "quote" && s.bankFilter !== "off",
        numeric: true,
      }),
      toggle("markBankWords", "underline my words as I type them", true),
    ],
  },
  {
    group: "behaviour",
    title: "behaviour",
    blurb: "How strict the test is with you.",
    items: [
      choice(
        "difficulty",
        "difficulty",
        opts(
          ["normal", "normal"],
          ["expert", "expert — fail on a wrong word"],
          ["master", "master — fail on a wrong key"]
        ),
        "normal"
      ),
      choice(
        "stopOnError",
        "stop on error",
        opts(["off", "off"], ["letter", "letter"], ["word", "word"]),
        "off",
        { help: "Letter refuses the wrong key. Word refuses the space until the word is right." }
      ),
      choice(
        "confidenceMode",
        "confidence mode",
        opts(["off", "off"], ["on", "on — no going back a word"], ["max", "max — no backspace"]),
        "off"
      ),
      toggle("freedomMode", "freedom mode", false, {
        help: "Backspace into words you already got right.",
      }),
      toggle("strictSpace", "strict space", false, {
        help: "A space before a word has started counts as an error instead of being ignored.",
      }),
      toggle("quickEnd", "quick end", false, {
        help: "Finish the moment the last word is right, without a closing space.",
      }),
      toggle("hideExtraLetters", "hide extra letters", false),
      toggle("lazyMode", "lazy mode", false, {
        help: "Fold accents onto plain keys, so nothing needs a dead-key detour.",
      }),
      choice(
        "quickRestart",
        "quick restart",
        opts(["off", "off"], ["tab", "tab"], ["esc", "esc"], ["enter", "enter"]),
        "tab"
      ),
      number("minWpm", "minimum wpm", { min: 0, max: 250, fallback: 0 }, {
        help: "0 turns the floor off. Fail below it and the test stops.",
      }),
      number("minAccuracy", "minimum accuracy", { min: 0, max: 100, fallback: 0 }),
      number("minBurst", "minimum burst", { min: 0, max: 250, fallback: 0 }),
    ],
  },
  {
    group: "appearance",
    title: "appearance",
    blurb: "What it looks like while you type.",
    items: [
      choice(
        "caretStyle",
        "caret",
        opts(
          ["line", "line"],
          ["block", "block"],
          ["outline", "outline"],
          ["underline", "underline"],
          ["off", "off"]
        ),
        "line"
      ),
      choice(
        "smoothCaret",
        "smooth caret",
        opts(["off", "off"], ["slow", "slow"], ["medium", "medium"], ["fast", "fast"]),
        "medium"
      ),
      choice("highlightMode", "highlight", opts(["off", "off"], ["letter", "letter"], ["word", "word"]), "off"),
      choice("tapeMode", "tape mode", opts(["off", "off"], ["word", "word"], ["letter", "letter"]), "off", {
        help: "Scroll the passage past a fixed caret, like a ticker tape.",
      }),
      choice(
        "indicateTypos",
        "indicate typos",
        opts(["off", "off"], ["below", "below"], ["replace", "replace"]),
        "below"
      ),
      toggle("blindMode", "blind mode", false, {
        help: "No feedback at all while typing. Scored as usual at the end.",
      }),
      choice("timerStyle", "timer / progress", opts(["bar", "bar"], ["text", "text"], ["mini", "mini"], ["off", "off"]), "bar"),
      toggle("liveWpm", "live wpm", false),
      toggle("liveAccuracy", "live accuracy", false),
      toggle("liveBurst", "live burst", false),
      toggle("showDecimals", "decimal places", false),
      toggle("smoothLineScroll", "smooth line scroll", true),
      toggle("capsLockWarning", "caps lock warning", true),
      number("fontSize", "font size", { min: 0.8, max: 2.4, step: 0.1, fallback: 1.3 }),
      number("maxLineWidth", "line width", { min: 0, max: 120, step: 5, fallback: 65 }, {
        help: "Characters per line. 0 uses the full width.",
      }),
    ],
  },
  {
    group: "sound",
    title: "sound",
    blurb: "Synthesised on the spot — no files, nothing downloaded.",
    items: [
      toggle("soundOnClick", "click on every key", false),
      toggle("soundOnError", "thud on a mistake", false),
      number("soundVolume", "volume", { min: 0, max: 100, step: 5, fallback: 40 }, {
        when: (s) => s.soundOnClick || s.soundOnError,
      }),
    ],
  },
];

/** Every item in the schema, flattened — the validator's working list. */
export const SETTINGS_ITEMS = SETTINGS_SCHEMA.flatMap((section) => section.items);

/**
 * The values one setting allows.
 *
 * The bar above the test offers the common ones as chips with terser labels
 * than the settings panel uses, but it must never offer a *value* the schema
 * has not got — which is exactly the drift that leaves a chip doing nothing.
 */
export function optionValues(key) {
  const item = SETTINGS_ITEMS.find((entry) => entry.key === key);
  return item?.options?.map((option) => option.value) ?? [];
}

/** The same options with their labels, for chips that want to read well. */
export function options(key) {
  const item = SETTINGS_ITEMS.find((entry) => entry.key === key);
  return item?.options ? item.options.map((option) => ({ ...option })) : [];
}

export const DEFAULT_TYPING_SETTINGS = Object.freeze(
  Object.fromEntries(
    SETTINGS_ITEMS.map((item) => [
      item.key,
      Array.isArray(item.fallback) ? [...item.fallback] : item.fallback,
    ])
  )
);

/**
 * A stored settings blob, made safe to use.
 *
 * Unknown keys are dropped and unusable values fall back to the default rather
 * than being coerced: a `caretStyle` of "blinky" from a future version must
 * paint *something*, and a half-typed number in a text field must not silently
 * become a test that lasts NaN seconds.
 */
export function normalizeTypingSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const item of SETTINGS_ITEMS) {
    const value = source[item.key];
    out[item.key] = normalizeItem(item, value);
  }
  return out;
}

function normalizeItem(item, value) {
  switch (item.kind) {
    case "toggle":
      return typeof value === "boolean" ? value : item.fallback;
    case "choice": {
      const candidate = item.numeric ? Number(value) : value;
      return item.options.some((option) => option.value === candidate) ? candidate : item.fallback;
    }
    case "set": {
      if (!Array.isArray(value)) return [...item.fallback];
      const allowed = new Set(item.options.map((option) => option.value));
      const kept = [...new Set(value)].filter((entry) => allowed.has(entry));
      // An empty set would filter the corpus down to nothing and leave the
      // typist staring at "no passages match". Treat it as "not chosen yet".
      return kept.length ? kept : [...item.fallback];
    }
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return item.fallback;
      const clamped = Math.min(item.max, Math.max(item.min, n));
      // Steps below 1 are fractional font sizes; keep one decimal, not fifteen.
      return item.step < 1 ? Math.round(clamped * 10) / 10 : Math.round(clamped);
    }
    default:
      return item.fallback;
  }
}

/** Whether a setting applies given the rest of them. */
export function settingApplies(item, settings) {
  return typeof item.when === "function" ? Boolean(item.when(settings)) : true;
}

/**
 * The subset the engine cares about. Passing the whole blob would work, but
 * this keeps the engine's contract visible: appearance cannot change a score.
 */
export function engineSettings(settings) {
  return {
    difficulty: settings.difficulty,
    stopOnError: settings.stopOnError,
    confidenceMode: settings.confidenceMode,
    freedomMode: settings.freedomMode,
    strictSpace: settings.strictSpace,
    quickEnd: settings.quickEnd,
    hideExtraLetters: settings.hideExtraLetters,
    lazyMode: settings.lazyMode,
    minWpm: settings.minWpm,
    minAccuracy: settings.minAccuracy,
    minBurst: settings.minBurst,
  };
}

/**
 * The key a personal best is filed under.
 *
 * Two tests are comparable only if they asked the same thing of you, so the
 * key carries everything that changes the difficulty of the run — but not
 * appearance, and not which passage came up.
 */
export function testKey(settings) {
  const parts = [settings.mode];
  if (settings.mode === "time") parts.push(String(settings.time));
  if (settings.mode === "words") parts.push(String(settings.wordCount));
  if (settings.mode === "quote") {
    parts.push([...settings.quoteLengths].sort().join("+"));
    // A best set on film one-liners is not a best on speeches, so the shelf is
    // part of what makes two tests comparable.
    if (settings.quoteKinds.length < 7) parts.push([...settings.quoteKinds].sort().join("+"));
  }
  if (settings.mode === "words" || settings.mode === "time") {
    parts.push(settings.wordSource);
    if (settings.punctuation) parts.push("punct");
    if (settings.numbers) parts.push("nums");
  }
  if (settings.difficulty !== "normal") parts.push(settings.difficulty);
  return parts.join(":");
}

/** A short human label for that key, for the result screen. */
export function describeTest(settings) {
  switch (settings.mode) {
    case "time":
      return `${settings.time} seconds`;
    case "words":
      return `${settings.wordCount} words`;
    case "zen":
      return "zen";
    default: {
      const lengths = [...settings.quoteLengths].sort(
        (a, b) => ["short", "medium", "long", "thicc"].indexOf(a) - ["short", "medium", "long", "thicc"].indexOf(b)
      );
      return `quote — ${lengths.join(", ")}`;
    }
  }
}
