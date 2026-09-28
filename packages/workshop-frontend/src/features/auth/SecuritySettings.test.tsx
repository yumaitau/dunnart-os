// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Toasty } from '@cloudflare/kumo'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SecuritySettings } from './SecuritySettings'

const client = vi.hoisted(() => ({
  deletePasskey: vi.fn<() => Promise<{ error: { message: string } | null }>>(), disable: vi.fn<() => Promise<{ error: { message: string } | null }>>(), revokeOtherSessions: vi.fn<() => Promise<{ error: { message: string } | null }>>(),
}))
vi.mock('./authClient', () => ({ authClient: {
  useSession: () => ({ data: { user: { twoFactorEnabled: true } } }),
  useListPasskeys: () => ({ data: [{ id: 'device-key', name: 'Security key' }] }),
  passkey: { deletePasskey: client.deletePasskey },
  twoFactor: { disable: client.disable },
  revokeOtherSessions: client.revokeOtherSessions,
} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  for (const method of Object.values(client)) method.mockReset().mockResolvedValue({ error: null })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<Toasty><SecuritySettings /></Toasty>))
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const click = async (label: string, scope: ParentNode = document) => {
  const button = [...scope.querySelectorAll('button')].find(element => element.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => button.click())
}
it.each([
  ['Remove', 'Remove passkey', 'deletePasskey'],
  ['Disable MFA', 'Disable MFA', 'disable'],
  ['Sign out other sessions', 'Sign out sessions', 'revokeOtherSessions'],
] as const)('confirms %s before changing account security', async (trigger, action, method) => {
  await click(trigger)
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog).not.toBeNull()
  expect(client[method]).not.toHaveBeenCalled()
  await click('Cancel', dialog)
  expect(client[method]).not.toHaveBeenCalled()
  await click(trigger)
  await click(action, document.querySelector('[role="alertdialog"]')!)
  expect(client[method]).toHaveBeenCalledOnce()
})
it('keeps the confirmation available after a failed security change', async () => {
  client.deletePasskey.mockResolvedValue({ error: { message: 'Please try again.' } })
  await click('Remove'); await click('Remove passkey', document.querySelector('[role="alertdialog"]')!)
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Remove passkey?')
  expect(document.querySelector('[aria-label="Notifications"]')?.textContent).toContain('Security setting could not be updated.')
})
