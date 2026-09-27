import { Combobox } from '@cloudflare/kumo'
import { timeZoneChoices } from '@gadgets/workshop-shared/time-zone'

export const TimeZonePicker = ({ value, disabled, onChange }: {
  value: string
  disabled?: boolean
  onChange: (timeZone: string) => void
}) => {
  return <Combobox modal label="Timezone" items={timeZoneChoices(value)} value={value} disabled={disabled}
    onValueChange={(next) => { if (typeof next === 'string') onChange(next) }}>
    <Combobox.TriggerInput placeholder="Search timezones" />
    <Combobox.Content>
      <Combobox.Empty>No matching timezones</Combobox.Empty>
      <Combobox.List>{(item: string) => <Combobox.Item key={item} value={item}>{item}</Combobox.Item>}</Combobox.List>
    </Combobox.Content>
  </Combobox>
}
