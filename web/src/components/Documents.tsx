// Markdown to Google Docs by button: upload files or a folder, see the structure docu-ai
// would build, then build it. The same docu-ai tools the model calls in chat, with no model.
//
// docu-ai reads only a folder's top level, so that is all an upload sends; anything deeper or
// not markdown is listed as skipped, never uploaded to silently do nothing.

import { useState } from 'react'
import { getUploads, splitDocs, uploadDocs, type UploadedDocs } from '../api'
import { usePoll } from '../usePoll'
import { call } from './Meetings'
import { PickFiles, UploadProgress } from './Upload'

interface Preview {
  single: boolean
  chapters: { title: string; file: string; blocks: Record<string, number> }[]
}

interface BuiltDoc {
  url: string
  title: string
  residue: string[]
}

function Batch({ docs }: { docs: UploadedDocs }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [title, setTitle] = useState('')
  // docu-ai's two looks. A CV is one page of one person, so the choice only exists for one file.
  const [theme, setTheme] = useState<'technical' | 'resume'>(/cv|resume|résumé/i.test(docs.name) ? 'resume' : 'technical')
  const [built, setBuilt] = useState<BuiltDoc | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const run = async (what: string, work: () => Promise<void>) => {
    setBusy(what)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const single = docs.files.length === 1
  return (
    <li>
      <div className="list-main">
        <strong>{docs.name}</strong>
        <span className="muted">{single ? '1 file · one tab, no cover' : `${docs.files.length} files · a tab each, with a contents page`}</span>
      </div>
      {preview && (
        <ol className="chapters">
          {preview.chapters.map((c) => (
            <li key={c.file}>
              {c.title} <span className="muted small">— {c.file}{Object.entries(c.blocks).map(([k, n]) => ` · ${n} ${k}`).join('')}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="row">
        <button disabled={busy !== ''} onClick={() => void run('preview', async () => setPreview(await call<Preview>('docu_ai__preview', { path: docs.path })))}>
          {busy === 'preview' ? 'Reading…' : 'Preview'}
        </button>
        {!single && (
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Title (default: ${docs.name})`} aria-label="Document title" />
        )}
        {single && (
          <label className="check">
            Style
            <select value={theme} onChange={(e) => setTheme(e.target.value as 'technical' | 'resume')} aria-label="Style">
              <option value="technical">Document</option>
              <option value="resume">CV / résumé</option>
            </select>
          </label>
        )}
        <button
          className="primary"
          disabled={busy !== ''}
          onClick={() => void run('build', async () =>
            setBuilt(await call<BuiltDoc>('docu_ai__build', {
              path: docs.path,
              ...(title.trim() ? { title: title.trim() } : {}),
              ...(single ? { theme } : {}),
            })))}
        >
          {busy === 'build' ? 'Building the Doc…' : built ? 'Build again' : 'Make a Google Doc'}
        </button>
      </div>
      {built && (
        <p className="result">
          <a href={built.url} target="_blank" rel="noreferrer">Open “{built.title}” in Google Docs</a>
          {built.residue.length > 0 && <span className="warn"> · markdown residue: {built.residue.join('; ')}</span>}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  )
}

export function Documents() {
  const uploads = usePoll(getUploads, 30000)
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  const [error, setError] = useState('')

  const upload = async (picked: File[]) => {
    const { top, skipped: left, name } = splitDocs(picked)
    setSkipped(left)
    setError('')
    if (top.length === 0) {
      setError('Nothing to upload: docu-ai builds from the markdown (.md) files at the top of a folder.')
      return
    }
    setUploading({ name, fraction: 0 })
    try {
      await uploadDocs(top, name, (fraction) => setUploading({ name, fraction }))
      await uploads.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(null)
    }
  }

  const batches = uploads.data?.docs ?? []
  return (
    <div className="panel">
      <div className="card">
        <h2>Documents</h2>
        <p className="muted">
          Turn markdown into a formatted Google Doc. One file becomes one tab; a folder becomes a tab per file, in
          filename order (or the order its <code>SUMMARY.md</code> gives), with a clickable contents page.
        </p>
        <div className="row">
          <PickFiles label="Upload .md files…" accept=".md,text/markdown" multiple disabled={uploading !== null} onPick={(f) => void upload(f)} className="primary" />
          <PickFiles label="Upload a folder…" folder disabled={uploading !== null} onPick={(f) => void upload(f)} />
        </div>
        {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
        {skipped.length > 0 && (
          <p className="muted small">Not uploaded — docu-ai would not use them: {skipped.join(', ')}</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      {batches.length > 0 && (
        <div className="card">
          <h2>Uploaded</h2>
          <ul className="list">
            {batches.map((d) => <Batch key={d.path} docs={d} />)}
          </ul>
        </div>
      )}
      {uploads.error && <p className="error">{uploads.error}</p>}
    </div>
  )
}
