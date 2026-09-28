import { useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import { TimeZonePicker } from './TimeZonePicker'

export const TimeZoneSettings = () => {
  const toasts = useKumoToastManager()
  const { timeZone, timeZoneLoaded, timeZoneError, saveTimeZone } = useAuthenticatedApi()
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <section aria-label="Timezone settings" className="space-y-3 rounded-xl border border-kumo-line p-5">
      <h2 className="font-semibold text-kumo-strong">Date and time</h2>
      <p className="text-sm text-kumo-subtle">Saved to your account. Defaults to Australia/Sydney and follows daylight saving. Existing schedules keep their own timezone.</p>
      <TimeZonePicker value={draft ?? timeZone} disabled={busy || !timeZoneLoaded} onChange={(value) => { setDraft(value); setMessage(null) }} />
      {timeZoneError && <p role="alert">Could not load your saved timezone. Reload to retry, or choose and save a timezone.</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <Button disabled={busy || !timeZoneLoaded || draft === null} onClick={async () => {
        if (draft === null) return
        setBusy(true); setError(null); setMessage(null)
        try { await saveTimeZone(draft); setDraft(null); setMessage('Timezone saved.'); toasts.add({title: 'Timezone saved.', variant: 'success'}) }
        catch { setError('Could not confirm timezone save. Reload to check, or retry.'); toasts.add({title: 'Timezone could not be saved.', variant: 'error'}) }
        finally { setBusy(false) }
      }}>Save timezone</Button>
    </section>
  )
}
