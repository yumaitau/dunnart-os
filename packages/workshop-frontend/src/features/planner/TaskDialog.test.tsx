// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskDialog, type EditorState } from './TaskDialog'

;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, container: HTMLDivElement
const task = {id:'task',order:0,title:'Review delivery notes',description:'',status:'todo' as const,dueDate:null,dueTime:null,priority:'normal' as const}
let editor: EditorState, pending: boolean
const remove = vi.fn<(id:string)=>Promise<boolean>>()
const close = vi.fn<()=>void>()
beforeEach(() => {
  pending=false;editor={kind:'task',task,date:'',time:''};remove.mockReset().mockResolvedValue(true);close.mockReset()
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(() => {act(()=>root.unmount());container.remove()})
const render=()=>act(async()=>root.render(<TaskDialog editor={editor} pending={pending} error={null} onClose={close}
  onSaveTask={async()=>true} onSaveEvent={async()=>true} onDeleteTask={remove} onDeleteEvent={remove}/>))
const click=(name:string,scope:ParentNode=document)=>act(async()=>{
  const button=[...scope.querySelectorAll('button')].find(e=>e.textContent===name)
  if(!button)throw new Error(name);button.click()
})
it('requires themed confirmation before deleting a task and allows cancellation',async()=>{
  await render();await click('Delete')
  const dialog=document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Delete task?');expect(remove).not.toHaveBeenCalled()
  await click('Cancel',dialog);expect(remove).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
  await click('Delete',document.querySelector('[role="dialog"]')!)
  await click('Delete',document.querySelector('[role="alertdialog"]')!)
  expect(remove).toHaveBeenCalledExactlyOnceWith('task');expect(close).toHaveBeenCalledOnce()
})
it('keeps a failed event deletion open and disables repeat submission while pending',async()=>{
  editor={kind:'event',event:{id:'event',title:'Review',date:'2026-09-28',time:null,notes:''},date:'',time:''}
  remove.mockResolvedValue(false);await render();await click('Delete');await click('Delete',document.querySelector('[role="alertdialog"]')!)
  expect(remove).toHaveBeenCalledExactlyOnceWith('event');expect(close).not.toHaveBeenCalled()
  pending=true;await render()
  const dialog=document.querySelector('[role="alertdialog"]')!
  expect([...dialog.querySelectorAll('button')].every(button=>button.disabled)).toBe(true)
})
