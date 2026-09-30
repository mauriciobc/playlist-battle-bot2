/** Unit conversions for the seconds-based config and unix-second API timestamps. */

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;

/** `date` moved `seconds` later. */
export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * MS_PER_SECOND);
}

export function fromUnixSeconds(seconds: number): Date {
  return new Date(seconds * MS_PER_SECOND);
}


/**
 * ISO-8601 week identifier, `YYYY-Www`, for the moment given.
 *
 * Weeks start Monday. The key is the leaderboard's idempotency unit, so it must
 * be a pure function of the instant: a restart in the same week computes the
 * same key and skips, and a new week computes a new one.
 */
export function isoWeek(date: Date): string {
  // Thursday of the current week decides the ISO year, so shift to it first:
  // days near New Year can otherwise land in the wrong year.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - day + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Start of the ISO week (Monday, UTC) containing the moment given. */
export function isoWeekStart(date: Date): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - day);
  return start;
}
/** Whole unix seconds of an epoch-milliseconds timestamp. */
export function toUnixSeconds(ms: number): number {
  return Math.floor(ms / MS_PER_SECOND);
}
