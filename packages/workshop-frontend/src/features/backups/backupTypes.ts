import type { AdminApi } from '@gadgets/workshop-shared/api'

/** The parent AdminPage owns and disposes the admin capability. */
export type BackupsApi = Pick<AdminApi, 'getBackupStatus' | 'setBackupSchedule' | 'startBackup' | 'verifyBackup' | 'previewBackupRestore' | 'stageBackupRestore' | 'rescanBackupArchives'>
export type BackupStatus = Awaited<ReturnType<AdminApi['getBackupStatus']>>
export type BackupSchedule = Parameters<AdminApi['setBackupSchedule']>[0]
export type RestorePreview = Awaited<ReturnType<AdminApi['previewBackupRestore']>>
