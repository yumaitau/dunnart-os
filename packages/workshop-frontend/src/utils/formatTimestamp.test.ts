import { describe, expect, it } from 'vitest';
import { formatFullTimestamp, zonedDateKey, zonedDayNumber } from './formatTimestamp';

describe('account timezone formatting', () => {
  it('defaults to Sydney rather than the device date', () => {
    expect(zonedDateKey(new Date('2026-01-01T14:00:00Z'))).toBe('2026-01-02');
    expect(zonedDateKey(new Date('2026-01-01T14:00:00Z'), 'America/New_York')).toBe('2026-01-01');
  });
  it('counts calendar days across the Sydney spring change', () => {
    expect(zonedDayNumber(new Date('2026-10-04T13:00:00Z')) - zonedDayNumber(new Date('2026-10-03T14:00:00Z'))).toBe(1);
  });
  it('uses the selected zone for timestamps and separate cached formatters', () => {
    const date = new Date('2026-01-01T14:00:00Z');
    const expected = (timeZone: string) => new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(date);
    expect(formatFullTimestamp(date)).toBe(expected('Australia/Sydney'));
    expect(formatFullTimestamp(date, 'UTC')).toBe(expected('UTC'));
    expect(formatFullTimestamp(date)).toBe(expected('Australia/Sydney'));
  });
});
