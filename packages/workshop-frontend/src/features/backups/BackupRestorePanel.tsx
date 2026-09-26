import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import type { BackupsApi, RestorePreview } from './backupTypes'

export const BackupRestorePanel = ({ preview, busy, onStage, onClose }: {
  preview: RestorePreview
  busy: boolean
  onStage: (key: Parameters<BackupsApi['stageBackupRestore']>[1]) => Promise<void>
  onClose: () => void
}) => {
  const fileInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const lifecycle = useRef(0)
  useEffect(() => {
    ++lifecycle.current
    return () => { ++lifecycle.current }
  }, [])

  const stage = async () => {
    const file = fileInput.current?.files?.[0]
    const current = lifecycle.current
    if (!file) { setError('Choose your private recovery key JSON file.'); return }
    setReading(true)
    setError(null)
    try {
      if (file.size > 64 * 1024) throw new Error('invalid key')
      const raw: unknown = JSON.parse(await file.text())
      if (current !== lifecycle.current) return
      const key = typeof raw === 'object' && raw !== null && 'privateKey' in raw ? raw.privateKey : raw
      if (typeof key !== 'object' || key === null || !('kty' in key) || key.kty !== 'RSA' ||
        !('d' in key) || typeof key.d !== 'string' || !key.d ||
        !('n' in key) || typeof key.n !== 'string' || !key.n ||
        !('e' in key) || typeof key.e !== 'string' || !key.e) throw new Error('invalid key')
      // Hold key only in this action, never component state or browser storage.
      await onStage({ ...key, kty: 'RSA', d: key.d, n: key.n, e: key.e })
    } catch {
      if (current === lifecycle.current) setError('Could not read the private recovery key. Choose a valid RSA private JWK JSON file.')
    } finally {
      if (fileInput.current) fileInput.current.value = ''
      if (current === lifecycle.current) setReading(false)
    }
  }

  return (
    <section aria-label="Isolated restore preview" className="rounded-xl border border-kumo-line bg-kumo-elevated p-6 space-y-4">
      <h3 className="font-semibold text-kumo-strong">Isolated restore preview</h3>
      <p className="text-sm text-kumo-subtle dark:text-kumo-default">Backup: {preview.runId}</p>
      <p className="text-sm break-words">Target: {preview.target}</p>
      <p className="text-sm">Components: {preview.components}</p>
      <p className="text-sm">{preview.ready ? 'Ready to stage into isolated storage.' : 'Restore blocked.'}</p>
      {preview.issues.length > 0 && <ul className="list-disc pl-5 text-sm">{preview.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      <p className="text-sm text-kumo-subtle dark:text-kumo-default">Staging decrypts this archive into isolated recovery storage. Production remains active; staging does not enable scheduled tasks or send external messages.</p>
      <Input ref={fileInput} label="Private recovery key JSON file" type="file" accept=".json,application/json" className="min-w-0 w-full"
        disabled={!preview.ready || busy || reading} />
      <p className="text-sm text-kumo-subtle dark:text-kumo-default">The selected key is sent to the trusted recovery service for this restore only. Keep your offline recovery kit safe.</p>
      {error && <p role="alert" className="border-l-4 border-kumo-danger pl-3 text-sm text-kumo-default">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!preview.ready || busy || reading} onClick={() => void stage()}>Stage isolated restore</Button>
        <Button disabled={busy || reading} onClick={onClose}>Close preview</Button>
      </div>
    </section>
  )
}
