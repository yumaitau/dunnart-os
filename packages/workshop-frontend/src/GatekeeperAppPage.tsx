import { NotFoundPage } from './pages/NotFoundPage'
import { Button } from '@cloudflare/kumo'
import { useEffect, useState } from 'react'
import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import SandboxedGatekeeperApp from './SandboxedGatekeeperApp'
import { reportIssue } from './errorReporting'

// The frame's `ui` is an RPC stub at runtime; dispose it to release the server-side capability.
function disposeFrame(frame: GatekeeperUiFrame | null) {
  (frame?.ui as { [Symbol.dispose]?(): void } | undefined)?.[Symbol.dispose]?.()
}

/**
 * Renders a gatekeeper's full-page management app (a sandboxed SPA the gatekeeper serves).
 * Fetches the app frame (iframe HTML + `ui` capability) from the backend and hosts it.
 */
export default function GatekeeperAppPage({ appId }: { appId: string }) {
  const { authenticatedApi } = useAuthenticatedApi()
  // Wrap the frame in an object: it holds a `ui` RPC stub, and we never want useState's setter to
  // treat a stored value as an updater function.
  const [state, setState] = useState<{ frame: GatekeeperUiFrame; api: typeof authenticatedApi; appId: string } | null>(null)
  const [error, setError] = useState<{ api: typeof authenticatedApi; appId: string; missing: boolean } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setState(null)
    setError(null)
    let cancelled = false
    let acquired: GatekeeperUiFrame | null = null
    authenticatedApi
      .getGatekeeperApp(appId)
      .then((frame) => {
        if (!frame) {
          if (!cancelled) setError({ api: authenticatedApi, appId, missing: true })
          return
        }
        if (cancelled) {
          disposeFrame(frame)
          return
        }
        acquired = frame
        setState({ frame, api: authenticatedApi, appId })
      })
      .catch((err) => {
        console.error('Failed to load gatekeeper app:', err)
        reportIssue('gatekeeper-app.load', err, {
          gatekeeperVendorId: appId,
        })
        if (!cancelled) setError({api: authenticatedApi, appId, missing: false})
      })
    return () => {
      cancelled = true
      disposeFrame(acquired)
    }
  }, [authenticatedApi, appId, attempt])

  const currentError = error?.api === authenticatedApi && error.appId === appId ? error : null
  if (currentError?.missing) return <NotFoundPage title="App not found" description="This app is not available on this deployment." />
  if (currentError) return <div className="mx-auto max-w-md space-y-4 px-4 py-16 text-center text-sm text-kumo-default"><p role="alert">Could not load this app. Try again.</p><Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button></div>
  if (!state || state.api !== authenticatedApi || state.appId !== appId) {
    return <div role="status" className="px-4 py-16 text-center text-sm text-kumo-subtle">Loading…</div>
  }

  // Fill the routed area below the header so the embedded app can manage its own internal layout.
  return (
    <div className="h-full">
      <SandboxedGatekeeperApp frame={state.frame} gatekeeperVendorId={appId} />
    </div>
  )
}
