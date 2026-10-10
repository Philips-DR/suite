// Markdown to Google Docs by button: upload files or a folder, see the structure docu-ai would
// build, then build it. The same docu-ai tools the model calls in chat, with no model.
//
// docu-ai reads only a folder's top level, so that is all an upload sends; anything deeper or
// not markdown is listed as skipped, never uploaded to silently do nothing.

import { useState } from 'react'
import { getUploads, isMarkdown, splitDocs, uploadDocs, type UploadedDocs } from '../api'
import { call } from '../call'
import { HBars } from '../charts/HBars'
import { toolColor } from '../charts/palette'
import { CardHead } from '../ui/CardHead'
import { DropZone } from '../ui/DropZone'
import { Empty } from '../ui/Empty'
import { IconCheck, IconDocuments, IconExternal, IconFolder, IconUpload } from '../ui/icons'
import { usePoll } from '../usePoll'
import { PickFiles, UploadProgress } from './Upload'
import '../styles/panels/documents.css'

interface Preview {
  single: boolean
  chapters: { title: string; file: string; blocks: Record<string, number> }[]
}

interface BuiltDoc {
  url: string
  title: string
  residue: string[]
}

const blockCount = (blocks: Record<string, number>) => Object.values(blocks).reduce((n, v) => n + v, 0)

function Batch({ docs, index }: { docs: UploadedDocs; index: number }) {
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
    <div className="card batch" style={{ '--i': index } as React.CSSProperties}>
      <CardHead icon={IconDocuments} tool="docu-ai" title={docs.name} sub={single ? '1 file · one tab, no cover' : `${docs.files.length} files · a tab each, with a contents page`}>
        <button disabled={busy !== ''} onClick={() => void run('preview', async () => setPreview(await call<Preview>('docu_ai__preview', { path: docs.path })))}>
          {busy === 'preview' ? 'Reading…' : preview ? 'Refresh preview' : 'Preview'}
        </button>
      </CardHead>

      {preview && (
        <div className="batch-preview">
          <h3>What will be built</h3>
          {preview.chapters.length > 1 ? (
            <HBars
              label="Blocks per tab"
              color={toolColor('docu-ai')}
              items={preview.chapters.map((c) => ({
                key: c.file,
                label: c.title,
                value: blockCount(c.blocks),
                display: `${blockCount(c.blocks)}`,
                sub: `${c.file}: ${Object.entries(c.blocks).map(([k, n]) => `${n} ${k}`).join(', ')}`,
              }))}
            />
          ) : (
            <ul className="chips">
              {preview.chapters[0] && Object.entries(preview.chapters[0].blocks).map(([kind, n]) => <li key={kind} className="badge">{n} {kind}</li>)}
            </ul>
          )}
          <p className="hint">Each tab is named for its first heading. Bars count the paragraphs, headings, lists, tables and code blocks in it.</p>
        </div>
      )}

      <div className="row batch-actions">
        {!single && <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Title (default: ${docs.name})`} aria-label="Document title" />}
        {single && (
          <div className="seg" role="radiogroup" aria-label="Style">
            <button role="radio" aria-checked={theme === 'technical'} onClick={() => setTheme('technical')}>Document</button>
            <button role="radio" aria-checked={theme === 'resume'} onClick={() => setTheme('resume')}>CV / résumé</button>
          </div>
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
          <IconDocuments size={16} aria-hidden />{busy === 'build' ? 'Building the Doc…' : built ? 'Build again' : 'Make a Google Doc'}
        </button>
      </div>

      {built && (
        <div className="built">
          <span className="built-icon"><IconCheck size={16} strokeWidth={2.8} aria-hidden /></span>
          <div>
            <a href={built.url} target="_blank" rel="noreferrer">Open “{built.title}” in Google Docs <IconExternal size={14} aria-hidden /></a>
            {built.residue.length > 0 && <p className="warn small">Markdown residue: {built.residue.join('; ')}</p>}
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
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
      <DropZone
        accepts={(f) => isMarkdown(f.name)}
        label="Drop markdown to upload"
        onRefuse={(names) => setError(`Not uploaded — docu-ai builds from markdown (.md): ${names.join(', ')}`)}
        onFiles={(files) => void upload(files)}
        disabled={uploading !== null}
      >
        <div className="card">
          <CardHead icon={IconDocuments} tool="docu-ai" title="Make a Google Doc" sub="One file becomes one tab. A folder becomes a tab per file, in filename order (or the order its SUMMARY.md gives), with a clickable contents page." />
          <div className="dropbox">
            <span className="dropbox-icon"><IconUpload size={26} strokeWidth={1.6} aria-hidden /></span>
            <strong>Drop markdown files here</strong>
            <span className="muted small">or choose them</span>
            <div className="row center">
              <PickFiles label="Upload .md files…" icon={<IconUpload size={16} aria-hidden />} accept=".md,text/markdown" multiple disabled={uploading !== null} onPick={(f) => void upload(f)} className="primary" />
              <PickFiles label="Upload a folder…" icon={<IconFolder size={16} aria-hidden />} folder disabled={uploading !== null} onPick={(f) => void upload(f)} />
            </div>
          </div>
          {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
          {skipped.length > 0 && <p className="muted small">Not uploaded, because docu-ai would not use them: {skipped.join(', ')}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      </DropZone>

      {batches.length > 0 ? (
        <div className="stagger panel">
          <h2 className="section-title">Ready to build</h2>
          {batches.map((d, i) => <Batch key={d.path} docs={d} index={i} />)}
        </div>
      ) : (
        <div className="card">
          <Empty icon={IconDocuments} title="Nothing uploaded yet">Markdown you upload appears here, ready to preview and build into a formatted Google Doc.</Empty>
        </div>
      )}
      {uploads.error && <p className="error">{uploads.error}</p>}
    </div>
  )
}
