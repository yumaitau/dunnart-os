import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { BackupScheduleForm } from './BackupScheduleForm'
import { BackupRestorePanel } from './BackupRestorePanel'
import type { BackupsApi, BackupStatus, RestorePreview } from './backupTypes'

const utcTime = (timestamp: number) => `${new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC`

export const BackupsPanel = ({ admin }: { admin: BackupsApi }) => {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const lifecycle = useRef(0)
  const request = useRef(0)
  const operationPending = useRef(false)

  const refresh = useCallback(async () => {
    const current = lifecycle.current
    const sequence = ++request.current
    try {
      const next = await admin.getBackupStatus()
      if (current === lifecycle.current && sequence === request.current) { setStatus(next); setStatusError(null) }
    } catch (failure) {
      if (current === lifecycle.current && sequence === request.current) setStatusError(failure instanceof Error ? failure.message : 'Could not load backup status.')
    }
  }, [admin])

  useEffect(() => {
    const current = ++lifecycle.current
    setStatus(null)
    setPreview(null)
    setError(null)
    setStatusError(null)
    setNotice(null)
    setBusy(false)
    operationPending.current = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!operationPending.current) await refresh()
      if (current === lifecycle.current) timer = setTimeout(() => void poll(), 10_000)
    }
    void poll()
    return () => { ++lifecycle.current; clearTimeout(timer) }
    // Each capability has its own polling lifecycle; AdminPage owns its disposal.
  }, [refresh])

  const perform = async (action: (isCurrent: () => boolean) => Promise<string | null>) => {
    if (operationPending.current) return
    const current = lifecycle.current
    operationPending.current = true
    ++request.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const message = await action(() => current === lifecycle.current)
      if (current !== lifecycle.current) return
      setNotice(message)
      await refresh()
    } catch (failure) {
      if (current === lifecycle.current) setError(failure instanceof Error ? failure.message : 'Backup operation failed.')
    } finally {
      if (current === lifecycle.current) { operationPending.current = false; setBusy(false) }
    }
  }

  const ready = status?.configured && status.recoveryKeyId !== null && status.coverage.length > 0 && status.coverage.every((item) => item.ready)

  return (
    <div className="space-y-6" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-kumo-strong">Backups</h2>
          <p className="text-sm text-kumo-subtle dark:text-kumo-default">Encrypted deployment archives and isolated recovery.</p>
        </div>
        <Button disabled={busy} onClick={() => void refresh()}>Refresh status</Button>
      </div>
      {error && <p role="alert" className="border-l-4 border-kumo-danger pl-3 text-sm text-kumo-default">{error}</p>}
      {statusError && <p role="alert" className="border-l-4 border-kumo-danger pl-3 text-sm text-kumo-default">{statusError}</p>}
      {notice && <p role="status" className="text-sm text-kumo-default">{notice}</p>}
      {!status && !statusError && <p role="status">Loading backup status…</p>}
      {status && <>
        <section aria-label="Backup readiness" className="rounded-xl border border-kumo-line bg-kumo-elevated p-6 space-y-4">
          <h3 className="font-semibold text-kumo-strong">{statusError ? 'Backup status unavailable' : ready ? 'Ready for backups' : 'Backup setup incomplete'}</h3>
          <p className="text-sm">Recovery public key: {status.recoveryKeyId ?? 'Not configured'}</p>
          {!status.configured && <p className="text-sm">The deployment operator must configure backup storage, the recovery public key, and the isolated restore target.</p>}
          <p className="text-sm text-kumo-subtle dark:text-kumo-default">Keep the matching private recovery key in an offline recovery kit. Only the public key is needed to create backups.</p>
          <h4 className="text-sm font-semibold">Coverage</h4>
          {status.coverage.length === 0 ? <p className="text-sm">Coverage has not been reported.</p> : (
            <ul className="space-y-2 text-sm">{status.coverage.map((item) => (
              <li key={item.id}><span className="font-medium">{item.title}: {item.ready ? 'Ready' : 'Blocked'}</span>{item.reason && <p className="text-kumo-subtle dark:text-kumo-default">{item.reason}</p>}</li>
            ))}</ul>
          )}
          <p className="text-sm">Next scheduled run: {status.nextRunAt === null ? 'Not scheduled' : utcTime(status.nextRunAt)}</p>
          {status.running && <p role="status" className="text-sm">Backup running. Status updates automatically.</p>}
          <Button variant="primary" disabled={busy || !!statusError || !ready || status.running} onClick={() => void perform(async (isCurrent) => {
            const next = await admin.startBackup()
            if (!isCurrent()) return null
            ++request.current
            setStatus(next)
            return next.running ? 'Backup started.' : 'Backup request finished. Check run history for the result.'
          })}>Run backup now</Button>
        </section>
        <section aria-label="Backup schedule" className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
          <BackupScheduleForm key={JSON.stringify(status.schedule)} schedule={status.schedule} busy={busy}
            onSave={(schedule) => perform(async (isCurrent) => {
              const next = await admin.setBackupSchedule(schedule)
              if (!isCurrent()) return null
              ++request.current
              setStatus(next)
              return 'Backup schedule saved.'
            })} />
        </section>
        <section aria-label="Backup history" className="rounded-xl border border-kumo-line bg-kumo-elevated p-6 space-y-4">
          <h3 className="font-semibold text-kumo-strong">Run history</h3>
          {status.runs.length === 0 && <p className="text-sm text-kumo-subtle dark:text-kumo-default">No backups recorded.</p>}
          <ul className="space-y-4">{status.runs.map((run) => (
            <li key={run.id} className="border-t border-kumo-line pt-4 space-y-2">
              <h4 className="text-sm font-semibold break-all">{run.id}</h4>
              <p className="text-sm">{run.status === 'complete' ? 'Complete' : run.status === 'failed' ? 'Failed' : 'Running'} · {run.trigger === 'manual' ? 'Manual' : 'Scheduled'} · {utcTime(run.startedAt)}</p>
              {run.finishedAt !== null && <p className="text-sm text-kumo-subtle dark:text-kumo-default">Finished: {utcTime(run.finishedAt)}</p>}
              <p className="text-sm text-kumo-subtle dark:text-kumo-default">{run.components} components · {run.bytes.toLocaleString()} bytes</p>
              {run.error && <p className="border-l-4 border-kumo-danger pl-3 text-sm text-kumo-default">{run.error}</p>}
              <p className="text-sm">Archive integrity: {run.verifiedAt ? `verified ${utcTime(run.verifiedAt)}` : 'not verified'}</p>
              {run.status === 'complete' && <div className="flex flex-wrap gap-2">
                <Button disabled={busy} aria-label={`Verify archive ${run.id}`} onClick={() => void perform(async () => {
                  const result = await admin.verifyBackup(run.id)
                  return result.verified ? 'Archive integrity verified. A restore drill is still needed to test recovery.' : `Archive verification failed: ${result.issues.join(' ')}`
                })}>Verify archive</Button>
                <Button disabled={busy} aria-label={`Preview restore ${run.id}`} onClick={() => void perform(async (isCurrent) => {
                  const result = await admin.previewBackupRestore(run.id)
                  if (isCurrent()) setPreview(result)
                  return null
                })}>Preview isolated restore</Button>
              </div>}
            </li>
          ))}</ul>
        </section>
      </>}
      {preview && <BackupRestorePanel key={preview.runId} preview={preview} busy={busy} onClose={() => setPreview(null)}
        onStage={(key) => perform(async (isCurrent) => {
          const result = await admin.stageBackupRestore(preview.runId, key)
          if (!isCurrent()) return null
          setPreview(result)
          return result.staged ? `Restore staged in ${result.target}. Production was not changed.` : `Restore staging failed: ${result.issues.join(' ')}`
        })} />}
    </div>
  )
}
