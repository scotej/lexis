/**
 * The prefetch queue that keeps AI passages waiting before they are wanted.
 *
 * Its whole reason to exist is that nobody should watch a spinner before a
 * typing test, so what matters here is the failure behaviour: a queue that
 * hammers a failing API, or serves passages built for a bank the student has
 * since changed, is worse than one that simply says it is empty.
 *
 * The clock and the timer are injected, so a two-minute backoff is asserted in
 * microseconds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrefetcher } from "../src/core/prefetch.js";

/** A controllable clock with a timer queue, so backoffs can be stepped through. */
function fakeClock() {
  let time = 0;
  const timers = [];
  return {
    now: () => time,
    setTimer(fn, ms) {
      const handle = { at: time + ms, fn, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) handle.cancelled = true;
    },
    /** Runs every timer due within `ms`, in order. */
    async advance(ms) {
      time += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.cancelled || timer.at > time) continue;
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    get pending() {
      return timers.filter((t) => !t.cancelled).length;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("it fills to the requested depth without being asked twice", async () => {
  let batches = 0;
  const clock = fakeClock();
  const queue = createPrefetcher({
    produce: (want) => {
      batches++;
      return Array.from({ length: want }, (_, i) => `p${batches}-${i}`);
    },
    size: 3,
    ...clock,
  });

  queue.prime();
  await settle();
  assert.equal(queue.state().ready, 3);
  assert.equal(batches, 1, "one round trip, not three");
});

test("taking one tops the queue back up", async () => {
  const clock = fakeClock();
  let made = 0;
  const queue = createPrefetcher({
    produce: (want) => Array.from({ length: want }, () => `p${made++}`),
    size: 3,
    lowWater: 2,
    ...clock,
  });

  queue.prime();
  await settle();
  assert.equal(queue.take(), "p0");
  await settle();
  assert.equal(queue.state().ready, 3, "refilled behind the typist");
});

test("a batch is only ever asked for the room that is left", async () => {
  // What lets the caller size its request to `want` and stop there. Asking
  // for more than this was never cheaper — a top-up runs once per passage
  // taken either way — and the surplus was dropped by the cap below, which on
  // a key rationed by the day is a request's worth of nothing.
  const clock = fakeClock();
  const asked = [];
  const queue = createPrefetcher({
    produce: (want) => {
      asked.push(want);
      return Array.from({ length: want }, (_, i) => `p${asked.length}-${i}`);
    },
    size: 3,
    lowWater: 2,
    ...clock,
  });

  queue.prime();
  await settle();
  queue.take();
  await settle();
  queue.take();
  await settle();

  assert.deepEqual(asked, [3, 1, 1], "three to fill it, then one for each taken");
  assert.equal(queue.state().ready, 3, "and never more than it can hold");
});

test("a passage is never handed out twice", async () => {
  const clock = fakeClock();
  let made = 0;
  const queue = createPrefetcher({
    produce: (want) => Array.from({ length: want }, () => made++),
    size: 4,
    ...clock,
  });
  queue.prime();
  await settle();

  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const item = queue.take();
    await settle();
    assert.equal(seen.has(item), false, `served ${item} twice`);
    seen.add(item);
  }
});

test("a failure backs off instead of hammering the API", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const queue = createPrefetcher({
    produce: () => {
      attempts++;
      return Promise.reject(new Error("openrouter is unwell"));
    },
    size: 2,
    backoffMs: 1000,
    ...clock,
  });

  queue.prime();
  await settle();
  assert.equal(attempts, 1);
  assert.match(queue.state().error.message, /unwell/);
  assert.ok(queue.state().retryingAt > 0, "a retry is scheduled");

  await clock.advance(500);
  await settle();
  assert.equal(attempts, 1, "not yet");

  await clock.advance(600);
  await settle();
  assert.equal(attempts, 2, "and now");

  // Each failure waits longer than the last.
  await clock.advance(1100);
  await settle();
  assert.equal(attempts, 2, "the second wait is longer than the first");
  await clock.advance(1000);
  await settle();
  assert.equal(attempts, 3);
});

test("an empty batch is treated as a failure, not as an answer", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const queue = createPrefetcher({
    produce: () => {
      attempts++;
      return [];
    },
    size: 2,
    backoffMs: 1000,
    ...clock,
  });
  queue.prime();
  await settle();
  assert.equal(attempts, 1, "an empty answer must not spin");
  assert.ok(queue.state().error);
});

test("recovery clears the error and refills", async () => {
  const clock = fakeClock();
  let fail = true;
  const queue = createPrefetcher({
    produce: (want) => (fail ? Promise.reject(new Error("no")) : Array.from({ length: want }, (_, i) => i)),
    size: 2,
    backoffMs: 1000,
    ...clock,
  });
  queue.prime();
  await settle();
  fail = false;
  await clock.advance(1100);
  await settle();
  assert.equal(queue.state().error, null);
  assert.equal(queue.state().ready, 2);
});

test("retry ignores the backoff, because a person pressed the button", async () => {
  const clock = fakeClock();
  let fail = true;
  let attempts = 0;
  const queue = createPrefetcher({
    produce: (want) => {
      attempts++;
      return fail ? Promise.reject(new Error("no")) : Array.from({ length: want }, (_, i) => i);
    },
    size: 2,
    backoffMs: 60000,
    ...clock,
  });
  queue.prime();
  await settle();
  fail = false;
  queue.retry();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(queue.state().ready, 2);
});

test("a reset throws away work in flight for the settings that changed", async () => {
  const clock = fakeClock();
  let release;
  const queue = createPrefetcher({
    produce: () => new Promise((resolve) => (release = resolve)),
    size: 2,
    ...clock,
  });

  queue.prime();
  await settle();
  queue.reset(); // the bank changed while the model was writing
  release(["stale one", "stale two"]);
  await settle();
  assert.equal(queue.state().ready, 0, "passages for the old bank must not land");
});

test("a stopped queue does nothing further", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const queue = createPrefetcher({
    produce: () => {
      attempts++;
      return ["x"];
    },
    size: 2,
    ...clock,
  });
  queue.stop();
  queue.prime();
  await settle();
  // prime() re-opens a stopped queue deliberately — leaving the view is not
  // the same as never coming back to it.
  assert.ok(attempts >= 1);
  queue.stop();
  const after = attempts;
  queue.take();
  await settle();
  assert.equal(attempts, after);
});

test("listeners hear about every change of state", async () => {
  const clock = fakeClock();
  const seen = [];
  const queue = createPrefetcher({
    produce: (want) => Array.from({ length: want }, (_, i) => i),
    size: 2,
    onChange: (state) => seen.push(state.ready),
    ...clock,
  });
  queue.prime();
  await settle();
  queue.take();
  await settle();
  assert.ok(seen.includes(2), "reported when full");
  assert.ok(seen.includes(1), "reported when drawn from");
});

test("a listener that throws cannot break the queue", async () => {
  const clock = fakeClock();
  const queue = createPrefetcher({
    produce: () => ["a", "b"],
    size: 2,
    onChange: () => {
      throw new Error("the view exploded");
    },
    ...clock,
  });
  queue.prime();
  await settle();
  assert.equal(queue.state().ready, 2);
});
