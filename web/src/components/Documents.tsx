// Markdown to Google Docs by button: upload files or a folder, see the structure docu-ai would
// build, then build it. The same docu-ai tools the model calls in chat, with no model.
//
// docu-ai reads only a folder's top level, so that is all an upload sends; anything deeper or
// not markdown is listed as skipped, never uploaded to silently do nothing.

import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteUpload, getUploads, isMarkdown, splitDocs, uploadDocs, type UploadedDocs } from '../api'
import { ask, call } from '../call'
import { HBars } from '../charts/HBars'
import { toolColor } from '../charts/palette'
import { useAppState } from '../state'
import { CardHead } from '../ui/CardHead'
import { ConfirmDelete } from '../ui/ConfirmDelete'
import { DropZone } from '../ui/DropZone'
import { Empty } from '../ui/Empty'
import { IconCheck, IconChevron, IconDocuments, IconDownload, IconExternal, IconFolder, IconRefresh, IconTrash, IconUpload } from '../ui/icons'
import { ago } from '../ui/time'
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

function Batch({ docs, index, onDeleted }: { docs: UploadedDocs & { at: number }; index: number; onDeleted: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [title, setTitle] = useState('')
  // docu-ai's two looks. A CV is one page of one person, so the choice only exists for one file.
  const [theme, setTheme] = useState<'technical' | 'resume'>(/cv|resume|résumé/i.test(docs.name) ? 'resume' : 'technical')
  const [built, setBuilt] = useState<BuiltDoc | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')

  const remove = async () => {
    setRemoving(true)
    setRemoveError('')
    try {
      await deleteUpload('docs', docs.name)
      setAsking(false)
      onDeleted()
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(false)
    }
  }

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
      <div className="row batch-actions">
        <button className="ghost" disabled={busy !== ''} onClick={() => { setRemoveError(''); setAsking(true) }}>
          <IconTrash size={14} aria-hidden />Delete this upload
        </button>
      </div>
      {asking && (
        <ConfirmDelete
          title={`Delete “${docs.name}”?`}
          facts={[['Files', docs.files.join(', ')], ['Uploaded', ago(docs.at * 1000)]]}
          keeps="The markdown is removed from this computer. Google Docs already built from it are not touched."
          verb="Delete"
          busy={removing}
          error={removeError}
          onConfirm={() => void remove()}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  )
}

// ---- documents already built on Google Drive --------------------------------------------------------

interface DriveDoc {
  documentId: string
  title: string
  url: string
  createdTime: string
  modifiedTime: string
}

interface ExportResult {
  filename: string
  data: string
  size: number
}

function downloadBase64(data: string, filename: string, mime: string) {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: mime })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

function DriveDocRow({ doc, onTrashed }: { doc: DriveDoc; onTrashed: () => void }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // What docu-ai says it is about to trash (its own `info`, as the gate shows in chat); null while not asking.
  const [preview, setPreview] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [trashError, setTrashError] = useState('')

  const trash = async (confirmed: boolean) => {
    setBusy('trash')
    setTrashError('')
    setError('')
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
      const message = e instanceof Error ? e.message : String(e)
      if (asking) setTrashError(message)
      else setError(message)
    } finally {
      setBusy('')
    }
  }

  const download = async (format: 'pdf' | 'docx') => {
    setBusy(format)
    setError('')
    try {
      const result = await call<ExportResult>('docu_ai__export', { documentId: doc.documentId, format })
      const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      downloadBase64(result.data, result.filename, mime)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <li className="drive-doc">
      <div className="drive-doc-main">
        <a href={doc.url} target="_blank" rel="noreferrer" className="drive-doc-title">
          {doc.title}
          <IconExternal size={13} aria-hidden />
        </a>
        <span className="muted small" title={new Date(doc.modifiedTime).toLocaleString()}>
          {ago(doc.modifiedTime)}
        </span>
      </div>
      <div className="drive-doc-actions">
        <button disabled={busy !== ''} onClick={() => void download('pdf')}>
          <IconDownload size={14} aria-hidden />
          {busy === 'pdf' ? 'Exporting…' : 'PDF'}
        </button>
        <button disabled={busy !== ''} onClick={() => void download('docx')}>
          <IconDownload size={14} aria-hidden />
          {busy === 'docx' ? 'Exporting…' : 'DOCX'}
        </button>
        <button className="ghost" disabled={busy !== ''} onClick={() => void trash(false)} aria-label={`Move “${doc.title}” to the bin`}>
          <IconTrash size={14} aria-hidden />
          {busy === 'trash' && !asking ? 'Checking…' : 'Bin'}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      {asking && (
        <ConfirmDelete
          title={`Move “${doc.title}” to the bin?`}
          keeps="It stays in Google Drive's Trash for 30 days, where you can restore it from Drive."
          verb="Move to bin"
          busy={busy === 'trash'}
          error={trashError}
          onConfirm={() => void trash(true)}
          onCancel={() => setAsking(false)}
        >
          {preview && <pre className="confirm-preview">{preview}</pre>}
        </ConfirmDelete>
      )}
    </li>
  )
}

interface ListPage {
  documents: DriveDoc[]
  nextPageToken?: string
}

const PAGE_SIZE = 10

function DriveDocuments() {
  const { tools } = useAppState()
  const hasList = tools.has('docu_ai__list')
  const [page, setPage] = useState<ListPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tokenStack, setTokenStack] = useState<string[]>([])
  const mountRef = useRef(true)
  useEffect(() => () => { mountRef.current = false }, [])

  const load = useCallback(async (pageToken?: string) => {
    setLoading(true)
    setError('')
    try {
      const result = await call<ListPage>('docu_ai__list', { limit: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) })
      if (mountRef.current) setPage(result)
    } catch (e) {
      if (mountRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mountRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (hasList) void load()
  }, [hasList, load])

  if (!hasList) return null

  const pageNum = tokenStack.length + 1
  const hasNext = !!page?.nextPageToken
  const hasPrev = tokenStack.length > 0

  const goNext = () => {
    if (!page?.nextPageToken) return
    setTokenStack((s) => [...s, page.nextPageToken!])
    void load(page.nextPageToken)
  }

  const goPrev = () => {
    if (tokenStack.length === 0) return
    const prev = [...tokenStack]
    prev.pop()
    const token = prev[prev.length - 1]
    setTokenStack(prev)
    void load(token)
  }

  return (
    <section className="card" aria-label="Documents on Google Drive">
      <CardHead icon={IconDocuments} tool="docu-ai" title="Your documents" sub="CVs, cover letters and other documents built by docu-ai, on your Google Drive.">
        <button disabled={loading} onClick={() => { setTokenStack([]); void load() }}>
          <IconRefresh size={16} aria-hidden />
          Refresh
        </button>
      </CardHead>

      {page === null && !error ? (
        <div aria-busy="true">
          <ul className="drive-list">
            {Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="drive-doc">
                <div className="drive-doc-main"><span className="skeleton" style={{ width: '60%', height: 18 }} /><span className="skeleton" style={{ width: 50, height: 14 }} /></div>
              </li>
            ))}
          </ul>
        </div>
      ) : page && page.documents.length === 0 && tokenStack.length === 0 ? (
        <Empty icon={IconDocuments} title="No documents yet">
          Build a markdown file into a Google Doc and it will appear here.
        </Empty>
      ) : (
        <>
          <ul className="drive-list stagger">
            {(page?.documents ?? []).map((d) => (
              <DriveDocRow key={d.documentId} doc={d} onTrashed={() => void load(tokenStack[tokenStack.length - 1])} />
            ))}
          </ul>
          {(hasPrev || hasNext) && (
            <nav className="drive-pager" aria-label="Document pages">
              <button disabled={!hasPrev || loading} onClick={goPrev} aria-label="Previous page">
                <IconChevron size={16} style={{ transform: 'rotate(180deg)' }} aria-hidden />
                Prev
              </button>
              <span className="muted small">Page {pageNum}</span>
              <button disabled={!hasNext || loading} onClick={goNext} aria-label="Next page">
                Next
                <IconChevron size={16} aria-hidden />
              </button>
            </nav>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
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
          {batches.map((d, i) => <Batch key={d.path} docs={d} index={i} onDeleted={() => void uploads.reload()} />)}
        </div>
      ) : (
        <div className="card">
          <Empty icon={IconDocuments} title="Nothing uploaded yet">Markdown you upload appears here, ready to preview and build into a formatted Google Doc.</Empty>
        </div>
      )}
      <DriveDocuments />

      {uploads.error && <p className="error">{uploads.error}</p>}
    </div>
  )
}
