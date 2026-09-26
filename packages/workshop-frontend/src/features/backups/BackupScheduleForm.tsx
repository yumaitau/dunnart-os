import { useRef, useState } from 'react'
import { Button, Input, Select, Switch } from '@cloudflare/kumo'
import type { BackupSchedule } from './backupTypes'

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const BackupScheduleForm = ({ schedule, busy, onSave }: {
  schedule: BackupSchedule
  busy: boolean
  onSave: (schedule: BackupSchedule) => Promise<void>
}) => {
  const [draft, setDraft] = useState(schedule)
  const form = useRef<HTMLFormElement>(null)
  return (
    <form ref={form} className="space-y-4" onSubmit={(event) => { event.preventDefault(); void onSave(draft) }}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-semibold text-kumo-strong">Schedule</h3>
        <Switch aria-label="Enable scheduled backups" checked={draft.enabled} disabled={busy}
          onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
      </div>
      <Select label="Backup frequency" value={draft.frequency} disabled={busy} className="w-full" container={form}
        renderValue={(value) => value === 'weekly' ? 'Weekly' : 'Daily'}
        onValueChange={(frequency) => { if (frequency === 'daily' || frequency === 'weekly') setDraft({ ...draft, frequency }) }}>
        <Select.Option value="daily">Daily</Select.Option>
        <Select.Option value="weekly">Weekly</Select.Option>
      </Select>
      {draft.frequency === 'weekly' && (
        <Select label="Day of week (UTC)" value={String(draft.weekdayUtc)} disabled={busy} className="w-full" container={form}
          renderValue={(value) => weekdays[Number(value)]}
          onValueChange={(value) => { if (value !== null) setDraft({ ...draft, weekdayUtc: Number(value) }) }}>
          {weekdays.map((label, index) => <Select.Option key={label} value={String(index)}>{label}</Select.Option>)}
        </Select>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Hour (UTC, 0–23)" type="number" min={0} max={23} step={1} required
          value={draft.hourUtc} disabled={busy} onChange={(event) => setDraft({ ...draft, hourUtc: Number(event.target.value) })} />
        <Input label="Backups to retain" type="number" min={1} step={1} required
          value={draft.retention} disabled={busy} onChange={(event) => setDraft({ ...draft, retention: Number(event.target.value) })} />
      </div>
      <p className="text-sm text-kumo-subtle dark:text-kumo-default">Times use UTC, including during daylight saving time. Retention keeps this many completed backups.</p>
      <Button type="submit" variant="primary" disabled={busy}>Save schedule</Button>
      </fieldset>
    </form>
  )
}
