const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validActivityDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function emptyActivityArchive() {
  return { additions: {}, reviews: {}, essay_uses: {} };
}

function normalizeDateEvents(raw) {
  const events = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return events;
  for (const [id, date] of Object.entries(raw)) {
    if (id && validActivityDate(date)) events[id] = date;
  }
  return events;
}

function normalizeCountEvents(raw) {
  const events = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return events;
  for (const [id, rawCount] of Object.entries(raw)) {
    const count = Math.floor(Number(rawCount));
    if (id && Number.isFinite(count) && count > 0) events[id] = count;
  }
  return events;
}

export function normalizeActivityArchive(raw) {
  const archive = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    additions: normalizeDateEvents(archive.additions),
    reviews: normalizeDateEvents(archive.reviews),
    essay_uses: normalizeCountEvents(archive.essay_uses),
  };
}

function mergeDateEvents(a, b) {
  const events = {};
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const id of ids) {
    const local = a[id];
    const remote = b[id];
    events[id] = !local ? remote : !remote ? local : local >= remote ? local : remote;
  }
  return events;
}

function mergeCountEvents(a, b) {
  const events = {};
  const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const id of ids) events[id] = Math.max(a[id] ?? 0, b[id] ?? 0);
  return events;
}

export function mergeActivityArchives(a, b) {
  const local = normalizeActivityArchive(a);
  const remote = normalizeActivityArchive(b);
  return {
    additions: mergeDateEvents(local.additions, remote.additions),
    reviews: mergeDateEvents(local.reviews, remote.reviews),
    essay_uses: mergeCountEvents(local.essay_uses, remote.essay_uses),
  };
}

function wordScope(word) {
  const created = Number.isFinite(word?.created)
    ? String(Math.trunc(word.created))
    : `added-${String(word?.added ?? "unknown")}`;
  return `${encodeURIComponent(String(word?.word ?? ""))}@${created}`;
}

function addWordHistory(archive, word) {
  if (!word || typeof word !== "object") return;
  const scope = wordScope(word);

  if (validActivityDate(word.added)) {
    archive.additions[`add:${scope}`] = word.added;
  }

  if (word.review_events && typeof word.review_events === "object") {
    for (const [id, date] of Object.entries(word.review_events)) {
      if (id && validActivityDate(date)) archive.reviews[`review:${scope}:${id}`] = date;
    }
  }

  let essayEvents = 0;
  if (word.essay_use_events && typeof word.essay_use_events === "object") {
    for (const [id, rawCount] of Object.entries(word.essay_use_events)) {
      const count = Math.floor(Number(rawCount));
      if (id && Number.isFinite(count) && count > 0) {
        archive.essay_uses[`essay:${scope}:${id}`] = count;
        essayEvents += 1;
      }
    }
  }
  if (essayEvents === 0 && Number.isFinite(word.essay_uses) && word.essay_uses > 0) {
    archive.essay_uses[`essay:${scope}:legacy-total`] = Math.floor(word.essay_uses);
  }
}

/** Returns a new archive containing the supplied word's immutable activity. */
export function archiveWordHistory(rawArchive, word) {
  const archive = normalizeActivityArchive(rawArchive);
  addWordHistory(archive, word);
  return archive;
}

/** Combines archived activity with the history of every word still in the bank. */
export function collectActivity(bank) {
  const archive = normalizeActivityArchive(bank?.activity_archive);
  for (const word of bank?.words ?? []) addWordHistory(archive, word);
  return archive;
}

/** Marks every currently stored review event as represented through `updated`. */
export function markReviewHistoryCurrent(word) {
  if (!word || !Number.isFinite(word.updated)) return false;
  if (word.review_events_updated === word.updated) return false;
  word.review_events_updated = word.updated;
  return true;
}

/**
 * Adds coverage markers when an upgraded client loads a pre-marker bank.
 * `migrate()` has already ensured that `srs.last` has a corresponding event.
 */
export function markExistingReviewHistory(bank) {
  let changed = false;
  for (const word of bank?.words ?? []) {
    if (Number.isFinite(word.review_events_updated) || !Number.isFinite(word.updated)) continue;
    const last = word.srs?.last;
    const represented =
      validActivityDate(last) && Object.values(word.review_events ?? {}).some((date) => date === last);
    if (represented) {
      word.review_events_updated = word.updated;
      changed = true;
    }
  }
  return changed;
}

export function isLegacyArchivedReview(id) {
  return typeof id === "string" && id.includes(":legacy:");
}
