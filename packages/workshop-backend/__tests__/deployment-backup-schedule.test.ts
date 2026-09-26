import { describe, expect, it } from "vitest";
import { DEFAULT_BACKUP_SCHEDULE, nextBackupAt, validateBackupSchedule } from "../src/deployment-backup-schedule";

describe("deployment backup schedule", () => {
  it("retains at least one successful archive and rejects invalid UTC fields", () => {
    for (const patch of [{ retention: 0 }, { retention: 101 }, { hourUtc: 24 }, { weekdayUtc: -1 }, { hourUtc: 1.5 }]) {
      expect(() => validateBackupSchedule({ ...DEFAULT_BACKUP_SCHEDULE, ...patch })).toThrow();
    }
  });
  it("handles disabled, same-day, next-day, and weekly boundaries in UTC", () => {
    const now = Date.parse("2026-09-26T02:00:00Z");
    expect(nextBackupAt(DEFAULT_BACKUP_SCHEDULE, now)).toBeNull();
    const daily = { ...DEFAULT_BACKUP_SCHEDULE, enabled: true };
    expect(nextBackupAt(daily, now)).toBe(Date.parse("2026-09-26T03:00:00Z"));
    expect(nextBackupAt(daily, Date.parse("2026-09-26T03:00:00Z"))).toBe(Date.parse("2026-09-27T03:00:00Z"));
    expect(nextBackupAt({ ...daily, frequency: "weekly", weekdayUtc: 6 }, Date.parse("2026-09-26T03:00:00Z")))
      .toBe(Date.parse("2026-10-03T03:00:00Z"));
  });
});
