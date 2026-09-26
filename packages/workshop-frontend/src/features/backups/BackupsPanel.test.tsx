// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupsPanel } from './BackupsPanel'
import type { BackupsApi, BackupStatus } from './backupTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialStatus = (): BackupStatus => ({
  configured: true,
  schedule: { enabled: false, frequency: 'daily', hourUtc: 2, weekdayUtc: 0, retention: 7 },
  nextRunAt: null, running: false, recoveryKeyId: 'recovery-key-1',
  coverage: [{ id: 'users', title: 'User workspaces', ready: true }],
  runs: [{ id: 'backup-1', startedAt: 1_790_000_000_000, finishedAt: 1_790_000_002_000,
    trigger: 'manual', status: 'complete', components: 4, bytes: 2048 }],
})

describe('BackupsPanel', () => {
  let container: HTMLDivElement
  let root: Root
  let status: BackupStatus
  let admin: { [K in keyof BackupsApi]: ReturnType<typeof vi.fn<BackupsApi[K]>> }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('PointerEvent', MouseEvent)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn<() => void>() })
    status = initialStatus()
    admin = {
      getBackupStatus: vi.fn<BackupsApi['getBackupStatus']>(async () => status),
      rescanBackupArchives: vi.fn<BackupsApi['rescanBackupArchives']>(async () => status),
      setBackupSchedule: vi.fn<BackupsApi['setBackupSchedule']>(async (schedule) => { status = { ...status, schedule }; return status }),
      startBackup: vi.fn<BackupsApi['startBackup']>(async () => { status = { ...status, running: true }; return status }),
      verifyBackup: vi.fn<BackupsApi['verifyBackup']>(async (runId) => ({ runId, verified: true, issues: [] })),
      previewBackupRestore: vi.fn<BackupsApi['previewBackupRestore']>(async (runId) => ({ runId, ready: true, target: 'isolated-test', components: 4, issues: [] })),
      stageBackupRestore: vi.fn<BackupsApi['stageBackupRestore']>(async (runId) => ({ runId, ready: true, staged: true, target: 'isolated-test', components: 4, issues: [] })),
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const render = () => act(async () => root.render(<StrictMode><BackupsPanel admin={admin} /></StrictMode>))
  const button = (name: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === name || item.textContent === name)
    if (!found) throw new Error(`Missing button: ${name}`)
    return found
  }
  const click = (name: string) => act(async () => button(name).click())
  const select = async (current: string, option: string) => {
    await click(current)
    await act(async () => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent === option)
      if (!item) throw new Error(`Missing option: ${option}`)
      item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      item.click()
    })
  }
  const change = (label: string, value: string) => act(async () => {
    const element = [...container.querySelectorAll('label')].find((item) => item.textContent?.includes(label))!
    const input = document.getElementById(element.htmlFor) as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  it('keeps backups unavailable until all real coverage and key prerequisites are ready', async () => {
    status = { ...status, configured: false, recoveryKeyId: null, coverage: [{ id: 'oauth', title: 'Connector credentials', ready: false, reason: 'Adapter unavailable' }] }
    await render()
    expect(container.textContent).toContain('Backup setup incomplete')
    expect(container.textContent).toContain('Adapter unavailable')
    expect(container.textContent).toContain('Recovery public key: Not configured')
    expect(button('Run backup now').disabled).toBe(true)
    expect(admin.startBackup).not.toHaveBeenCalled()
  })

  it('saves weekly UTC schedule and retention from the form', async () => {
    await render()
    await select('Daily', 'Weekly')
    await select('Sunday', 'Wednesday')
    await click('Enable scheduled backups')
    await change('Hour', '18')
    await change('Backups to retain', '12')
    await click('Save schedule')
    expect(admin.setBackupSchedule).toHaveBeenCalledExactlyOnceWith({ enabled: true, frequency: 'weekly', hourUtc: 18, weekdayUtc: 3, retention: 12 })
    expect(container.textContent).toContain('Backup schedule saved.')
  })

  it('retains edits when a background status refresh has the same saved schedule', async () => {
    await render()
    await change('Hour', '18')
    await click('Refresh status')
    await click('Save schedule')
    expect(admin.setBackupSchedule).toHaveBeenCalledWith({ ...initialStatus().schedule, hourUtc: 18 })
  })

  it('shows real running state and polls through a later failed run', async () => {
    vi.useFakeTimers()
    await render()
    await click('Run backup now')
    expect(container.textContent).toContain('Backup running.')
    expect(button('Run backup now').disabled).toBe(true)
    status = { ...status, running: false, runs: [{ ...status.runs[0]!, status: 'failed', error: 'Storage export failed' }] }
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(container.textContent).toContain('Storage export failed')
    expect(container.querySelector('[aria-label="Verify archive backup-1"]')).toBeNull()
  })

  it('reports archive verification failure without claiming recovery is proven', async () => {
    admin.verifyBackup.mockResolvedValue({ runId: 'backup-1', verified: false, issues: ['Missing encrypted object'] })
    await render()
    await click('Verify archive backup-1')
    expect(container.textContent).toContain('Archive verification failed: Missing encrypted object')
    expect(container.textContent).toContain('Archive integrity: not verified')
  })

  it('shows restore blockers and refuses a private key action until preview is ready', async () => {
    admin.previewBackupRestore.mockResolvedValue({ runId: 'backup-1', ready: false, target: 'isolated-test', components: 4, issues: ['Recovery target unavailable'] })
    await render()
    await click('Preview restore backup-1')
    expect(container.textContent).toContain('Recovery target unavailable')
    expect(button('Stage isolated restore').disabled).toBe(true)
    expect(admin.stageBackupRestore).not.toHaveBeenCalled()
  })

  it('stages only the selected backup with the private kit key and clears the input', async () => {
    await render()
    await click('Preview restore backup-1')
    const key = { kty: 'RSA', n: 'modulus', e: 'AQAB', d: 'private' }
    const file = new File(['unused'], 'recovery.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ privateKey: key }) })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file] })
    await click('Stage isolated restore')
    expect(admin.stageBackupRestore).toHaveBeenCalledExactlyOnceWith('backup-1', key)
    expect(input.value).toBe('')
    expect(container.textContent).toContain('Restore staged in isolated-test. Production was not changed.')
    expect(container.textContent).not.toContain('modulus')
  })

  it('does not send a malformed private key or echo its contents', async () => {
    await render()
    await click('Preview restore backup-1')
    const file = new File(['unused'], 'recovery.json')
    Object.defineProperty(file, 'text', { value: async () => '{"secret":"never-render-me"}' })
    Object.defineProperty(container.querySelector('input[type="file"]')!, 'files', { value: [file] })
    await click('Stage isolated restore')
    expect(admin.stageBackupRestore).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Choose a valid RSA private JWK')
    expect(container.textContent).not.toContain('never-render-me')
  })

  it('shows initial load failure and allows retry', async () => {
    admin.getBackupStatus.mockRejectedValue(new Error('Backup service unavailable'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Backup service unavailable')
    admin.getBackupStatus.mockResolvedValue(status)
    await click('Refresh status')
    expect(container.textContent).toContain('Ready for backups')
  })

  it('imports verified archives into an empty run history after an explicit rescan', async () => {
    status = { ...status, runs: [] }
    admin.rescanBackupArchives.mockImplementation(async () => {
      status = { ...status, runs: [{ ...initialStatus().runs[0]!, id: 'recovered-archive', trigger: 'recovered' }] }
      return status
    })
    await render()
    expect(container.textContent).toContain('No backups recorded.')
    expect(admin.rescanBackupArchives).not.toHaveBeenCalled()
    await click('Rescan archive storage')
    expect(admin.rescanBackupArchives).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Archive storage rescanned. Run history refreshed.')
    expect(container.textContent).toContain('recovered-archive')
    expect(container.textContent).toContain('Recovered from archive storage')
    expect(button('Preview restore recovered-archive').disabled).toBe(false)
    expect(container.textContent).not.toContain('No backups recorded.')
  })

  it('reports a failed archive rescan without inventing recovered history', async () => {
    status = { ...status, runs: [] }
    admin.rescanBackupArchives.mockRejectedValue(new Error('Archive verification failed. Check the configured signing key.'))
    await render()
    await click('Rescan archive storage')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Archive verification failed. Check the configured signing key.')
    expect(container.textContent).toContain('No backups recorded.')
    expect(container.textContent).not.toContain('Run history refreshed.')
    expect(button('Rescan archive storage').disabled).toBe(false)
  })

  it('preserves an operation failure across successful background refreshes', async () => {
    vi.useFakeTimers()
    admin.startBackup.mockRejectedValue(new Error('The archive quota is exhausted'))
    await render()
    await click('Run backup now')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The archive quota is exhausted')
  })

  it('ignores an older status response after the administrator refreshes again', async () => {
    await render()
    let resolveOlder!: (value: BackupStatus) => void
    admin.getBackupStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve }))
    await click('Refresh status')
    status = { ...status, recoveryKeyId: 'new-recovery-key' }
    await click('Refresh status')
    await act(async () => resolveOlder(initialStatus()))
    expect(container.textContent).toContain('new-recovery-key')
  })

  it('cancels polling on unmount without disposing the borrowed admin capability', async () => {
    vi.useFakeTimers()
    const dispose = vi.fn<() => void>()
    Object.assign(admin, { [Symbol.dispose]: dispose })
    await render()
    await act(async () => root.render(null))
    const reads = admin.getBackupStatus.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(admin.getBackupStatus).toHaveBeenCalledTimes(reads)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('does not send a private key when its file finishes reading after leaving the page', async () => {
    await render()
    await click('Preview restore backup-1')
    let finishReading!: (value: string) => void
    const file = new File(['unused'], 'recovery.json')
    Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve) => { finishReading = resolve }) })
    Object.defineProperty(container.querySelector('input[type="file"]')!, 'files', { value: [file] })
    await click('Stage isolated restore')
    await act(async () => root.render(null))
    await act(async () => finishReading(JSON.stringify({ kty: 'RSA', n: 'n', e: 'e', d: 'd' })))
    expect(admin.stageBackupRestore).not.toHaveBeenCalled()
  })
})
