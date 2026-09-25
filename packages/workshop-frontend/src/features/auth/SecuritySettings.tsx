import { useState } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import QRCode from 'qrcode'
import { authClient } from './authClient'

export const SecuritySettings = () => {
  const session = authClient.useSession()
  const passkeys = authClient.useListPasskeys()
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [setup, setSetup] = useState<{ qr: string; secret: string; codes: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : 'Security setting could not be updated.') }
    finally { setBusy(false) }
  }
  return <section className="space-y-5 rounded-xl border border-kumo-line bg-kumo-base p-6" aria-labelledby="security-title">
    <h2 id="security-title" className="text-lg font-semibold">Security</h2>
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    {message && <p role="status" className="text-sm text-kumo-subtle">{message}</p>}
    <div className="space-y-3">
      <h3 className="font-medium">Passkeys</h3>
      <p className="text-sm text-kumo-subtle">Sign in using your device PIN, biometrics or a security key.</p>
      {passkeys.error && <p role="alert">Could not load passkeys.</p>}
      <ul className="space-y-2">{passkeys.data?.map(key => <li key={key.id} className="flex items-center justify-between gap-3">
        <span>{key.name || 'Passkey'}</span>
        <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await authClient.passkey.deletePasskey({ id: key.id })
          if (result.error) throw new Error(result.error.message)
          setMessage('Passkey removed.')
        })}>Remove</Button>
      </li>)}</ul>
      <Input label="Passkey name" value={name} onChange={event => setName(event.target.value)} placeholder="Personal laptop" />
      <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await authClient.passkey.addPasskey({ name: name.trim() || undefined })
        if (result?.error) throw new Error(result.error.message)
        if (!result?.data) throw new Error('Passkey was not added.')
        setName(''); setMessage('Passkey added.')
      })}>Add passkey</Button>
    </div>
    <div className="space-y-3 border-t border-kumo-line pt-5">
      <h3 className="font-medium">Authenticator MFA</h3>
      <p className="text-sm text-kumo-subtle">Adds a code to password sign-in. Passkeys require device verification; your SSO provider controls MFA for SSO.</p>
      <Input label="Current password (leave empty for SSO accounts)" type="password" autoComplete="current-password"
        value={password} onChange={event => setPassword(event.target.value)} />
      {setup ? <div className="space-y-3">
        <img src={setup.qr} alt="Authenticator enrollment QR code" width={220} height={220} />
        <p className="text-sm">Manual setup key: <code className="break-all select-all">{setup.secret}</code></p>
        <p className="text-sm">Save these one-use recovery codes somewhere private before continuing.</p>
        <pre className="select-all whitespace-pre-wrap rounded-lg bg-kumo-elevated p-3">{setup.codes.join('\n')}</pre>
        <Input label="Authenticator code" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" />
        <Button variant="primary" disabled={busy || !code} onClick={() => void run(async () => {
          const result = await authClient.twoFactor.verifyTotp({ code })
          if (result.error) throw new Error(result.error.message)
          setSetup(null); setCode(''); setPassword(''); setMessage('Authenticator MFA enabled.')
        })}>Verify and enable MFA</Button>
      </div> : session.data?.user.twoFactorEnabled ? <>
        <p className="text-sm">Authenticator MFA is enabled.</p>
        <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await authClient.twoFactor.disable({ password: password || undefined })
          if (result.error) throw new Error(result.error.message)
          setPassword(''); setMessage('Authenticator MFA disabled.')
        })}>Disable MFA</Button>
      </> : <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await authClient.twoFactor.enable({ password: password || undefined })
        if (result.error) throw new Error(result.error.message)
        if (!('totpURI' in result.data)) throw new Error('Authenticator setup was not returned.')
        setSetup({ qr: await QRCode.toDataURL(result.data.totpURI),
          secret: new URL(result.data.totpURI).searchParams.get('secret') || '', codes: result.data.backupCodes })
      })}>Set up authenticator</Button>}
    </div>
    <div className="space-y-3 border-t border-kumo-line pt-5">
      <h3 className="font-medium">Password and sessions</h3>
      <Input label="New password" type="password" autoComplete="new-password" value={newPassword}
        onChange={event => setNewPassword(event.target.value)} minLength={12} maxLength={128} />
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" disabled={busy || !password || newPassword.length < 12} onClick={() => void run(async () => {
          const result = await authClient.changePassword({ currentPassword: password, newPassword, revokeOtherSessions: true })
          if (result.error) throw new Error(result.error.message)
          setPassword(''); setNewPassword(''); setMessage('Password changed; other sessions signed out.')
        })}>Change password</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await authClient.revokeOtherSessions()
          if (result.error) throw new Error(result.error.message)
          setMessage('Other sessions signed out. Open connections close within 30 seconds.')
        })}>Sign out other sessions</Button>
      </div>
    </div>
  </section>
}
