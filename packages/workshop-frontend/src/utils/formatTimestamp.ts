import { DEFAULT_TIME_ZONE } from '@gadgets/workshop-shared/time-zone';
// Locale-aware timestamp formatting for chat UI tooltips.
//
// `Intl.DateTimeFormat(undefined, ...)` uses the browser's preferred locale, which already encodes
// the user's 12h vs 24h preference (e.g. en-US -> 12h, en-GB -> 24h, en-US-u-hc-h23 -> 24h). We
// intentionally do not pass `hour12` or `hourCycle` so the OS/browser setting wins.
//
// The formatter instance is cached at module scope because constructing `Intl.DateTimeFormat` is
// surprisingly expensive and a chat view can render hundreds of timestamps.

const fullTimestampFormatters = new Map<string, Intl.DateTimeFormat>();

function getFullTimestampFormatter(timeZone: string): Intl.DateTimeFormat {
  let fullTimestampFormatter = fullTimestampFormatters.get(timeZone);
  if (!fullTimestampFormatter) {
    fullTimestampFormatter = new Intl.DateTimeFormat(undefined, {
      timeZone,
      dateStyle: "short",
      timeStyle: "short",
    });
    fullTimestampFormatters.set(timeZone, fullTimestampFormatter);
  }
  return fullTimestampFormatter;
}

/**
 * Format a date as a locale-aware short date + time, e.g. "5/11/26, 5:09 PM" (en-US) or
 * "11/05/2026, 17:09" (en-GB). Intended for chat timestamp tooltips that need to disambiguate
 * which day a message belongs to.
 */
export function formatFullTimestamp(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  return getFullTimestampFormatter(timeZone).format(date);
}

/** Calendar date in the selected timezone, independent of the device timezone. */
export function zonedDateKey(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Day number for calendar grouping, unaffected by 23-hour or 25-hour daylight-saving days. */
export function zonedDayNumber(date: Date, timeZone = DEFAULT_TIME_ZONE): number {
  return Date.parse(`${zonedDateKey(date, timeZone)}T00:00:00Z`) / 86_400_000;
}
