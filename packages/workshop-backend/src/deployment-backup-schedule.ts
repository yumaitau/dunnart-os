import { Temporal } from "temporal-polyfill/implementation";
import type { BackupSchedule } from "@gadgets/workshop-shared/deployment-backups";
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from "@gadgets/workshop-shared/time-zone";

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { enabled: false, frequency: "daily", timeZone: DEFAULT_TIME_ZONE, hour: 3, weekday: 0, retention: 7 };

type LegacySchedule = Omit<BackupSchedule, "timeZone" | "hour" | "weekday"> & { hourUtc: number; weekdayUtc: number };

export function validateBackupSchedule(schedule: BackupSchedule | LegacySchedule): BackupSchedule {
  if (!schedule || typeof schedule !== "object") throw new Error("Invalid backup schedule.");
  // Preserve the exact meaning of schedules saved before timezone selection existed.
  const legacy = !("timeZone" in schedule) && "hourUtc" in schedule;
  const hour = legacy ? schedule.hourUtc : (schedule as BackupSchedule).hour;
  const weekday = legacy ? schedule.weekdayUtc : (schedule as BackupSchedule).weekday;
  const timeZone = normalizeTimeZone(legacy ? "UTC" : (schedule as BackupSchedule).timeZone);
  if (typeof schedule.enabled !== "boolean" || !["daily", "weekly"].includes(schedule.frequency) ||
      !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
      !Number.isInteger(schedule.retention) || schedule.retention < 1 || schedule.retention > 100) {
    throw new Error("Backup schedule requires a daily or weekly frequency, local hour 0–23, weekday 0–6, and retention 1–100.");
  }
  return { enabled: schedule.enabled, frequency: schedule.frequency, timeZone, hour, weekday, retention: schedule.retention };
}

export function nextBackupAt(schedule: BackupSchedule, now: number): number | null {
  if (!schedule.enabled) return null;
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(schedule.timeZone).toPlainDate();
  for (let days = 0; days <= 7; days++) {
    const date = today.add({ days });
    if (schedule.frequency === "weekly" && date.dayOfWeek % 7 !== schedule.weekday) continue;
    // Compatible picks the first repeated hour and advances skipped hours through the DST gap.
    // One candidate per local date ensures an autumn clock change never fires a second backup.
    const next = Temporal.ZonedDateTime.from({ timeZone: schedule.timeZone, year: date.year,
      month: date.month, day: date.day, hour: schedule.hour }, { disambiguation: "compatible" }).epochMilliseconds;
    if (next > now) return next;
  }
  throw new Error("Could not find the next backup occurrence.");
}
