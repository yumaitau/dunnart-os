import type { RecoverySource, RecoveryTarget } from "@gadgets/backend-utils/recovery-repository";
import type { BackupCoverage } from "@gadgets/workshop-shared/deployment-backups";

/** An inventory provider owns fencing, component discovery, and isolated storage adapters. */
export interface DeploymentRecovery {
  /** Include every required component and all currently missing prerequisites. */
  coverage(): Promise<BackupCoverage[]>;
  /** Close admission, drain writes, and freeze source actors for quiesced observed capture. Idempotent by run. */
  acquire(run: string): Promise<{ required: string[]; sources: RecoverySource[]; capturedAt: string }>;
  /** Release persisted fences even after a coordinator restart or partial acquisition. */
  release(run: string): Promise<void>;
  /** Revalidate source fences and observed contents before publication; KV visibility still follows replication. */
  validate(run: string): Promise<void>;
  /** Report actual isolated target availability without writing or dispatching anything. */
  preview(run: string, required: string[]): Promise<{ target: string; issues: string[] }>;
  /** Build inactive targets; never return production storage or enable external dispatch. */
  targets(run: string, required: string[]): Promise<RecoveryTarget[]>;
  /** Activate only the isolated runtime and verify usable restored behavior after every component imports. */
  finalizeRestore(run: string, required: string[]): Promise<void>;
  /** Authorize the isolated target name only after archive inventory and runtime verification. */
  getRestoredWorkspaceTarget(run: string, originalWorkspaceId: string): Promise<string>;
}

/** Optional deployment-owned recovery bindings; private key deliberately absent. */
export type DeploymentBackupEnv = Cloudflare.Env & {
  BACKUPS?: R2Bucket;
  BACKUP_RESTORE?: R2Bucket;
  BACKUP_DEPLOYMENT_ID?: string;
  BACKUP_PUBLIC_KEY?: string;
  BACKUP_AUTHENTICATION_KEY?: string;
};
