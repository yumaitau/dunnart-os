import { useState, type FormEvent } from 'react'
import { Button, Input } from '@cloudflare/kumo'
import { authClient } from './authClient'
import { useServerConfig, useSiteName } from '../../ServerConfigContext'

export const BetterLogin = () => {
  const config = useServerConfig()
  const siteName = useSiteName()
  const migrating = config?.accessMigrationEnabled === true && new URLSearchParams(window.location.search).has('migrate')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.') }
    finally { setBusy(false) }
  }
  const signedIn = () => {
    localStorage.removeItem('authToken')
    window.location.assign(migrating ? '/profile' : window.location.pathname)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (migrating) {
        const response = await fetch('/api/auth/access-migration', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
        if (!response.ok) throw new Error('Migration failed or this account was already migrated. Try normal sign-in.')
        signedIn()
      } else if (challenge) {
        const result = recovery ? await authClient.twoFactor.verifyBackupCode({ code })
          : await authClient.twoFactor.verifyTotp({ code })
        if (result.error) throw new Error(result.error.message)
        signedIn()
      } else {
        const result = await authClient.signIn.email({ email, password })
        if (result.error) throw new Error(result.error.message)
        if ('twoFactorRedirect' in result.data && result.data.twoFactorRedirect) { setChallenge(true); setPassword('') } else signedIn()
      }
    })
  }
  return <main className="flex min-h-full items-center justify-center bg-kumo-base p-6">
    <section className="w-full max-w-sm space-y-5">
      <h1 className="text-2xl font-semibold">{migrating ? 'Migrate your account' : `Sign in to ${siteName}`}</h1>
      {migrating && <p className="text-sm text-kumo-subtle">Set a password for your verified account. Your workspaces stay in place. Add a passkey and MFA in your profile next.</p>}
      {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
      <form onSubmit={submit} className="space-y-4">
        {challenge ? <Input label={recovery ? 'Recovery code' : 'Authenticator code'} value={code}
          onChange={event => setCode(event.target.value)} autoComplete="one-time-code" required /> : <>
          {!migrating && <Input label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required />}
          <Input label={migrating ? 'New password (at least 12 characters)' : 'Password'} type="password" value={password}
            onChange={event => setPassword(event.target.value)} autoComplete={migrating ? 'new-password' : 'current-password'}
            minLength={migrating ? 12 : undefined} maxLength={128} required />
        </>}
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Please wait…' : challenge ? 'Verify' : migrating ? 'Migrate account' : 'Sign in'}</Button>
      </form>
      {challenge ? <Button variant="secondary" onClick={() => { setRecovery(!recovery); setCode('') }} disabled={busy}>
        {recovery ? 'Use authenticator' : 'Use recovery code'}</Button> : !migrating && <div className="flex flex-col gap-3">
        <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
          const result = await authClient.signIn.passkey()
          if (result.error) throw new Error(result.error.message)
          signedIn()
        })}>Sign in with a passkey</Button>
        {config?.authVendors.filter(vendor => vendor.vendorId.startsWith('oidc.')).map(vendor =>
          <Button key={vendor.vendorId} variant="secondary" disabled={busy} onClick={() => void run(async () => {
            const result = await authClient.signIn.sso({ providerId: vendor.vendorId.slice(5), callbackURL: '/', errorCallbackURL: '/' })
            if (result.error) throw new Error(result.error.message)
          })}>Continue with {vendor.displayName}</Button>)}
        {config?.accessMigrationEnabled && <a className="text-sm underline" href="/api/auth/access-entry">Migrate an existing account</a>}
      </div>}
      {migrating && <a className="text-sm underline" href="/">Back to sign-in</a>}
    </section>
  </main>
}
