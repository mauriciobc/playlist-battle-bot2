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

/** Whole unix seconds of an epoch-milliseconds timestamp. */
export function toUnixSeconds(ms: number): number {
  return Math.floor(ms / MS_PER_SECOND);
}
