import { useEffect, useRef } from 'react'
import { LinkButton } from '@cloudflare/kumo'
import SiteLogo from '../components/SiteLogo'
import DunnartMark from '../components/DunnartMark'
import { useSiteName } from '../ServerConfigContext'
import { useDocumentTitle } from '../useDocumentTitle'

/** Shared branded fallback for missing routes and resources; never displays a private URL. */
export const NotFoundPage = ({ title = 'Page not found', description = 'This page may have moved, or the link may no longer be available.' }: {
  title?: string
  description?: string
}) => {
  const siteName = useSiteName()
  const heading = useRef<HTMLHeadingElement>(null)
  useDocumentTitle(title)
  useEffect(() => { heading.current?.focus() }, [])
  return (
    <section className="mx-auto flex min-h-[65vh] w-full max-w-xl flex-col items-center justify-center gap-5 px-6 py-16 text-center text-kumo-default" aria-label={title}>
      <div className="flex items-center gap-3 text-lg font-semibold text-kumo-strong">
        <SiteLogo size={40}><DunnartMark size={40} /></SiteLogo><span>{siteName}</span>
      </div>
      <p className="text-sm font-medium tracking-widest text-kumo-subtle">404</p>
      <h1 ref={heading} tabIndex={-1} className="min-w-0 text-3xl font-semibold tracking-tight text-kumo-strong [overflow-wrap:anywhere]">{title}</h1>
      <p className="max-w-md text-sm leading-relaxed text-kumo-subtle">{description}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <LinkButton href="/" variant="primary">Go home</LinkButton>
        <LinkButton href="/workspaces">Your workspaces</LinkButton>
      </div>
    </section>
  )
}
