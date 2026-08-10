import { addDays, todayISO } from "./srs.js";

export const STATS_WINDOW_DAYS = 30;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function datesInWindow(today, days) {
  return Array.from({ length: days }, (_, index) => addDays(today, index - days + 1));
}

function streakLength(activeDates, today) {
  let cursor = activeDates.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (activeDates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Produces presentation-ready activity statistics without mutating the bank.
 *
 * Add history comes from each surviving word's `added` date. Review history is
 * event-based and therefore exact from the point the event log exists; older
 * banks can only recover each word's latest known review during migration.
 */
export function buildStats(bank, today = todayISO(), days = STATS_WINDOW_DAYS) {
  if (!validDate(today)) throw new RangeError("stats need a valid ISO date");
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new RangeError("stats window must be between 1 and 366 days");
  }

  const dates = datesInWindow(today, days);
  const inWindow = new Set(dates);
  const byDate = new Map(dates.map((date) => [date, { date, added: 0, reviews: 0 }]));
  const activeDates = new Set();

  let reviews = 0;
  let essayUses = 0;
  let legacyReviews = 0;

  for (const word of bank?.words ?? []) {
    if (validDate(word.added)) {
      activeDates.add(word.added);
      if (inWindow.has(word.added)) byDate.get(word.added).added += 1;
    }

    essayUses += Number.isFinite(word.essay_uses) ? word.essay_uses : 0;

    for (const [id, date] of Object.entries(word.review_events ?? {})) {
      if (!validDate(date)) continue;
      reviews += 1;
      if (id.startsWith("legacy:")) legacyReviews += 1;
      activeDates.add(date);
      if (inWindow.has(date)) byDate.get(date).reviews += 1;
    }
  }

  const daily = dates.map((date) => byDate.get(date));
  const windowAdded = daily.reduce((sum, point) => sum + point.added, 0);
  const windowReviews = daily.reduce((sum, point) => sum + point.reviews, 0);

  return {
    days,
    start: dates[0],
    end: dates.at(-1),
    daily,
    totals: {
      words: bank?.words?.length ?? 0,
      reviews,
      essay_uses: essayUses,
      streak: streakLength(activeDates, today),
    },
    window: {
      added: windowAdded,
      reviews: windowReviews,
      active_days: daily.filter((point) => point.added || point.reviews).length,
    },
    history: {
      legacy_reviews: legacyReviews,
      limited: legacyReviews > 0,
    },
  };
}
