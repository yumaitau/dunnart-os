// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { NotFoundPage } from './NotFoundPage'

;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
it('offers branded safe recovery links and focuses the missing-page heading',async()=>{
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  try{
    await act(async()=>root.render(<NotFoundPage/>))
    expect(container.textContent).toContain('Dunnart');expect(container.textContent).toContain('404')
    expect(container.querySelector('a[href="/"]')?.textContent).toBe('Go home')
    expect(document.activeElement).toBe(container.querySelector('h1'))
  }finally{act(()=>root.unmount());container.remove()}
})
