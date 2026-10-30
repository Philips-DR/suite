// A question before something is removed: what will go, what will not be touched, and a button that says
// what it does. Cancel has the focus, so Enter on a stray key press never deletes.
//
// It is drawn straight into <body>, never where it is used. Found live (2026-10-30): inside a list row whose
// entrance animates `transform`, a `position: fixed` dialog is fixed to the row, not the screen -- its backdrop
// covered one row, the rows after it painted over it, and pressing its button pressed the row underneath.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconAlert } from './icons'
import '../styles/panels/confirm.css'

interface Props {
  title: string
  /** Name, size, date: what will go, one pair per line. */
  facts?: [string, string][]
  /** What is not touched, in a sentence. */
  keeps?: string
  /** Anything else worth showing, such as a preview the tool gave. */
  children?: ReactNode
  /** The button's own words: "Delete", "Move to bin", "Clear chat". */
  verb: string
  /** False while what will go is still being found out: the delete button waits, Cancel never does. */
  ready?: boolean
  busy?: boolean
  error?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDelete({ title, facts, keeps, children, verb, ready = true, busy = false, error = '', onConfirm, onCancel }: Props) {
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const was = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => was?.focus?.()
  }, [])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab') {
      // Two buttons and nothing else to reach: keep the focus inside the question.
      const first = cancel.current
      const last = confirm.current
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
  }

  return createPortal(
    <div className="confirm-root" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-keeps" onKeyDown={onKey}>
      <div className="confirm-backdrop" onClick={() => { if (!busy) onCancel() }} />
      <div className="confirm">
        <h2 id="confirm-title">{title}</h2>
        {facts && facts.length > 0 && (
          <dl className="confirm-facts">
            {facts.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        )}
        {children}
        <p className="confirm-warning" id="confirm-keeps">
          <IconAlert size={16} aria-hidden />
          <span>This cannot be undone here.{keeps ? ` ${keeps}` : ''}</span>
        </p>
        {error && <p className="error small" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button ref={cancel} onClick={onCancel} disabled={busy}>Cancel</button>
          <button ref={confirm} className="danger" onClick={onConfirm} disabled={busy || !ready}>{busy ? 'Working…' : verb}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** "1.4 MB", "820 KB": what a person reads, not a byte count. */
export function sizeOf(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
