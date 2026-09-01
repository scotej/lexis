import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjectiveFormsForAdverb,
  adverbClarification,
  clearLookupCaches,
  expandDerivativeDefinitions,
  fetchDefinition,
  fetchSynonyms,
  needsDerivativeClarification,
} from "../src/core/dict.js";

function dictionary(senses) {
  return {
    phonetic: null,
    senses,
    source: "Wiktionary via dictionaryapi.dev",
    source_url: "https://en.wiktionary.org/wiki/test",
  };
}

function candidate(word, pos, freq) {
  return { word, tags: [pos, `f:${freq}`] };
}

test("only opaque adverb glosses need derivative clarification", () => {
  assert.equal(
    needsDerivativeClarification(
      dictionary([{ pos: "adverb", def: "In a poignant manner.", example: null }])
    ),
    true
  );
  assert.equal(
    needsDerivativeClarification(
      dictionary([{ pos: "adverb", def: "With moving emotional force.", example: null }])
    ),
    false
  );
  assert.equal(
    needsDerivativeClarification(
      dictionary([{ pos: "noun", def: "In a poignant manner.", example: null }])
    ),
    false
  );
});

test("regular adverbs produce plausible adjective lemmas", () => {
  assert.ok(adjectiveFormsForAdverb("ardently").has("ardent"));
  assert.ok(adjectiveFormsForAdverb("happily").has("happy"));
  assert.ok(adjectiveFormsForAdverb("terribly").has("terrible"));
  assert.ok(adjectiveFormsForAdverb("gently").has("gentle"));
  assert.ok(adjectiveFormsForAdverb("fully").has("full"));
  assert.ok(adjectiveFormsForAdverb("basically").has("basic"));
});

test("clarifications require both adverb similarity and exact adjective synonymy", () => {
  const relatedAdverbs = [
    candidate("fervidly", "adv", 0.017751),
    candidate("fierily", "adv", 0.006699),
    candidate("ardently", "adv", 0.676069),
    candidate("passionately", "adv", 2.211901),
    candidate("eagerly", "adv", 5.071117),
    candidate("sincerely", "adv", 3.2),
  ];
  const exactAdjectiveSynonyms = [
    candidate("fervid", "adj", 0.2),
    candidate("fiery", "adj", 3.3),
    candidate("ardent", "adj", 3.3),
    candidate("passionate", "adj", 6.1),
    candidate("sincere", "adj", 6.7),
  ];

  assert.equal(
    adverbClarification("fervently", relatedAdverbs, exactAdjectiveSynonyms),
    "Depending on context: ardently, passionately, or sincerely."
  );
});

test("clarifications reject sense leakage, wrong POS, phrases, duplicates, and obscurity", () => {
  const relatedAdverbs = [
    candidate("strictly", "adv", 20),
    candidate("strictness", "n", 2),
    candidate("with rigour", "adv", 4),
    candidate("purely", "adv", 17),
    candidate("rigorously", "adv", 1.6),
    candidate("rigorously", "adv", 1.6),
    candidate("sternly", "adv", 0.01),
  ];
  const exactAdjectiveSynonyms = [candidate("rigorous", "adj", 5.5)];

  assert.equal(
    adverbClarification("strictly", relatedAdverbs, exactAdjectiveSynonyms),
    null,
    "pure is not an exact synonym of strict, and one rigorous result is insufficient"
  );
});

test("fervently receives a direct meaning instead of a circular adjective reference", async () => {
  const original = dictionary([
    { pos: "adverb", def: "In a fervent manner.", example: null },
  ]);
  const calls = [];

  const expanded = await expandDerivativeDefinitions(
    "fervently",
    original,
    async (word) => {
      calls.push(["related", word]);
      return [
        candidate("ardently", "adv", 0.67),
        candidate("passionately", "adv", 2.21),
        candidate("sincerely", "adv", 3.2),
      ];
    },
    async (word) => {
      calls.push(["synonyms", word]);
      return [
        candidate("ardent", "adj", 3.3),
        candidate("passionate", "adj", 6.1),
        candidate("sincere", "adj", 6.7),
      ];
    }
  );

  assert.deepEqual(calls.sort(), [
    ["related", "fervently"],
    ["synonyms", "fervent"],
  ]);
  assert.equal(
    expanded.senses[0].def,
    "Depending on context: ardently, passionately, or sincerely."
  );
  assert.equal(expanded.senses[0].pos, "adverb");
  assert.equal(expanded.source, "Wiktionary · clarification via Datamuse");
  assert.match(expanded.clarification_url, /ml=fervently/);
  assert.equal(original.senses[0].def, "In a fervent manner.", "input is not mutated");
});

test("strictly rejects the unrelated pure sense and never inherits strict's archaic gloss", async () => {
  const expanded = await expandDerivativeDefinitions(
    "strictly",
    dictionary([{ pos: "adverb", def: "In a strict manner.", example: null }]),
    async () => [
      candidate("stringently", "adv", 0.16),
      candidate("rigorously", "adv", 1.68),
      candidate("purely", "adv", 17.8),
      candidate("rigidly", "adv", 2.33),
      candidate("sternly", "adv", 1.47),
    ],
    async () => [
      candidate("rigorous", "adj", 5.5),
      candidate("rigid", "adj", 13.8),
      candidate("stern", "adj", 9),
      candidate("exact", "adj", 23),
    ]
  );

  assert.equal(
    expanded.senses[0].def,
    "Depending on context: rigorously, rigidly, or sternly."
  );
  assert.doesNotMatch(expanded.senses[0].def, /pure|strained|drawn close|tight/i);
});

test("ordinary and partly explanatory definitions do not trigger clarification", async () => {
  const original = dictionary([
    { pos: "adverb", def: "With intense passion or enthusiasm.", example: null },
    { pos: "noun", def: "In a fervent manner.", example: null },
    { pos: "adverb", def: "In an angry manner; under the influence of anger.", example: null },
    { pos: "adverb", def: "With speed; in a rapid manner.", example: null },
    { pos: "adverb", def: "In the same manner.", example: null },
  ]);
  let calls = 0;
  const lookup = async () => {
    calls += 1;
    throw new Error("should not be called");
  };

  const expanded = await expandDerivativeDefinitions(
    "fervently",
    original,
    lookup,
    lookup
  );

  assert.equal(calls, 0);
  assert.strictEqual(expanded, original);
});

test("failed or low-confidence lexical lookups preserve the upstream definition", async () => {
  const original = dictionary([
    { pos: "adverb", def: "In a fervent manner.", example: null },
  ]);

  const failed = await expandDerivativeDefinitions(
    "fervently",
    original,
    async () => {
      throw new Error("offline");
    },
    async () => {
      throw new Error("offline");
    }
  );
  const weak = await expandDerivativeDefinitions(
    "fervently",
    original,
    async () => [candidate("ardently", "adv", 0.7)],
    async () => [candidate("ardent", "adj", 3.3)]
  );

  assert.strictEqual(failed, original);
  assert.strictEqual(weak, original);
});

test("fetchDefinition cross-checks live API shapes without fetching adjective definitions", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.host === "api.dictionaryapi.dev") {
      return {
        ok: true,
        async json() {
          return [
            {
              word: "fervently",
              meanings: [
                {
                  partOfSpeech: "adverb",
                  definitions: [{ definition: "In a fervent manner." }],
                },
              ],
            },
          ];
        },
      };
    }
    if (parsed.host === "api.datamuse.com" && parsed.searchParams.has("ml")) {
      assert.equal(parsed.searchParams.get("ml"), "fervently");
      return {
        ok: true,
        async json() {
          return [
            candidate("fervidly", "adv", 0.017),
            candidate("ardently", "adv", 0.67),
            candidate("passionately", "adv", 2.21),
            candidate("sincerely", "adv", 3.2),
          ];
        },
      };
    }
    if (parsed.host === "api.datamuse.com" && parsed.searchParams.has("rel_syn")) {
      assert.equal(parsed.searchParams.get("rel_syn"), "fervent");
      return {
        ok: true,
        async json() {
          return [
            candidate("fervid", "adj", 0.2),
            candidate("ardent", "adj", 3.3),
            candidate("passionate", "adj", 6.1),
            candidate("sincere", "adj", 6.7),
          ];
        },
      };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await fetchDefinition("fervently");
    assert.equal(requests.length, 3);
    assert.equal(
      requests.filter((request) => request.host === "api.dictionaryapi.dev").length,
      1,
      "the resolver must not guess from fervent's ordered definitions"
    );
    assert.equal(
      result.senses[0].def,
      "Depending on context: ardently, passionately, or sincerely."
    );
    assert.equal(result.source, "Wiktionary · clarification via Datamuse");
    assert.equal(result.source_url, "https://en.wiktionary.org/wiki/fervently");
    assert.match(result.clarification_url, /ml=fervently/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the bounded cache is shared safely with essay-synonym lookup", async () => {
  const previousFetch = globalThis.fetch;
  const queries = new Map();
  let dictionaryRequests = 0;

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.host === "api.dictionaryapi.dev") {
      dictionaryRequests += 1;
      return {
        ok: true,
        async json() {
          return [
            {
              word: "cacheably",
              meanings: [
                {
                  partOfSpeech: "adverb",
                  definitions: [{ definition: "In a cacheable manner." }],
                },
              ],
            },
          ];
        },
      };
    }
    if (parsed.host === "api.datamuse.com") {
      const query = parsed.searchParams.has("ml")
        ? `ml=${parsed.searchParams.get("ml")}`
        : `rel_syn=${parsed.searchParams.get("rel_syn")}`;
      queries.set(query, (queries.get(query) ?? 0) + 1);
      const response =
        query === "ml=cacheably"
          ? [
              candidate("temporarily", "adv", 3),
              candidate("reusably", "adv", 0.1),
              candidate("ephemerally", "adv", 0.2),
            ]
          : query === "rel_syn=cacheable"
            ? [
                candidate("temporary", "adj", 20),
                candidate("reusable", "adj", 0.2),
                candidate("ephemeral", "adj", 1),
              ]
            : [candidate("temporarily", "adv", 3)];
      return { ok: true, async json() { return response; } };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await fetchDefinition("cacheably");
    await fetchDefinition("cacheably");
    const synonyms = await fetchSynonyms("cacheably");
    // One request, not two: the second ask for the same word is the first
    // answer. This is the quick-lookup panel handing its result to "add it to
    // the bank after all" instead of paying for it twice.
    assert.equal(dictionaryRequests, 1);
    assert.equal(queries.get("ml=cacheably"), 1);
    assert.equal(queries.get("rel_syn=cacheable"), 1);
    assert.equal(queries.get("rel_syn=cacheably"), 1);
    assert.ok(synonyms.length > 0);
    assert.ok(synonyms.every((item) => Number.isFinite(item.score)));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

/* ---- how fast an answer arrives, and how often it is asked for ---- */

/** A plain dictionaryapi.dev entry, for the tests that only care about timing. */
function apiEntry(word, definition) {
  return [
    {
      word,
      phonetic: `/${word}/`,
      meanings: [{ partOfSpeech: "noun", definitions: [{ definition }] }],
    },
  ];
}

/** A Wiktionary REST reply for the same word. */
function restEntry(definition) {
  return { en: [{ partOfSpeech: "Noun", definitions: [{ definition }] }] };
}

test("a healthy primary dictionary is never double-asked", async () => {
  const previousFetch = globalThis.fetch;
  clearLookupCaches();
  const hosts = [];

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    hosts.push(parsed.host);
    if (parsed.host === "api.dictionaryapi.dev") {
      return { ok: true, async json() { return apiEntry("prompt", "Done without delay."); } };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const result = await fetchDefinition("prompt");
    assert.equal(result.senses[0].def, "Done without delay.");
    assert.deepEqual(hosts, ["api.dictionaryapi.dev"], "no hedge against a host that answered");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a stalled primary dictionary is overtaken by the fallback rather than waited out", async () => {
  const previousFetch = globalThis.fetch;
  clearLookupCaches();
  let releasePrimary;
  const primaryGate = new Promise((resolve) => {
    releasePrimary = resolve;
  });

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.host === "api.dictionaryapi.dev") {
      await primaryGate;
      return { ok: true, async json() { return apiEntry("dilatory", "Slow to act."); } };
    }
    if (parsed.host === "en.wiktionary.org") {
      return { ok: true, async json() { return restEntry("Tending to delay."); } };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    // The primary never answers within the hedge window, so the fallback —
    // which the old code would not have sent for another eleven seconds —
    // carries the lookup.
    const result = await fetchDefinition("dilatory");
    assert.equal(result.senses[0].def, "Tending to delay.");
    assert.equal(result.source, "Wiktionary");
  } finally {
    releasePrimary();
    globalThis.fetch = previousFetch;
  }
});

test("a failed lookup is not remembered as the answer", async () => {
  const previousFetch = globalThis.fetch;
  clearLookupCaches();
  let attempt = 0;

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    attempt += 1;
    if (attempt <= 2) return { ok: false, status: 503 }; // both sources, first try
    if (parsed.host === "api.dictionaryapi.dev") {
      return { ok: true, async json() { return apiEntry("ephemeral", "Lasting a short time."); } };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await assert.rejects(() => fetchDefinition("ephemeral"), /no dictionary entry found/);
    const result = await fetchDefinition("ephemeral");
    assert.equal(result.senses[0].def, "Lasting a short time.", "a bad minute is not cached");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("synonyms ask both Datamuse relations at once rather than one after the other", async () => {
  const previousFetch = globalThis.fetch;
  clearLookupCaches();
  let openRequests = 0;
  let concurrent = 0;

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.host, "api.datamuse.com");
    openRequests += 1;
    concurrent = Math.max(concurrent, openRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    openRequests -= 1;
    const response = parsed.searchParams.has("rel_syn")
      ? [candidate("laconic", "adj", 0.4)]
      : [candidate("terse", "adj", 1.1), candidate("succinct", "adj", 0.9)];
    return { ok: true, async json() { return response; } };
  };

  try {
    const ranked = await fetchSynonyms("concise");
    assert.equal(concurrent, 2, "the thin strict list must not cost a second round trip in series");
    assert.deepEqual(
      ranked.map((row) => row.word).sort(),
      ["laconic", "succinct", "terse"],
      "and the padding rule itself is unchanged"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
