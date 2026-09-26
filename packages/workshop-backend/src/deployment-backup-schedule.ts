import type { BackupSchedule } from "@gadgets/workshop-shared/deployment-backups";

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = { enabled: false, frequency: "daily", hourUtc: 3, weekdayUtc: 0, retention: 7 };

export function validateBackupSchedule(schedule: BackupSchedule): BackupSchedule {
  if (!schedule || typeof schedule.enabled !== "boolean" || !["daily", "weekly"].includes(schedule.frequency) ||
      !Number.isInteger(schedule.hourUtc) || schedule.hourUtc < 0 || schedule.hourUtc > 23 ||
      !Number.isInteger(schedule.weekdayUtc) || schedule.weekdayUtc < 0 || schedule.weekdayUtc > 6 ||
      !Number.isInteger(schedule.retention) || schedule.retention < 1 || schedule.retention > 100) {
    throw new Error("Backup schedule requires a daily or weekly frequency, UTC hour 0–23, weekday 0–6, and retention 1–100.");
  }
  return { enabled: schedule.enabled, frequency: schedule.frequency, hourUtc: schedule.hourUtc,
    weekdayUtc: schedule.weekdayUtc, retention: schedule.retention };
}

export function nextBackupAt(schedule: BackupSchedule, now: number): number | null {
  if (!schedule.enabled) return null;
  const date = new Date(now);
  date.setUTCHours(schedule.hourUtc, 0, 0, 0);
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  if (schedule.frequency === "weekly") date.setUTCDate(date.getUTCDate() + (schedule.weekdayUtc - date.getUTCDay() + 7) % 7);
  return date.getTime();
}
