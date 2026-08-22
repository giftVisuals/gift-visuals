// Weekly usage reset calculation.
// Usage resets every Saturday at 12:00 PM WAT (Africa/Lagos, UTC+1, no DST).
// This must NEVER depend on the client's clock — only server time, computed
// in the Africa/Lagos civil calendar.

const WAT_OFFSET_MINUTES = 60; // Africa/Lagos is a fixed UTC+1, no DST.
const RESET_DAY_OF_WEEK = 6; // Saturday (0 = Sunday ... 6 = Saturday)
const RESET_HOUR_WAT = 12; // 12:00 PM WAT

function toWatParts(date) {
  const watMs = date.getTime() + WAT_OFFSET_MINUTES * 60 * 1000;
  const wat = new Date(watMs);
  return {
    year: wat.getUTCFullYear(),
    month: wat.getUTCMonth(),
    day: wat.getUTCDate(),
    dayOfWeek: wat.getUTCDay(),
    hour: wat.getUTCHours(),
    minute: wat.getUTCMinutes(),
    second: wat.getUTCSeconds(),
  };
}

// Build a real UTC Date instant from a WAT-civil-time (Y/M/D/H/M/S) by
// constructing it as UTC and then subtracting the fixed offset.
function fromWatCivil(year, month, day, hour, minute, second) {
  const asIfUtc = Date.UTC(year, month, day, hour, minute, second);
  return new Date(asIfUtc - WAT_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Returns the most recent reset instant (<= now) and the next reset instant
 * (> now), both as real UTC Date objects, computed against Africa/Lagos.
 */
function getResetWindow(now = new Date()) {
  const wat = toWatParts(now);

  const daysSinceSaturday = (wat.dayOfWeek - RESET_DAY_OF_WEEK + 7) % 7;
  const candidateDay = wat.day - daysSinceSaturday;

  let lastReset = fromWatCivil(wat.year, wat.month, candidateDay, RESET_HOUR_WAT, 0, 0);

  if (lastReset.getTime() > now.getTime()) {
    // This Saturday hasn't happened yet this week in WAT terms; go back 7 days.
    lastReset = fromWatCivil(wat.year, wat.month, candidateDay - 7, RESET_HOUR_WAT, 0, 0);
  }

  const nextReset = new Date(lastReset.getTime() + 7 * 24 * 60 * 60 * 1000);

  return { lastReset, nextReset };
}

/** True if `usagePeriodStart` predates the most recent reset (i.e. is stale). */
function isUsageStale(usagePeriodStart, now = new Date()) {
  if (!usagePeriodStart) return true;
  const { lastReset } = getResetWindow(now);
  return new Date(usagePeriodStart).getTime() < lastReset.getTime();
}

module.exports = { getResetWindow, isUsageStale, WAT_OFFSET_MINUTES };
