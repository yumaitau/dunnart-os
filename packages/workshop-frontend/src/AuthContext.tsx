import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { DEFAULT_TIME_ZONE } from '@gadgets/workshop-shared/time-zone'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  /** Current user info, fetched once on mount. Null while loading. */
  currentUser: AiChatAuthorInfo | null
  /** Whether the current user is a deployment admin. False while loading / for non-admins. */
  isAdmin: boolean
  timeZone: string
  timeZoneLoaded: boolean
  timeZoneError: boolean
  saveTimeZone: (timeZone: string) => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

export function AuthProvider({ children, authenticatedApi, onLogout }: AuthProviderProps) {
  const [currentUser, setCurrentUser] = useState<AiChatAuthorInfo | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [zone, setZone] = useState<{ api: typeof authenticatedApi; value: string; error: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => authenticatedApi.getTimeZone()).then((value) => {
      if (!cancelled) setZone({ api: authenticatedApi, value, error: false })
    }).catch(() => {
      if (!cancelled) setZone({ api: authenticatedApi, value: DEFAULT_TIME_ZONE, error: true })
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const saveTimeZone = async (value: string) => {
    await authenticatedApi.setTimeZone(value)
    setZone({ api: authenticatedApi, value, error: false })
  }
  const currentZone = zone?.api === authenticatedApi ? zone : null

  useEffect(() => {
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled) setCurrentUser(info)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.amIAdmin().then((admin) => {
      if (!cancelled) setIsAdmin(admin)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  return (
    <AuthContext.Provider value={{ authenticatedApi, logout: onLogout, currentUser, isAdmin,
      timeZone: currentZone?.value ?? DEFAULT_TIME_ZONE, timeZoneLoaded: currentZone !== null,
      timeZoneError: currentZone?.error ?? false, saveTimeZone }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

/** Returns the auth context when inside an AuthProvider, or null on public pages. */
export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}

/** The saved account timezone, with Sydney used for public pages and while loading. */
export function useTimeZone(): string {
  return useContext(AuthContext)?.timeZone ?? DEFAULT_TIME_ZONE
}
