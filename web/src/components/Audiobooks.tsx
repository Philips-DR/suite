// Audiobooks by button: read a PDF, check what will be spoken, pick a voice, render, listen.
// The same audiobook tools the model calls in chat, called directly -- no model.
//
// Reading a book, rendering it and cloning a voice are all background jobs in the tool, one at a
// time, and `job_status` is the one place their progress lives. A render is hours; this page can
// be closed and reopened and the job is still there.
//
// The look: the chapters are a bar chart that is also the chooser (a bar per chapter, sized by its
// words, labelled with its speech time; click one to leave it out of the render). Everything on the
// page is drawn from what the tool returned; nothing is estimated here except the selection's
// speech and render time, which is the tool's own per-chapter figures added up (and says so).

import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { AUDIO_EXTS, deleteUpload, fetchMedia, getUploads, isAudio, uploadBook, uploadVoice, type Uploads } from '../api'
import { ChartCard } from '../charts/ChartCard'
import { HBars } from '../charts/HBars'
import { toolColor } from '../charts/palette'
import { Ring } from '../charts/Ring'
import { useCountUp } from '../charts/useWidth'
import { ask, call } from '../call'
import { CardHead } from '../ui/CardHead'
import { usePlayer, usePlayerActions } from '../player/engine'
import { AudioPlayer } from '../ui/AudioPlayer'
import { ConfirmDelete, sizeOf } from '../ui/ConfirmDelete'
import { DropZone } from '../ui/DropZone'
import {
  IconAlert, IconAudiobooks, IconCheck, IconClose, IconDocuments, IconDownload, IconFail, IconMeetings,
  IconOk, IconPlay, IconRefresh, IconSpark, IconStop, IconTrash, IconUpload, IconZap,
} from '../ui/icons'
import { fileName, usePoll } from '../usePoll'
import { PickFiles, UploadProgress } from './Upload'
import '../styles/panels/audiobooks.css'

type IconType = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean; className?: string }>

interface Voice {
  name: string
  kind: 'cloned' | 'preset'
  source?: string | null
  similarity?: number | null
  consent?: string | null
}

interface BookJob {
  id: string
  kind: 'analyse' | 'render' | 'voice' | 'sample'
  target: string
  state: 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled'
  phase: string
  percent: number | null
  chapter: number | null
  chapter_title: string | null
  chunks_done: number | null
  chunks_total: number | null
  eta: string | null
  outputs: string[]
  detail: string
}

interface Chapter {
  number: number
  label: string
  appendix: boolean
  words: number
  speech: string
}

interface Overview {
  pdf?: string
  analysed: boolean
  hint?: string
  title?: string
  author?: string | null
  chapters?: Chapter[]
  speech?: string
  render_time?: string
  citations_removed?: number
  skipped?: Record<string, number>
}

interface ChapterText {
  segments: { kind: string; text: string }[]
  truncated: boolean
  next_start: number | null
  announce: string
}

interface AudioBook {
  book: string
  files: { name: string; path: string; megabytes: number; modified: number }[]
}

const KIND_LABEL: Record<BookJob['kind'], string> = {
  analyse: 'Reading the book',
  render: 'Rendering',
  voice: 'Cloning a voice',
  sample: 'Speaking a sample',
}

/** What each job state looks like: an icon, a word and a tone. Status colour is never alone. */
const STATE: Record<BookJob['state'], { icon: IconType; tone: 'run' | 'ok' | 'bad' | 'warn' }> = {
  running: { icon: IconRefresh, tone: 'run' },
  done: { icon: IconOk, tone: 'ok' },
  failed: { icon: IconFail, tone: 'bad' },
  interrupted: { icon: IconAlert, tone: 'warn' },
  cancelled: { icon: IconStop, tone: 'warn' },
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isPdf = (file: File) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
const stem = (path: string) => fileName(path).replace(/\.pdf$/i, '')
const style = (vars: Record<string, string | number>) => vars as CSSProperties

/** [1, 2, 3, 5] → "1-3,5": the form start_render takes. */
function toSelection(numbers: number[]): string {
  const parts: string[] = []
  for (let i = 0; i < numbers.length; i++) {
    let j = i
    while (numbers[j + 1] === numbers[j]! + 1) j++
    parts.push(j > i ? `${numbers[i]}-${numbers[j]}` : `${numbers[i]}`)
    i = j
  }
  return parts.join(',')
}

// ---- the tool's own durations ("2 min", "1 h 18 min") ------------------------------------------------
// The tool writes every duration the same way, so parsing is exact; anything that does not match is
// shown as the tool wrote it and never computed with.

const DURATION = /^(?:(\d+) h )?(\d+) min$/

function parseMinutes(text: string | undefined): number | null {
  const m = DURATION.exec((text ?? '').trim())
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null
}

function formatMinutes(total: number): string {
  const m = Math.round(total)
  if (m <= 0) return '0 min'
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/**
 * Speech and render time for the chapters picked. All picked: the tool's own totals. Some picked:
 * the per-chapter figures added up, and only when they agree with the tool's total to within
 * their own rounding (each is rounded to the minute); otherwise nothing is claimed.
 */
function selectionTimes(data: Overview, chosen: Set<number>): { speech: string | null; render: string | null; approx: boolean } {
  const chapters = data.chapters ?? []
  if (chosen.size === chapters.length) return { speech: data.speech ?? null, render: data.render_time ?? null, approx: false }
  const mins = chapters.map((c) => parseMinutes(c.speech))
  const totalSpeech = parseMinutes(data.speech)
  const totalRender = parseMinutes(data.render_time)
  if (mins.some((m) => m === null) || !totalSpeech || totalRender === null) return { speech: null, render: null, approx: true }
  const all = mins.reduce<number>((n, m) => n + (m ?? 0), 0)
  if (Math.abs(all - totalSpeech) > Math.max(2, totalSpeech * 0.05)) return { speech: null, render: null, approx: true }
  const mine = chapters.reduce((n, c, i) => (chosen.has(c.number) ? n + (mins[i] ?? 0) : n), 0)
  return { speech: formatMinutes(mine), render: formatMinutes((mine * totalRender) / totalSpeech), approx: true }
}

/** "4 h 02 min" as big digits with small units; a string the tool wrote any other way is shown as written. */
function Duration({ text }: { text: string | null | undefined }) {
  if (!text) return <>—</>
  const m = DURATION.exec(text.trim())
  if (!m) return <>{text}</>
  return <>{m[1] !== undefined && <>{m[1]}<small>h</small> </>}{m[2]}<small>min</small></>
}

/** A scrolling list that fades at its foot while there is more below, so a long book is seen to be long. */
function Scroller({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const node = box.current
    if (!node) return
    const check = () => setMore(node.scrollHeight - node.scrollTop - node.clientHeight > 4)
    check()
    node.addEventListener('scroll', check, { passive: true })
    const watch = new ResizeObserver(check)
    watch.observe(node)
    if (node.firstElementChild) watch.observe(node.firstElementChild)
    return () => { node.removeEventListener('scroll', check); watch.disconnect() }
  }, [])
  return <div ref={box} className={`ab-chart-scroll ${more ? 'more' : ''}`}>{children}</div>
}

// ---- a figure: one number about the book -------------------------------------------------------------

function Fig({ label, count, suffix, children, foot, index }: {
  label: string
  count?: number
  suffix?: string
  children?: ReactNode
  foot?: ReactNode
  index: number
}) {
  const shown = useCountUp(count ?? 0, 450)
  return (
    <div className="card stat ab-stat" style={style({ '--i': index })}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {count !== undefined ? Math.round(shown).toLocaleString() : children}
        {suffix && <small>{suffix}</small>}
      </span>
      <span className="stat-delta ab-stat-foot">{foot}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Play or download a file a tool made. Fetched with the token and handed to the one player that lives
 *  above the pages (player/engine.tsx), so what you start here keeps playing when you leave this page. */
function AudioFile({ path, size }: { path: string; size?: number }) {
  const { track, playing: audible } = usePlayer()
  const { open, close } = usePlayerActions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const here = useRef(true)
  useEffect(() => { here.current = true; return () => { here.current = false } }, [])

  const current = track?.key === path
  const playing = current && audible

  const play = async () => {
    setBusy(true)
    setError('')
    try {
      const blob = await fetchMedia(path)
      // Left the page while it downloaded: nothing should start talking from somewhere you are not looking.
      if (here.current) open({ key: path, title: fileName(path), blob })
    } catch (e) {
      if (here.current) setError(message(e))
    } finally {
      if (here.current) setBusy(false)
    }
  }

  const download = async () => {
    setError('')
    try {
      const href = URL.createObjectURL(await fetchMedia(path))
      const link = document.createElement('a')
      link.href = href
      link.download = fileName(path)
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
    } catch (e) {
      setError(message(e))
    }
  }

  const kind = (fileName(path).split('.').pop() ?? '').toUpperCase()
  return (
    <div className={`ab-file ${current ? 'loaded' : ''} ${playing ? 'playing' : ''}`}>
      <div className="ab-file-row">
        <span className="ab-file-tile" aria-hidden>
          {playing ? <span className="ab-eq"><i /><i /><i /></span> : <IconAudiobooks size={17} strokeWidth={2} />}
        </span>
        <span className="ab-file-name">
          <span className="ab-file-title">{fileName(path)}</span>
          <span className="muted small">
            {playing && <b className="ab-now">Playing · </b>}
            {size != null && `${size} MB`}{size != null && kind && ' · '}{kind}
          </span>
        </span>
        <span className="ab-file-act">
          {!current && (
            <button className="ab-play" disabled={busy} aria-busy={busy} onClick={() => void play()}>
              {busy ? <IconRefresh size={16} aria-hidden className="ab-spin" /> : <IconPlay size={16} aria-hidden />}
              <span className="ab-btn-label">{busy ? 'Loading…' : 'Play'}</span>
            </button>
          )}
          <button onClick={() => void download()}><IconDownload size={16} aria-hidden /><span className="ab-btn-label">Download</span></button>
        </span>
      </div>
      {current && <AudioPlayer onClose={close} />}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function JobCard({ job, reload }: { job: BookJob | null; reload: () => Promise<void> }) {
  // Stopping a render is a click, then a second one: it is hours of work being set down, even though
  // every sentence already spoken is kept.
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  if (!job) return null
  const running = job.state === 'running'
  const { icon: StateIcon, tone } = STATE[job.state]

  const cancel = async () => {
    setStopping(true)
    setError('')
    try {
      await call('audiobook__cancel_job', { job_id: job.id })
      setAsking(false)
      await reload()
    } catch (e) {
      setError(message(e))
    } finally {
      setStopping(false)
    }
  }

  const facts = [
    job.chapter != null ? `Chapter ${job.chapter}: ${job.chapter_title}` : null,
    job.chapter != null && job.chunks_done != null && job.chunks_total != null ? `${job.chunks_done}/${job.chunks_total}` : null,
    job.percent != null ? `${job.percent.toFixed(0)}%` : job.phase,
    job.eta ? `about ${job.eta} left` : null,
  ].filter((f): f is string => f !== null)

  return (
    <div className={`card job job-${job.state} ab-job`}>
      <div className="ab-job-top">
        {running ? (
          <Ring value={job.percent} size={60} label="Progress">{job.percent !== null ? `${Math.round(job.percent)}%` : ''}</Ring>
        ) : (
          <span className={`ab-state ab-tone-${tone}`}><StateIcon size={22} strokeWidth={2} aria-hidden /></span>
        )}
        <div className="ab-job-title">
          <strong>{KIND_LABEL[job.kind]}: {fileName(job.target)}</strong>
          {running && <span className="ab-facts muted small">{facts.map((f) => <span key={f}>{f}</span>)}</span>}
        </div>
        <span className={`ab-job-act ${running ? 'with-cancel' : ''}`}>
          <span className={`badge ${tone === 'bad' ? 'bad' : ''}`}>
            <StateIcon size={13} strokeWidth={2.4} aria-hidden className={running ? 'ab-spin' : undefined} />
            {running ? job.phase : job.state}
          </span>
          {running && !asking && <button onClick={() => setAsking(true)}><IconStop size={14} aria-hidden />Cancel</button>}
        </span>
      </div>
      {running && asking && (
        <div className="warn-box ab-confirm">
          <p>
            Stop this {job.kind === 'render' ? 'render' : 'job'}?
            {job.kind === 'render' ? ' Everything already spoken is kept, so starting it again carries on.' : ' It will start over if run again.'}
          </p>
          <div className="row">
            <button className="danger" disabled={stopping} onClick={() => void cancel()}>{stopping ? 'Stopping…' : 'Yes, stop it'}</button>
            <button disabled={stopping} onClick={() => setAsking(false)}>Keep going</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {running && (
        <>
          <div className="bar ab-bar" role="progressbar" aria-label="Progress" aria-valuenow={job.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${job.percent ?? 0}%` }} />
          </div>
          {job.kind === 'analyse' && (
            <p className="hint">About 2–4 seconds a page, so minutes for a book; a scan is read with OCR and is much slower.</p>
          )}
          {job.kind === 'render' && (
            <p className="hint">One chapter at a time; each is playable under Finished audio as it completes. You can close this page.</p>
          )}
        </>
      )}
      {job.state === 'done' && job.kind === 'sample' && job.outputs.map((o) => <AudioFile key={o} path={o} />)}
      {job.state === 'done' && job.kind === 'render' && (
        <p className="ab-done muted">
          {job.outputs.length} file{job.outputs.length === 1 ? '' : 's'} made — see Finished audio below.{' '}
          <button className="ghost ab-jump" onClick={() => document.getElementById('ab-finished')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Go there</button>
        </p>
      )}
      {job.state === 'done' && job.kind === 'voice' && <p className="ab-done muted">The voice is ready. Hear a sample before using it.</p>}
      {(job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled') && (
        <p className={`ab-detail ab-tone-${tone}`}><StateIcon size={16} aria-hidden /><span>{job.detail}</span></p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface UploadsPoll { data: Uploads | null; error: string; reload: () => Promise<void> }

/** Delete one audiobook: its finished audio and, when it came from an upload, the uploaded PDF. What goes is
 * read first with the tool that only reads, so the question names it; the delete tool is called only on a
 * confirmed press, never to find out what it would do. */
function DeleteBook({ book, upload, onCancel, onChanged, onDone }: {
  book: string
  upload: { name: string; bytes: number } | null
  onCancel: () => void
  onChanged: () => void
  onDone: () => void
}) {
  const [summary, setSummary] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    call<{ summary: string }>('audiobook__describe_audiobook', { book }).then(
      (r) => { if (live) setSummary(r.summary) },
      (e) => { if (live) setError(message(e)) },
    )
    return () => { live = false }
  }, [book])

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await ask('audiobook__delete_audiobook', { book }, true)
    } catch (e) {
      setError(message(e))
      setBusy(false)
      return
    }
    // The audio is gone from here on, whatever happens to the PDF.
    onChanged()
    if (upload) {
      try {
        await deleteUpload('book', upload.name)
      } catch (e) {
        setError(`The audio is deleted, but the PDF could not be: ${message(e)}`)
        setBusy(false)
        onChanged()
        return
      }
      onChanged()
    }
    setBusy(false)
    onDone()
  }

  return (
    <ConfirmDelete
      title={`Delete “${book}”?`}
      facts={upload ? [['Uploaded PDF', `${upload.name} (${sizeOf(upload.bytes)})`]] : undefined}
      keeps={upload ? 'The uploaded PDF goes too.' : 'The PDF is not an upload, so it stays where it is.'}
      verb={summary === null && !error ? 'Checking…' : 'Delete'}
      ready={summary !== null}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
    >
      {summary !== null && <pre className="confirm-preview">{summary}</pre>}
    </ConfirmDelete>
  )
}

function Library({ book, setBook, uploads, onDelete }: { book: string; setBook: (path: string) => void; uploads: UploadsPoll; onDelete: (book: string) => void }) {
  const [typed, setTyped] = useState(book)
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const [error, setError] = useState('')

  const upload = async ([file]: File[]) => {
    if (!file) return
    setError('')
    setUploading({ name: file.name, fraction: 0 })
    try {
      const saved = await uploadBook(file, (fraction) => setUploading({ name: file.name, fraction }))
      setTyped(saved.path)
      setBook(saved.path)
      await uploads.reload()
    } catch (e) {
      setError(message(e))
    } finally {
      setUploading(null)
    }
  }

  const open = (path: string) => { setTyped(path); setBook(path) }
  useEffect(() => { if (!book) setTyped('') }, [book])
  const mine = uploads.data?.books ?? []
  const picked = mine.find((b) => b.path === book)

  return (
    <DropZone
      accepts={isPdf}
      label="Drop a PDF to upload"
      onRefuse={(names) => setError(`Not uploaded — an audiobook is made from a PDF (.pdf): ${names.join(', ')}`)}
      onFiles={(files) => void upload(files)}
      disabled={uploading !== null}
    >
      <div className="card ab-library">
        <CardHead
          icon={IconAudiobooks}
          tool="audiobook"
          title="Open a book"
          sub="Turn a PDF into an audiobook, read in a voice cloned from a short recording. Everything runs on this computer."
        />
        <div className="ab-open">
          <div className="stack">
            <div className="row">
              <input
                list="book-files"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim()) setBook(typed.trim()) }}
                placeholder="A PDF — pick an uploaded one, or paste a path"
                aria-label="PDF"
              />
              <datalist id="book-files">
                {uploads.data?.books.map((b) => <option key={b.path} value={b.path}>{b.name}</option>)}
              </datalist>
              <button className="ab-open-go" disabled={!typed.trim() || typed.trim() === book} onClick={() => setBook(typed.trim())}>Open</button>
            </div>
            {mine.length > 0 && (
              <div className="ab-books">
                <span className="muted small">Uploaded</span>
                <ul className="ab-chips">
                  {mine.map((b) => (
                    <li key={b.path}>
                      <button className="ab-chip" aria-pressed={b.path === book} title={b.path} onClick={() => open(b.path)}>
                        <IconDocuments size={14} aria-hidden />{b.name}
                      </button>
                    </li>
                  ))}
                </ul>
                {picked && (
                  <button className="ghost ab-delete" onClick={() => onDelete(stem(picked.name))}>
                    <IconTrash size={14} aria-hidden />Delete “{picked.name}” and its audio…
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="ab-drop">
            <span className="ab-drop-icon"><IconUpload size={20} strokeWidth={1.8} aria-hidden /></span>
            <span className="ab-drop-text"><strong>Drop a PDF here</strong><span className="muted small">or choose one from this device</span></span>
            <PickFiles label="Upload a PDF…" icon={<IconUpload size={16} aria-hidden />} accept=".pdf,application/pdf" className="primary" disabled={uploading !== null} onPick={(f) => void upload(f)} />
          </div>
        </div>
        {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
        {(error || uploads.error) && <p className="error">{error || uploads.error}</p>}
      </div>
    </DropZone>
  )
}

// ---------------------------------------------------------------------------

function Corrections({ pdf, onSaved }: { pdf: string; onSaved: () => void }) {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    call<{ text: string }>('audiobook__get_corrections', { pdf })
      .then((r) => { setText(r.text); setLoaded(true) })
      .catch((e) => setError(message(e)))
  }, [pdf])

  const save = async () => {
    setError('')
    setNote('')
    try {
      const r = await call<{ pairs: number; ignored: string[] }>('audiobook__set_corrections', { pdf, text })
      setNote(`Saved ${r.pairs} correction${r.pairs === 1 ? '' : 's'}.` +
        (r.ignored.length ? ` Not applied — nothing to find, or no “=>” in: ${r.ignored.join(' · ')}` : ''))
      onSaved()
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <div className="card ab-corrections">
      <CardHead icon={IconSpark} tool="audiobook" title="Corrections" sub="Fix a typo or a name before it is spoken." />
      <p className="hint">
        One per line, <code>find =&gt; replace</code>: for typos in the source, or a name the voice cannot say. Applied to what
        is spoken; only the sentences that change are re-read.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        disabled={!loaded}
        placeholder={'Procedural Graph => PG\ncolour => color'}
        style={{ width: '100%' }}
        aria-label="Corrections"
        spellCheck={false}
      />
      <div className="row">
        <button disabled={!loaded} onClick={() => void save()}>Save corrections</button>
        {note && <span className="ab-note" role="status"><IconCheck size={14} strokeWidth={2.6} aria-hidden /><span>{note}</span></span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function Reader({ pdf, chapter, onClose }: { pdf: string; chapter: Chapter; onClose: () => void }) {
  const [text, setText] = useState<ChapterText | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (start: number) => {
    setBusy(true)
    setError('')
    try {
      const more = await call<ChapterText>('audiobook__read_chapter', { pdf, chapter: chapter.number, start })
      setText((old) => (old && start > 0 ? { ...more, segments: [...old.segments, ...more.segments] } : more))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void load(0) }, [pdf, chapter.number])

  return (
    <div className="card ab-reader">
      <CardHead icon={IconDocuments} tool="audiobook" title={`What will be read — ${chapter.label}`} sub={`The exact text the narrator will speak · ${chapter.words.toLocaleString()} words`}>
        <button className="ghost" onClick={onClose}><IconClose size={16} aria-hidden />Hide</button>
      </CardHead>
      <div className="reader">
        {text && (
          <div className="reader-text">
            <p className="muted small">Announced as: “{text.announce}”</p>
            {text.segments.map((s, i) => s.kind === 'heading' || s.kind === 'title'
              ? <p key={i}><strong>{s.text}</strong></p>
              : <p key={i}>{s.kind === 'list_item' ? '• ' : ''}{s.text}</p>)}
          </div>
        )}
        {text?.truncated && (
          <div className="row"><button disabled={busy} onClick={() => void load(text.next_start ?? 0)}>Show more</button></div>
        )}
        {busy && !text && (
          <>
            <p className="muted">Reading…</p>
            <div className="skeleton ab-skel" aria-hidden />
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}

function Book({ pdf, voices, job, reloadJob }: {
  pdf: string
  voices: Voice[]
  job: BookJob | null
  reloadJob: () => Promise<void>
}) {
  // Planning a long book from its cache takes a moment, so this is not polled: it is read when the
  // book is opened and again when a job on it finishes.
  const overview = usePoll(() => call<Overview>('audiobook__preview_book', { pdf }), 3_600_000)
  const [picked, setPicked] = useState<Set<number> | null>(null)
  const [reading, setReading] = useState<number | null>(null)
  // Bumped when corrections are saved, so the open chapter's text is read again with them applied.
  const [version, setVersion] = useState(0)
  const [voice, setVoice] = useState('')
  const [speed, setSpeed] = useState(0.95)
  const [m4b, setM4b] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const running = job?.state === 'running'
  const data = overview.data

  // A job names the path as the tool resolved it, which is not always what was typed (~, a relative
  // path, a link): compare against the tool's own spelling. And only a read this page saw running
  // counts as news -- one that finished before the book was opened is already in what was just loaded.
  const mine = data?.pdf ?? pdf
  const sawRunning = useRef('')
  useEffect(() => {
    if (!job || job.kind !== 'analyse' || job.target !== mine) return
    if (job.state === 'running') sawRunning.current = job.id
    else if (job.id === sawRunning.current) {
      sawRunning.current = ''
      void overview.reload()
    }
  }, [job?.id, job?.state, mine])
  const chapters = data?.chapters ?? []
  const chosen = picked ?? new Set(chapters.map((c) => c.number))
  const cloned = voices.filter((v) => v.kind === 'cloned')
  const voiceName = voice || cloned[0]?.name || voices[0]?.name || ''

  const start = async (tool: string, args: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      const started = await call<BookJob>(tool, args)
      await reloadJob()
      // A cached book can be read before the first poll sees it running.
      if (started.kind === 'analyse' && started.state !== 'running') await overview.reload()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (n: number) => {
    const next = new Set(chosen)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    setPicked(next)
  }

  const everything = chosen.size === chapters.length
  const render = () => start('audiobook__start_render', {
    pdf, voice: voiceName, speed, m4b,
    ...(everything ? {} : { chapters: toSelection([...chosen].sort((a, b) => a - b)) }),
  })
  const canRender = !(busy || running || chosen.size === 0 || !voiceName)
  const renderLabel = `Render ${everything ? 'all chapters' : `${chosen.size} chapter${chosen.size === 1 ? '' : 's'}`}`

  const reader = reading != null ? chapters.find((c) => c.number === reading) : undefined
  const picks = data?.analysed ? chapters.filter((c) => chosen.has(c.number)) : []
  const words = picks.reduce((n, c) => n + c.words, 0)
  const allWords = chapters.reduce((n, c) => n + c.words, 0)
  const times = data?.analysed ? selectionTimes(data, chosen) : null
  const skipped = Object.entries(data?.skipped ?? {})
  const left = skipped.reduce((n, [, count]) => n + count, 0)

  const heading = (
    <header className="ab-bookhead">
      <span className="navtile" style={style({ '--tile': toolColor('audiobook') })}><IconAudiobooks size={20} strokeWidth={2} aria-hidden /></span>
      <div className="ab-booktitle">
        <h2>{data?.title ?? fileName(pdf)}</h2>
        {data?.author && <p className="muted">{data.author}</p>}
      </div>
      {data?.analysed && !!data.citations_removed && <span className="chip">{data.citations_removed} citations removed</span>}
    </header>
  )

  return (
    <section className="ab-book" aria-label={data?.title ?? fileName(pdf)}>
      {heading}
      {overview.error && <p className="ab-detail ab-tone-bad" role="alert"><IconFail size={16} aria-hidden /><span>{overview.error}</span></p>}
      {!data && !overview.error && (
        <div className="ab-figs" aria-busy="true" aria-label="Reading the book's plan">
          {[0, 1, 2, 3].map((i) => <div key={i} className="card stat ab-stat"><div className="skeleton ab-skel-stat" /></div>)}
        </div>
      )}

      {data && !data.analysed && (
        <div className="card ab-unread">
          <span className="ab-unread-icon"><IconDocuments size={22} strokeWidth={1.8} aria-hidden /></span>
          <div className="stack">
            <p>This PDF has not been read yet. {data.hint}</p>
            <div className="row">
              <button className="primary" disabled={busy || running} onClick={() => void start('audiobook__start_analysis', { pdf })}>
                <IconZap size={16} aria-hidden />Read this book
              </button>
              {running && <span className="muted">Another job is running — one at a time.</span>}
            </div>
          </div>
        </div>
      )}

      {data?.analysed && times && (
        <>
          <div className="ab-figs stagger">
            <Fig index={0} label="Chapters" count={chosen.size} suffix={`of ${chapters.length}`} foot={everything ? 'all will be rendered' : 'chosen to render'} />
            <Fig index={1} label="Words" count={words} foot={everything ? 'in the whole book' : `of ${allWords.toLocaleString()} in all`} />
            <Fig index={2} label="Speech" foot={times.approx ? `about · the whole book is ${data.speech}` : 'the whole book'}><Duration text={times.speech} /></Fig>
            <Fig index={3} label="To render" foot="estimated, on this computer"><Duration text={times.render} /></Fig>
          </div>

          <div className="grid-split ab-bookgrid">
            <div className="ab-main">
              <ChartCard
                className="ab-chapters"
                title="Chapters"
                sub="Click a bar to leave a chapter out. Bars are words; labels are speech time."
                actions={<button className="ghost" onClick={() => setPicked(everything ? new Set() : new Set(chapters.map((c) => c.number)))}>{everything ? 'Clear all' : 'Select all'}</button>}
                table={(
                  <div className="stack-rows">
                    <table className="history">
                      <thead>
                        <tr>
                          <th><input type="checkbox" checked={everything} aria-label="All chapters"
                            onChange={() => setPicked(everything ? new Set() : new Set(chapters.map((c) => c.number)))} /></th>
                          <th>#</th><th>Chapter</th><th className="num">Words</th><th className="num">Speech</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {chapters.map((c) => (
                          <tr key={c.number}>
                            <td data-label="Include"><input type="checkbox" checked={chosen.has(c.number)} onChange={() => toggle(c.number)} aria-label={`Chapter ${c.number}`} /></td>
                            <td data-label="#">{c.number}</td>
                            <td data-label="Chapter">{c.label}{c.appendix && <span className="muted"> · appendix</span>}</td>
                            <td className="num" data-label="Words">{c.words.toLocaleString()}</td>
                            <td className="num" data-label="Speech">{c.speech}</td>
                            <td data-label="Text"><button onClick={() => setReading(reading === c.number ? null : c.number)}>{reading === c.number ? 'Hide' : 'Read'}</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              >
                <Scroller>
                  <HBars
                    label="Words per chapter. Pick the chapters to render."
                    color={toolColor('audiobook')}
                    onToggle={(key) => toggle(Number(key))}
                    items={chapters.map((c) => ({
                      key: String(c.number),
                      label: c.appendix ? `${c.label} · appendix` : c.label,
                      value: c.words,
                      display: c.speech,
                      sub: `Chapter ${c.number}: ${c.words.toLocaleString()} words, ${c.speech} of speech`,
                      selected: chosen.has(c.number),
                    }))}
                  />
                </Scroller>
                <div className="ab-chart-foot">
                  <p className="small muted" role="status">
                    {chosen.size === 0
                      ? 'No chapter chosen, so there is nothing to render.'
                      : `${chosen.size} of ${chapters.length} chosen · ${words.toLocaleString()} words${times.speech ? ` · ${times.approx ? 'about ' : ''}${times.speech} of speech` : ''}`}
                  </p>
                  <label className="check ab-readpick">
                    Check the spoken text of
                    <select value={reading ?? ''} onChange={(e) => setReading(e.target.value === '' ? null : Number(e.target.value))} aria-label="Read a chapter">
                      <option value="">a chapter…</option>
                      {chapters.map((c) => <option key={c.number} value={c.number}>{c.label}</option>)}
                    </select>
                  </label>
                </div>
              </ChartCard>

              {reader && <Reader key={`${pdf}:${reading}:${version}`} pdf={pdf} chapter={reader} onClose={() => setReading(null)} />}
            </div>

            <div className="ab-side">
              <div className="card ab-render">
                <CardHead icon={IconZap} tool="audiobook" title="Render" sub={`${everything ? 'The whole book' : `${chosen.size} of ${chapters.length} chapters`}${times.speech ? `, ${times.approx ? 'about ' : ''}${times.speech} of speech` : ''}`} />
                <div className="stack">
                  <label className="ab-field">
                    <span>Voice</span>
                    <select value={voiceName} onChange={(e) => setVoice(e.target.value)} aria-label="Voice">
                      {cloned.length > 0 && <optgroup label="Your voices">{cloned.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</optgroup>}
                      <optgroup label="Built in">{voices.filter((v) => v.kind === 'preset').map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</optgroup>
                    </select>
                  </label>
                  <div className="ab-field">
                    <span>Speed</span>
                    <div className="ab-speed">
                      <input type="range" min={0.5} max={2} step={0.05} value={Number.isFinite(speed) ? speed : 0.95} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed, slider" />
                      <input type="number" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed" />
                    </div>
                  </div>
                  <label className="check ab-m4b">
                    <input type="checkbox" checked={m4b} onChange={(e) => setM4b(e.target.checked)} />
                    Also one .m4b file
                  </label>
                  <button className="primary ab-render-go" disabled={!canRender} onClick={() => void render()}>
                    <IconZap size={16} aria-hidden />{renderLabel}
                  </button>
                </div>
                <p className="hint">
                  Hours of work for a whole book, and nothing is lost if it stops: every sentence spoken is kept, so starting it again
                  carries on. A different speed re-encodes in seconds.{running && ' Another job is running — one at a time.'}
                </p>
                {error && <p className="error">{error}</p>}
              </div>
            </div>
          </div>

          <div className="grid-2 ab-pair">
            {skipped.length > 0 && (
              <ChartCard
                title="What was left out"
                sub={`${left.toLocaleString()} pieces of the PDF that are not read aloud, by reason.`}
                table={(
                  <table>
                    <thead><tr><th>Reason</th><th className="num">Left out</th></tr></thead>
                    <tbody>{skipped.map(([reason, n]) => <tr key={reason}><td>{reason}</td><td className="num">{n.toLocaleString()}</td></tr>)}</tbody>
                  </table>
                )}
              >
                <HBars
                  label="What was left out of the reading, by reason"
                  color={toolColor('audiobook')}
                  items={skipped.map(([reason, n]) => ({ key: reason, label: reason, value: n, display: n.toLocaleString() }))}
                />
              </ChartCard>
            )}
            <Corrections pdf={pdf} onSaved={() => { setVersion((v) => v + 1); void overview.reload() }} />
          </div>

          <div className="ab-dock" role="group" aria-label="Render the chosen chapters">
            <span className="ab-dock-text">
              <strong>{everything ? 'All chapters' : `${chosen.size} of ${chapters.length} chapters`}</strong>
              <span className="muted small">
                {running ? 'Another job is running' : `${times.speech ? `${times.approx ? 'about ' : ''}${times.speech} · ` : ''}${voiceName || 'no voice'}`}
              </span>
            </span>
            <button className="primary" disabled={!canRender} onClick={() => void render()}><IconZap size={16} aria-hidden />Render</button>
          </div>
        </>
      )}
      {error && !data?.analysed && <p className="error">{error}</p>}
    </section>
  )
}

// ---------------------------------------------------------------------------

function Voices({ voices, loaded, running, reloadJob }: { voices: Voice[]; loaded: boolean; running: boolean; reloadJob: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [clip, setClip] = useState<{ name: string; path: string } | null>(null)
  const [consent, setConsent] = useState('')
  const [adding, setAdding] = useState(false)
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const upload = async ([file]: File[]) => {
    if (!file) return
    setError('')
    setUploading({ name: file.name, fraction: 0 })
    try {
      setClip(await uploadVoice(file, (fraction) => setUploading({ name: file.name, fraction })))
    } catch (e) {
      setError(message(e))
    } finally {
      setUploading(null)
    }
  }

  const start = async (tool: string, args: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      await call(tool, args)
      await reloadJob()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const cloned = voices.filter((v) => v.kind === 'cloned')
  const presets = voices.filter((v) => v.kind === 'preset')
  const missing = [!name.trim() && 'a name', !clip && 'a recording', !consent.trim() && 'who agreed'].filter(Boolean) as string[]
  const steps: { done: boolean }[] = [{ done: !!name.trim() }, { done: !!clip }, { done: !!consent.trim() }]

  return (
    <DropZone
      accepts={(f) => isAudio(f.name)}
      label="Drop a recording to clone"
      onRefuse={(names) => setError(`Not uploaded — a voice is cloned from an audio recording (${AUDIO_EXTS.join(' ')}): ${names.join(', ')}`)}
      onFiles={(files) => { setAdding(true); void upload(files) }}
      disabled={uploading !== null}
    >
      <div className="card ab-voices-card">
        <CardHead icon={IconMeetings} tool="audiobook" title="Voices" sub="Cloned from a short recording, or built in." />
        {!loaded && <div className="skeleton ab-skel" aria-hidden />}
        {loaded && cloned.length === 0 && <p className="muted">No cloned voices yet.</p>}
        <ul className="ab-voices stagger">
          {cloned.map((v, i) => (
            <li key={v.name} style={style({ '--i': i })}>
              <div className="ab-voice">
              <span className="ab-avatar" aria-hidden>{v.name.charAt(0).toUpperCase()}</span>
              <div className="ab-voice-main">
                <strong>{v.name}</strong>
                {v.similarity != null && (
                  <div className="ab-meter">
                    <div className="bar" role="meter" aria-label={`${v.name}: similarity to the recording`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={v.similarity} aria-valuetext={`similarity ${v.similarity.toFixed(2)}`}>
                      <div style={{ width: `${Math.max(0, Math.min(1, v.similarity)) * 100}%`, background: toolColor('audiobook') }} />
                    </div>
                    <span className="small muted">similarity {v.similarity.toFixed(2)}</span>
                  </div>
                )}
                {v.consent && <p className="small muted ab-consent">{v.consent}</p>}
              </div>
              <button className="ab-sample" disabled={busy || running} onClick={() => void start('audiobook__start_voice_sample', { voice: v.name })}>
                <IconPlay size={16} aria-hidden />Hear a sample
              </button>
              </div>
            </li>
          ))}
        </ul>

        {presets.length > 0 && (
          <details className="ab-presets">
            <summary>Built-in voices ({presets.length})</summary>
            <p className="hint">Built-in voices work by name too:</p>
            <ul className="ab-chips">{presets.map((v) => <li key={v.name}><span className="badge">{v.name}</span></li>)}</ul>
          </details>
        )}

        <details className="ab-add" open={adding} onToggle={(e) => setAdding(e.currentTarget.open)}>
          <summary>Add a voice</summary>
          <ol className="ab-steps">
            <li className={steps[0]!.done ? 'done' : ''}>
              <span className="ab-step-n">{steps[0]!.done ? <IconCheck size={14} strokeWidth={3} aria-hidden /> : 1}</span>
              <div className="ab-step-body">
                <strong>Name it</strong>
                <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="A name — lowercase, e.g. tina" aria-label="Voice name" />
              </div>
            </li>
            <li className={steps[1]!.done ? 'done' : ''}>
              <span className="ab-step-n">{steps[1]!.done ? <IconCheck size={14} strokeWidth={3} aria-hidden /> : 2}</span>
              <div className="ab-step-body">
                <strong>Add a recording</strong>
                <p className="hint">
                  About 30 seconds of one person speaking clearly, with no music or background noise. A longer recording is searched for
                  its best 30 seconds, which takes a minute or more.
                </p>
                <div className="row">
                  <PickFiles label="Upload a recording…" icon={<IconUpload size={16} aria-hidden />} accept={AUDIO_EXTS.join(',') + ',audio/*'} disabled={uploading !== null} onPick={(f) => void upload(f)} />
                  {clip ? <span className="ab-clip"><IconCheck size={14} strokeWidth={2.6} aria-hidden />{clip.name}</span> : <span className="muted small">or drop it on this card</span>}
                </div>
                {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
              </div>
            </li>
            <li className={steps[2]!.done ? 'done' : ''}>
              <span className="ab-step-n">{steps[2]!.done ? <IconCheck size={14} strokeWidth={3} aria-hidden /> : 3}</span>
              <div className="ab-step-body">
                <strong>Say who agreed</strong>
                <input
                  value={consent}
                  onChange={(e) => setConsent(e.target.value)}
                  placeholder='Whose voice, and that they agreed — e.g. "my own voice"'
                  aria-label="Consent"
                />
                <p className="hint">Only clone a voice you own or have the speaker’s permission to use. What you write here is kept with the voice.</p>
              </div>
            </li>
          </ol>
          <div className="row ab-clone">
            <button
              className="primary"
              disabled={busy || running || !name.trim() || !clip || !consent.trim()}
              onClick={() => void start('audiobook__start_voice_clone', { name: name.trim(), recording: clip?.path, consent: consent.trim() })}
            >
              <IconMeetings size={16} aria-hidden />Clone this voice
            </button>
            {missing.length > 0 && <span className="muted small">Still needed: {missing.join(', ')}.</span>}
            {missing.length === 0 && running && <span className="muted small">Another job is running — one at a time.</span>}
          </div>
        </details>
        {error && <p className="error">{error}</p>}
      </div>
    </DropZone>
  )
}

// ---------------------------------------------------------------------------

function Finished({ refreshKey, book, onDelete }: { refreshKey: string; book: string; onDelete: (book: string) => void }) {
  const books = usePoll(() => call<{ audiobooks: AudioBook[] }>('audiobook__list_audiobooks'), 30000)
  useEffect(() => { void books.reload() }, [refreshKey])
  const list = books.data?.audiobooks ?? []
  if (books.data === null && !books.error) return <div className="card ab-finished" id="ab-finished" aria-busy="true"><div className="skeleton ab-skel" /></div>
  if (list.length === 0 && !books.error) return null
  const files = list.reduce((n, b) => n + b.files.length, 0)
  const open = book ? stem(book) : ''
  return (
    <div className="card ab-finished" id="ab-finished">
      <CardHead icon={IconAudiobooks} tool="audiobook" title="Finished audio" sub={`${files} file${files === 1 ? '' : 's'} in ${list.length} place${list.length === 1 ? '' : 's'}. Play one here, or download it.`} />
      <div className="ab-groups">
        {list.map((b) => {
          const megabytes = b.files.reduce((n, f) => n + f.megabytes, 0)
          return (
            <details key={b.book} className="ab-group">
              <summary>
                <span className="ab-group-name">{b.book === 'voices' ? 'Voice samples' : b.book}</span>
                {b.book === open && <span className="chip">open book</span>}
                <span className="muted small ab-group-meta">{b.files.length} file{b.files.length === 1 ? '' : 's'} · {megabytes.toFixed(1)} MB</span>
              </summary>
              <div className="ab-files">
                {b.files.map((f) => <AudioFile key={`${f.path}:${f.modified}`} path={f.path} size={f.megabytes} />)}
              </div>
              {b.book !== 'voices' && (
                <button className="ghost ab-delete" onClick={() => onDelete(b.book)}>
                  <IconTrash size={14} aria-hidden />Delete this audiobook…
                </button>
              )}
            </details>
          )
        })}
      </div>
      {books.error && <p className="error">{books.error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function Audiobooks() {
  const [book, setBook] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [changed, setChanged] = useState(0)
  const uploads = usePoll(getUploads, 30000)
  const status = usePoll(() => call<{ job: BookJob | null }>('audiobook__job_status'), 3000)
  const voiceList = usePoll(() => call<{ voices: Voice[] }>('audiobook__list_voices'), 30000)
  const job = status.data?.job ?? null

  // Chapters finish one by one during a render, so the list of finished audio follows the job.
  const progressKey = job ? `${job.id}:${job.state}:${job.outputs.length}` : ''
  const justFinished = job?.state === 'done' ? job.id : ''
  useEffect(() => { if (justFinished) void voiceList.reload() }, [justFinished])

  // The uploaded PDF behind a finished book, if there is one: matched by name, as the output folder is.
  const uploadFor = (name: string) => uploads.data?.books.find((b) => stem(b.name) === name) ?? null
  const gone = deleting !== null ? uploadFor(deleting) : null

  return (
    <div className="panel ab-page" style={style({ '--ab': toolColor('audiobook') })}>
      <Library book={book} setBook={setBook} uploads={uploads} onDelete={setDeleting} />
      <JobCard job={job} reload={status.reload} />
      {book && (
        <Book key={book} pdf={book} voices={voiceList.data?.voices ?? []} job={job} reloadJob={status.reload} />
      )}
      <div className="grid-split ab-lower">
        <Finished refreshKey={`${progressKey}:${changed}`} book={book} onDelete={setDeleting} />
        <Voices voices={voiceList.data?.voices ?? []} loaded={voiceList.data !== null} running={job?.state === 'running'} reloadJob={status.reload} />
      </div>
      {(status.error || voiceList.error) && <p className="error">{status.error || voiceList.error}</p>}
      {deleting !== null && (
        <DeleteBook
          key={deleting}
          book={deleting}
          upload={gone ? { name: gone.name, bytes: gone.bytes } : null}
          onCancel={() => setDeleting(null)}
          onChanged={() => { setChanged((n) => n + 1); void uploads.reload() }}
          onDone={() => {
            if (book && stem(book) === deleting) setBook('')
            setDeleting(null)
          }}
        />
      )}
    </div>
  )
}
