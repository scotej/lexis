import { collectActivity, isLegacyArchivedReview, validActivityDate } from "./activity.js";
import { addDays, todayISO } from "./srs.js";

export const STATS_WINDOW_DAYS = 30;

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
 * Live word event sets are combined with the immutable archive created when a
 * word is removed, so inventory changes cannot rewrite historical activity.
 * Older banks can still recover only each surviving word's latest known review.
 */
export function buildStats(bank, today = todayISO(), days = STATS_WINDOW_DAYS) {
  if (!validActivityDate(today)) throw new RangeError("stats need a valid ISO date");
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new RangeError("stats window must be between 1 and 366 days");
  }

  const dates = datesInWindow(today, days);
  const inWindow = new Set(dates);
  const byDate = new Map(dates.map((date) => [date, { date, added: 0, reviews: 0 }]));
  const activeDates = new Set();
  const activity = collectActivity(bank);

  for (const date of Object.values(activity.additions)) {
    activeDates.add(date);
    if (inWindow.has(date)) byDate.get(date).added += 1;
  }

  for (const date of Object.values(activity.reviews)) {
    activeDates.add(date);
    if (inWindow.has(date)) byDate.get(date).reviews += 1;
  }

  const reviews = Object.keys(activity.reviews).length;
  const essayUses = Object.values(activity.essay_uses).reduce((sum, count) => sum + count, 0);
  const legacyReviews = Object.keys(activity.reviews).filter(isLegacyArchivedReview).length;
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
