/**
 * SM-2 style scheduling (the algorithm behind Anki), simplified to
 * whole-day intervals so it fits a daily writing habit.
 *
 * Ported from the original Rust implementation; this is now the single
 * source of truth, shared by the desktop app and the web build.
 */

export const GRADES = ["again", "hard", "good", "easy"];

const MIN_EASE = 1.3;
const MAX_INTERVAL = 365;

/** A fresh schedule for a word added today. */
export function newSrs(today) {
  return { reps: 0, lapses: 0, ease: 2.5, interval: 0, due: today, last: null };
}

export function isGrade(g) {
  return GRADES.includes(g);
}

/** Adds `days` to an ISO `YYYY-MM-DD` date, staying in calendar days. */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Local-calendar ISO date — deliberately not UTC, since "today" is the
 *  user's day, not Greenwich's. */
export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toISODate(new Date());
}

/** Whole days from `a` to `b` (both ISO dates); negative if `b` is earlier. */
export function daysBetween(a, b) {
  const ms = new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`);
  return Math.round(ms / 86400000);
}

/** Applies a review outcome in place, returning the same object. */
export function apply(srs, grade, today) {
  switch (grade) {
    case "again":
      srs.lapses += 1;
      srs.reps = 0;
      srs.interval = 0;
      srs.ease = Math.max(srs.ease - 0.2, MIN_EASE);
      break;
    case "hard":
      srs.reps += 1;
      srs.interval = Math.max(Math.round(srs.interval * 1.2), 1);
      srs.ease = Math.max(srs.ease - 0.15, MIN_EASE);
      break;
    case "good":
      srs.reps += 1;
      if (srs.reps === 1) srs.interval = 1;
      else if (srs.reps === 2) srs.interval = 6;
      else srs.interval = Math.max(Math.round(srs.interval * srs.ease), srs.interval + 1);
      break;
    case "easy":
      srs.reps += 1;
      if (srs.reps === 1) srs.interval = 2;
      else if (srs.reps === 2) srs.interval = 8;
      else
        srs.interval = Math.max(
          Math.round(srs.interval * srs.ease * 1.3),
          srs.interval + 2
        );
      srs.ease += 0.15;
      break;
    default:
      throw new Error("unknown grade");
  }
  srs.interval = Math.min(srs.interval, MAX_INTERVAL);
  srs.due = addDays(today, srs.interval);
  srs.last = today;
  return srs;
}
