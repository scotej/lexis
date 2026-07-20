import { test } from "node:test";
import assert from "node:assert/strict";
import { newSrs, apply, addDays, daysBetween } from "../src/core/srs.js";

const DAY = "2026-07-20";

test("good reviews grow the interval", () => {
  const srs = newSrs(DAY);
  apply(srs, "good", DAY);
  assert.equal(srs.interval, 1);
  apply(srs, "good", DAY);
  assert.equal(srs.interval, 6);
  apply(srs, "good", DAY);
  assert.equal(srs.interval, 15); // 6 * 2.5
});

test("again resets and reduces ease", () => {
  const srs = newSrs(DAY);
  apply(srs, "good", DAY);
  apply(srs, "good", DAY);
  apply(srs, "again", DAY);
  assert.equal(srs.reps, 0);
  assert.equal(srs.due, DAY);
  assert.ok(srs.ease < 2.5);
});

test("ease never drops below the floor", () => {
  const srs = newSrs(DAY);
  for (let i = 0; i < 20; i++) apply(srs, "again", DAY);
  assert.ok(srs.ease >= 1.3);
});

test("intervals are capped at a year", () => {
  const srs = newSrs(DAY);
  for (let i = 0; i < 40; i++) apply(srs, "easy", DAY);
  assert.ok(srs.interval <= 365);
});

test("an unknown grade is rejected rather than silently ignored", () => {
  assert.throws(() => apply(newSrs(DAY), "brilliant", DAY));
});

test("date arithmetic stays on the calendar across a month boundary", () => {
  assert.equal(addDays("2026-07-30", 3), "2026-08-02");
  assert.equal(daysBetween("2026-07-30", "2026-08-02"), 3);
});

test("date arithmetic survives a daylight-saving transition", () => {
  // Australian DST begins on the first Sunday of October; adding one day
  // must still land on the next calendar date, not 23 or 25 hours later.
  assert.equal(addDays("2026-10-03", 1), "2026-10-04");
  assert.equal(addDays("2026-10-04", 1), "2026-10-05");
});
