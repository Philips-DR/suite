// What a page shows after docu-ai builds a Google Doc, shared by Documents and Meetings: the link, the page count and
// anything to check before using it, and, when the same thing was built again, the earlier Doc offered to the bin.
// A button that moves a Doc to the bin asks first, in a dialog showing what docu-ai says the Doc is.

import { useState } from 'react'
import { ask } from '../call'
import { ConfirmDelete } from '../ui/ConfirmDelete'
import { IconAlert, IconCheck, IconExternal, IconTrash } from '../ui/icons'
import { ago } from '../ui/time'
import { pagesLine, type Layout } from './documentText'
import '../styles/panels/built.css'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface BuiltDoc {
  documentId: string
  url: string
  title: string
  residue: string[]
  imageWarnings?: string[]
  layout?: Layout
  /** When this page built it, to tell the builds of one thing apart. */
  at: number
  /** The page limit it was built against: the buttons may have changed since. */
  limit: number
}

/** A document named well enough to be asked about: what the bin dialog and its preview need. */
export interface Named {
  documentId: string
  title: string
}

/** What to check in a build before using it: page breaks, leftover markdown, images that were not placed. */
export function problemsOf(built: BuiltDoc): string[] {
  return [
    ...(built.layout?.measured ? built.layout.warnings : []),
    ...built.residue.map((r) => `Markdown left in the text: ${r}`),
    ...(built.imageWarnings ?? []),
  ]
}

/** A button that moves one document to the bin, after a dialog that shows what docu-ai says it is. */
export function BinButton({ doc, label, onTrashed, onError }: {
  doc: Named
  label: string
  onTrashed: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  // What docu-ai says it is about to trash (its own `info`, as the gate shows in chat); null while not asking.
  const [preview, setPreview] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')

  const trash = async (confirmed: boolean) => {
    setBusy(true)
    setError('')
    onError('')
    try {
      const result = await ask('docu_ai__trash', { documentId: doc.documentId }, confirmed)
      if (result.confirm) {
        setPreview(result.preview ?? '')
        setAsking(true)
      } else {
        setAsking(false)
        onTrashed()
      }
    } catch (e) {
      if (asking) setError(message(e))
      else onError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="ghost" disabled={busy} onClick={() => void trash(false)} aria-label={`Move “${doc.title}” to the bin`}>
        <IconTrash size={14} aria-hidden />
        {busy && !asking ? 'Checking…' : label}
      </button>
      {asking && (
        <ConfirmDelete
          title={`Move “${doc.title}” to the bin?`}
          keeps="It stays in Google Drive's Trash for 30 days, where you can restore it from Drive."
          verb="Move to bin"
          busy={busy}
          error={error}
          onConfirm={() => void trash(true)}
          onCancel={() => setAsking(false)}
        >
          {preview && <pre className="confirm-preview">{preview}</pre>}
        </ConfirmDelete>
      )}
    </>
  )
}

/** The newest build, and each earlier one built from the same thing while the page was open, offered to the bin. */
export function Builds({ builds, onBinned }: { builds: BuiltDoc[]; onBinned: () => void }) {
  const [binned, setBinned] = useState<string[]>([])
  const [error, setError] = useState('')
  const latest = builds[0]
  if (!latest) return null
  const problems = problemsOf(latest)
  const earlier = builds.slice(1).filter((b) => !binned.includes(b.documentId))
  return (
    <>
      <div className={`built ${problems.length ? 'warn' : ''}`} role="status">
        <span className="built-icon">
          {problems.length ? <IconAlert size={15} strokeWidth={2.6} aria-hidden /> : <IconCheck size={16} strokeWidth={2.8} aria-hidden />}
        </span>
        <div className="built-text">
          <a href={latest.url} target="_blank" rel="noreferrer">Open “{latest.title}” in Google Docs <IconExternal size={14} aria-hidden /></a>
          <p className="small">
            {problems.length ? <strong>Check before using it. </strong> : <strong>Built. </strong>}
            {pagesLine(latest.layout)}{latest.layout?.measured && latest.limit ? `, limit ${latest.limit}` : ''}{latest.layout?.measured ? '.' : ''}
          </p>
          {problems.length > 0 && <ul className="built-problems small">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      </div>
      {earlier.map((b) => (
        <div key={b.documentId} className="built-earlier">
          <p className="small">
            The earlier build, “{b.title}”, made {ago(b.at)}, is still in your Drive.
            {problems.length > 0 && ' The new one has things to check, so you may want to keep this one until they are fixed.'}
          </p>
          <BinButton
            doc={b}
            label="Move it to the bin…"
            onTrashed={() => { setBinned((x) => [...x, b.documentId]); onBinned() }}
            onError={setError}
          />
        </div>
      ))}
      {error && <p className="error small">{error}</p>}
    </>
  )
}
