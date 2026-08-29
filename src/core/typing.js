/**
 * The typing test itself: a state machine over "what should be typed" and
 * "what has been typed", plus the arithmetic that turns the two into a score.
 *
 * It is deliberately free of the DOM and of time. Every keystroke is a method
 * call, the clock is injected, and nothing here knows what a caret looks like —
 * which is what makes a test suite able to type a hundred words instantly and
 * assert on the result.
 *
 * The behaviour follows monkeytype closely, because that is what typists have
 * their fingers trained on and a test that "nearly" behaves like the one you
 * know is worse than one that behaves differently on purpose. Where a rule is
 * a judgement call rather than a copy, it says so.
 */

/** Ends the test the moment an incorrect word is submitted, or an incorrect key pressed. */
export const DIFFICULTIES = ["normal", "expert", "master"];

/** off: type through errors · letter: wrong keys are refused · word: space is refused until the word is right. */
export const STOP_ON_ERROR = ["off", "letter", "word"];

/** off: backspace freely · on: no going back to a finished word · max: no backspace at all. */
export const CONFIDENCE_MODES = ["off", "on", "max"];

/** Past this many characters beyond the target, extra letters stop being recorded. */
const MAX_EXTRA = 20;

const DEFAULTS = {
  difficulty: "normal",
  stopOnError: "off",
  confidenceMode: "off",
  freedomMode: false,
  strictSpace: false,
  quickEnd: false,
  hideExtraLetters: false,
  lazyMode: false,
  minWpm: 0,
  minAccuracy: 0,
  minBurst: 0,
};

/**
 * Folds accented characters onto the keys a plain keyboard actually has.
 *
 * monkeytype calls this lazy mode. It matters here because AI-generated
 * passages are not held to the corpus builder's ASCII rule — a model asked for
 * a sentence about *naïveté* will happily supply one.
 */
export function foldAccents(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...");
}

function splitWords(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * One attempt at one passage.
 *
 * @param text     the passage, when it arrives as a string
 * @param words    the passage, when it arrives already split (generated runs)
 * @param duration seconds, for a timed test; null for words and quotes
 * @param zen      no target text: whatever is typed is what was wanted
 * @param settings see DEFAULTS
 * @param now      the clock, injected
 */
export function createRun({
  text,
  words,
  duration = null,
  zen = false,
  settings = {},
  now = () => Date.now(),
}) {
  const config = { ...DEFAULTS, ...settings };
  const prepare = (list) => (config.lazyMode ? list.map(foldAccents) : list);

  let targets = prepare(Array.isArray(words) ? words.filter(Boolean) : splitWords(text));
  if (!targets.length) targets = [""];

  const typed = [""];
  let index = 0;
  let status = "idle"; // idle · running · done · failed
  let failure = null;
  let startedAt = null;
  let endedAt = null;
  let wordStartedAt = null;
  let lastBurst = 0;

  // Every scored keypress, in order. The result screen's chart, the
  // consistency figure, and accuracy all read from this one list rather than
  // from three counters that could drift apart.
  const keystrokes = []; // { at, correct }

  const elapsedMs = () => (startedAt == null ? 0 : (endedAt ?? now()) - startedAt);

  function start() {
    if (status !== "idle") return;
    status = "running";
    startedAt = now();
    wordStartedAt = startedAt;
  }

  function finish(reason = null) {
    if (status === "done" || status === "failed") return;
    endedAt = now();
    if (reason) {
      status = "failed";
      failure = reason;
    } else {
      status = "done";
    }
  }

  function record(correct) {
    keystrokes.push({ at: now(), correct });
  }

  const active = () => typed[index] ?? "";
  const target = () => targets[index] ?? "";
  const word0 = (key) => `${typed[index] ?? ""}${key}`;

  /**
   * The thresholds that end a test early.
   *
   * Checked when a word is submitted rather than continuously: mid-word the
   * numbers swing wildly, and failing someone for a figure that would have
   * recovered two keystrokes later is how a feature designed to push you
   * becomes a feature you turn off.
   */
  function checkThresholds() {
    const snapshot = live();
    if (config.minWpm > 0 && snapshot.wpm < config.minWpm) return `below ${config.minWpm} wpm`;
    if (config.minAccuracy > 0 && snapshot.accuracy < config.minAccuracy) {
      return `below ${config.minAccuracy}% accuracy`;
    }
    if (config.minBurst > 0 && lastBurst > 0 && lastBurst < config.minBurst) {
      return `below ${config.minBurst} wpm burst`;
    }
    return null;
  }

  function submitWord() {
    const word = active();
    const expected = target();
    const correct = word === expected;

    // The space is scored with the word it closes: a perfectly typed word
    // earns its separator, a mistyped one does not.
    record(correct);

    const at = now();
    if (wordStartedAt != null && at > wordStartedAt) {
      lastBurst = ((word.length + 1) / 5 / (at - wordStartedAt)) * 60000;
    }
    wordStartedAt = at;

    if (!correct && (config.difficulty === "expert" || config.difficulty === "master")) {
      finish("a word was submitted with an error");
      return;
    }

    index++;
    if (index >= targets.length) {
      if (duration == null) {
        finish();
        return;
      }
      // A timed test that outruns its text waits for more rather than ending.
      typed[index] = typed[index] ?? "";
      return;
    }
    typed[index] = typed[index] ?? "";

    const failed = checkThresholds();
    if (failed) finish(failed);
  }

  return {
    /* ---- what is being typed ---- */

    get words() {
      return targets;
    },
    get typed() {
      return typed;
    },
    get index() {
      return index;
    },
    get status() {
      return status;
    },
    get failure() {
      return failure;
    },
    get duration() {
      return duration;
    },
    get startedAt() {
      return startedAt;
    },

    /** Grows a timed run's text before the typist reaches the end of it. */
    appendWords(more) {
      const extra = prepare(Array.isArray(more) ? more.filter(Boolean) : splitWords(more));
      targets = targets.concat(extra);
      return targets.length;
    },

    /* ---- input ---- */

    type(char) {
      if (status === "done" || status === "failed") return;
      if (typeof char !== "string" || char.length !== 1 || char === " ") return;
      const key = config.lazyMode ? foldAccents(char) : char;

      // Zen has no passage: the target grows to match, so every key is
      // correct by construction and the run is about rhythm, not accuracy.
      if (zen) {
        start();
        record(true);
        typed[index] = word0(key);
        targets[index] = typed[index];
        return;
      }

      const word = active();
      const expected = target()[word.length];
      const correct = expected !== undefined && key === expected;

      if (!correct && config.difficulty === "master") {
        start();
        record(false);
        typed[index] = word + key;
        finish("an incorrect key was pressed");
        return;
      }

      // Refusing the keystroke still counts it: the mistake was made, it just
      // isn't allowed onto the screen.
      if (!correct && config.stopOnError === "letter") {
        start();
        record(false);
        return;
      }
      if (!correct && expected === undefined && config.hideExtraLetters) {
        start();
        record(false);
        return;
      }
      if (word.length >= target().length + MAX_EXTRA) return;

      start();
      record(correct);
      typed[index] = word + key;

      // quick end: the last word of a finite test needs no closing space.
      if (
        config.quickEnd &&
        duration == null &&
        index === targets.length - 1 &&
        typed[index] === target()
      ) {
        submitWord();
      }
    },

    space() {
      if (status === "done" || status === "failed") return;
      const word = active();

      if (zen) {
        if (!word) return; // a double space in zen is just a slip
        start();
        record(true);
        index++;
        targets[index] = "";
        typed[index] = "";
        return;
      }

      if (!word) {
        // A space before a word has begun is a slip, not input. Strict space
        // scores it anyway, which is the entire point of the setting.
        if (config.strictSpace) {
          start();
          record(false);
        }
        return;
      }
      if (config.stopOnError === "word" && word !== target()) {
        start();
        record(false);
        return;
      }
      start();
      submitWord();
    },

    /** @param wholeWord ctrl/alt+backspace, which clears the word in one go. */
    backspace(wholeWord = false) {
      if (status === "done" || status === "failed") return;
      if (config.confidenceMode === "max") return;

      const word = active();
      if (word) {
        typed[index] = wholeWord ? "" : word.slice(0, -1);
        return;
      }
      if (config.confidenceMode !== "off") return;
      if (index === 0) return;

      // Going back to a finished word is allowed to fix it, not to admire it.
      // Freedom mode lifts that, which is what the name is for.
      const previous = typed[index - 1] ?? "";
      if (!config.freedomMode && previous === targets[index - 1]) return;

      index--;
      if (wholeWord) typed[index] = "";
    },

    /* ---- the clock ---- */

    /** Ends a timed run that has run out. Call it on an animation frame. */
    tick() {
      if (status !== "running" || duration == null) return status;
      if (elapsedMs() >= duration * 1000) finish();
      return status;
    },

    /** Seconds left, for the on-screen timer. */
    remaining() {
      if (duration == null) return null;
      return Math.max(0, duration - elapsedMs() / 1000);
    },

    /** 0–1, for the progress bar: time in a timed test, words in the rest. */
    progress() {
      if (zen) return 0;
      if (duration != null) {
        return duration > 0 ? Math.min(1, elapsedMs() / 1000 / duration) : 0;
      }
      return targets.length ? Math.min(1, index / targets.length) : 0;
    },

    stop() {
      finish();
    },

    /** Zen runs until it is stopped; everything else has an end of its own. */
    get zen() {
      return zen;
    },

    /* ---- what it adds up to ---- */

    live,
    result,
    charStats,

    /* ---- what to draw ---- */

    /**
     * One word's characters, each with the state the view paints it in.
     *
     * Exposed per word rather than as a whole-passage snapshot because a
     * thousand-character passage repainted on every keystroke is a thousand
     * character comparisons and a thousand DOM writes, sixty times a second.
     * The view repaints the word that changed.
     */
    wordView(i) {
      const expected = targets[i] ?? "";
      const input = typed[i] ?? "";
      const submitted = i < index;
      const chars = [];
      for (let c = 0; c < expected.length; c++) {
        const got = input[c];
        chars.push({
          char: expected[c],
          state:
            got === undefined ? (submitted ? "missed" : "pending") : got === expected[c] ? "correct" : "incorrect",
        });
      }
      const extra = input.length > expected.length ? [...input.slice(expected.length)] : [];
      return {
        index: i,
        chars,
        extra,
        active: i === index,
        submitted,
        correct: submitted && input === expected,
        caret: i === index ? Math.min(input.length, expected.length + extra.length) : -1,
      };
    },
  };

  /* ---- metrics ---- */

  function charStats() {
    let correct = 0;
    let incorrect = 0;
    let extra = 0;
    let missed = 0;
    let correctWordChars = 0;
    let correctSpaces = 0;

    const seen = Math.min(index + 1, targets.length);
    for (let i = 0; i < seen; i++) {
      const expected = targets[i] ?? "";
      const input = typed[i] ?? "";
      if (!input && i >= index) continue;

      const shared = Math.min(expected.length, input.length);
      for (let c = 0; c < shared; c++) {
        if (input[c] === expected[c]) correct++;
        else incorrect++;
      }
      extra += Math.max(0, input.length - expected.length);
      // Only a word the typist has moved past has "missed" characters; the one
      // under the caret is simply unfinished.
      if (i < index) missed += Math.max(0, expected.length - input.length);

      if (input === expected) {
        correctWordChars += expected.length;
        if (i < index) correctSpaces++;
      }
    }
    return { correct, incorrect, extra, missed, correctWordChars, correctSpaces };
  }

  /**
   * The numbers as they stand right now — the live wpm/accuracy readouts and,
   * once the run is over, the result screen's headline figures.
   *
   * wpm counts only the characters of words typed exactly right, which is
   * monkeytype's definition and the reason its wpm is lower than a raw
   * characters-per-minute figure. raw counts everything the fingers did.
   */
  function live() {
    const minutes = elapsedMs() / 60000;
    const stats = charStats();
    const typedChars = stats.correct + stats.incorrect + stats.extra + stats.correctSpaces;
    const correctKeys = keystrokes.filter((k) => k.correct).length;

    return {
      wpm: minutes > 0 ? (stats.correctWordChars + stats.correctSpaces) / 5 / minutes : 0,
      raw: minutes > 0 ? typedChars / 5 / minutes : 0,
      accuracy: keystrokes.length ? (correctKeys / keystrokes.length) * 100 : 100,
      burst: lastBurst,
      seconds: elapsedMs() / 1000,
      chars: stats,
    };
  }

  /**
   * Per-second samples, for the result chart and for consistency.
   *
   * Second `n` holds the raw speed of the keystrokes that landed inside it,
   * which is what makes a stutter visible as a dip rather than being averaged
   * into invisibility.
   */
  function timeline() {
    if (startedAt == null) return [];
    const total = Math.max(1, Math.ceil(elapsedMs() / 1000));
    const buckets = Array.from({ length: total }, () => ({ chars: 0, errors: 0 }));
    for (const stroke of keystrokes) {
      const second = Math.min(total - 1, Math.floor((stroke.at - startedAt) / 1000));
      if (second < 0) continue;
      buckets[second].chars++;
      if (!stroke.correct) buckets[second].errors++;
    }
    return buckets.map((bucket, i) => ({
      second: i + 1,
      raw: (bucket.chars / 5) * 60,
      errors: bucket.errors,
    }));
  }

  /**
   * monkeytype's consistency figure, formula and all.
   *
   * It is the coefficient of variation of the per-second speeds, squashed onto
   * 0–100 by a curve steep enough that "steady" and "erratic" are visibly
   * different numbers rather than 94% and 91%.
   */
  function consistency(samples) {
    const values = samples.map((s) => s.raw).filter((v) => v > 0);
    if (values.length < 2) return 100;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (mean <= 0) return 0;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const cv = Math.sqrt(variance) / mean;
    const x = cv + cv ** 3 / 3 + cv ** 5 / 5;
    return Math.max(0, 100 * (1 - Math.tanh(x)));
  }

  function result() {
    const snapshot = live();
    const samples = timeline();
    return {
      ...snapshot,
      status,
      failure,
      consistency: consistency(samples),
      timeline: samples,
      words: index,
      duration,
    };
  }
}
