import { describe, expect, it } from "vitest";
import { DEFAULT_BACKUP_SCHEDULE, nextBackupAt, validateBackupSchedule } from "../src/deployment-backup-schedule";

const daily = { ...DEFAULT_BACKUP_SCHEDULE, enabled: true, hour: 2 };
const next = (now: string, patch = {}) => new Date(nextBackupAt({ ...daily, ...patch }, Date.parse(now))!).toISOString();

describe("deployment backup schedule", () => {
  it("defaults to Sydney and validates timezone and schedule fields", () => {
    expect(DEFAULT_BACKUP_SCHEDULE.timeZone).toBe("Australia/Sydney");
    for (const patch of [{ retention: 0 }, { retention: 101 }, { hour: 24 }, { weekday: -1 }, { hour: 1.5 }, { timeZone: "Mars/Base" }, { timeZone: "+10:00" }, { timeZone: "" }]) {
      expect(() => validateBackupSchedule({ ...daily, ...patch })).toThrow();
    }
    expect(nextBackupAt(DEFAULT_BACKUP_SCHEDULE, Date.now())).toBeNull();
  });
  it("preserves legacy UTC schedules without changing their wall-clock interpretation", () => {
    const migrated = validateBackupSchedule({ enabled: true, frequency: "weekly", hourUtc: 2, weekdayUtc: 6, retention: 7 });
    expect(migrated).toEqual({ enabled: true, frequency: "weekly", timeZone: "UTC", hour: 2, weekday: 6, retention: 7 });
    expect(nextBackupAt(migrated, Date.parse("2026-09-26T02:00:00Z"))).toBe(Date.parse("2026-10-03T02:00:00Z"));
  });
  it("keeps the same Sydney wall time in summer and winter", () => {
    expect(next("2026-01-01T00:00:00Z")).toBe("2026-01-01T15:00:00.000Z");
    expect(next("2026-06-01T00:00:00Z")).toBe("2026-06-01T16:00:00.000Z");
  });
  it("advances a skipped spring hour and restores the usual hour on the next day", () => {
    expect(next("2026-10-03T14:00:00Z")).toBe("2026-10-03T16:00:00.000Z");
    expect(next("2026-10-03T16:00:00Z")).toBe("2026-10-04T15:00:00.000Z");
  });
  it("runs a repeated autumn hour only once, including between its two occurrences", () => {
    expect(next("2026-04-04T14:00:00Z")).toBe("2026-04-04T15:00:00.000Z");
    expect(next("2026-04-04T15:00:00Z")).toBe("2026-04-05T16:00:00.000Z");
    expect(next("2026-04-04T15:30:00Z")).toBe("2026-04-05T16:00:00.000Z");
  });
  it("uses local weekdays and handles fractional-offset timezones", () => {
    expect(next("2026-10-03T14:00:00Z", { frequency: "weekly", weekday: 0 })).toBe("2026-10-03T16:00:00.000Z");
    expect(next("2026-09-26T00:00:00Z", { timeZone: "Asia/Kathmandu" })).toBe("2026-09-26T20:15:00.000Z");
  });
});
