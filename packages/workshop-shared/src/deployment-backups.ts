/** UTC schedule for complete deployment archives. */
export interface BackupSchedule {
  /** Whether automatic capture is enabled. */
  enabled: boolean;
  /** How often the scheduled UTC time occurs. */
  frequency: "daily" | "weekly";
  /** UTC hour, from 0 through 23. */
  hourUtc: number;
  /** UTC weekday for weekly schedules, from 0 (Sunday) through 6 (Saturday). */
  weekdayUtc: number;
  /** Successful archives to retain, from 1 through 100; latest verified archive is protected. */
  retention: number;
}

/** Readiness of one required deployment component or prerequisite. */
export interface BackupCoverage {
  /** Stable prerequisite identifier. */
  id: string;
  /** Human-readable prerequisite name. */
  title: string;
  /** Whether this prerequisite is currently available. */
  ready: boolean;
  /** Safe explanation when the prerequisite is unavailable. */
  reason?: string;
}

/** Safe persistent summary; archive contents and credentials are never included. */
export interface BackupRun {
  /** Stable authenticated archive identifier. */
  id: string;
  /** Unix milliseconds when queued, or archive upload time after rediscovery. */
  startedAt: number;
  /** Unix milliseconds when finished, or null while running. */
  finishedAt: number | null;
  /** Original trigger, or recovered when original coordinator history is unavailable. */
  trigger: "manual" | "scheduled" | "recovered";
  /** Execution outcome; complete requires full observed capture and archive verification. */
  status: "running" | "complete" | "failed";
  /** Number of required archived components. */
  components: number;
  /** Total plaintext bytes represented by archived components. */
  bytes: number;
  /** Safe failure description without archived content or credentials. */
  error?: string;
  /** Unix milliseconds of last encrypted archive integrity check, not a restore drill. */
  verifiedAt?: number;
}

/** Authoritative setup, schedule, coverage, and recent execution history. */
export interface BackupStatus {
  /** Whether archive storage identity and recovery keys are valid; coverage is checked separately. */
  configured: boolean;
  /** Persisted UTC schedule. */
  schedule: BackupSchedule;
  /** Unix milliseconds of next scheduled capture, or null when disabled. */
  nextRunAt: number | null;
  /** Whether a capture or its required cleanup remains active. */
  running: boolean;
  /** Public recovery-key fingerprint, or null when configuration is invalid. */
  recoveryKeyId: string | null;
  /** Every required prerequisite and its current availability. */
  coverage: BackupCoverage[];
  /** Recent execution history and authenticated rediscovered archives. */
  runs: BackupRun[];
}

/** Authenticated integrity result for every encrypted archive object. */
export interface BackupVerification {
  /** Archive identifier checked. */
  runId: string;
  /** Whether every encrypted object matched its authenticated receipt. */
  verified: boolean;
  /** Safe reasons the archive could not be verified. */
  issues: string[];
}

/** Readiness to decrypt and stage an archive in isolated storage. */
export interface BackupRestorePreview {
  /** Archive identifier to restore. */
  runId: string;
  /** Whether current archive and isolated destination prerequisites are satisfied. */
  ready: boolean;
  /** Safe blockers that must be resolved before staging. */
  issues: string[];
  /** Human-readable isolated destination reference. */
  target: string;
  /** Number of archived components to restore. */
  components: number;
}

/** Result of staging verified content without activating production state. */
export interface BackupRestoreStage extends BackupRestorePreview {
  /** Whether all isolated components and required destination verification completed. */
  staged: boolean;
}
