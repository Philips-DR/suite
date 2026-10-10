// Audiobooks by button: read a PDF, check what will be spoken, pick a voice, render, listen.
// The same audiobook tools the model calls in chat, called directly -- no model.
//
// Reading a book, rendering it and cloning a voice are all background jobs in the tool, one at a
// time, and `job_status` is the one place their progress lives. A render is hours; this page can
// be closed and reopened and the job is still there.

import { useEffect, useRef, useState } from 'react'
import { AUDIO_EXTS, fetchMedia, getUploads, uploadBook, uploadVoice } from '../api'
import { PickFiles, UploadProgress } from './Upload'
import { call } from './Meetings'
import { fileName, usePoll } from '../usePoll'

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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

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

// ---------------------------------------------------------------------------

/** Play or download a file a tool made. Fetched with the token and handed over as a blob. */
function AudioFile({ path, size }: { path: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // A blob URL holds the whole file in memory until it is revoked.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  const play = async () => {
    setBusy(true)
    setError('')
    try {
      setUrl(URL.createObjectURL(await fetchMedia(path)))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
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

  return (
    <div className="output">
      <div className="row spread">
        <span>{fileName(path)}{size != null && <span className="muted small"> · {size} MB</span>}</span>
        <span className="row">
          {!url && <button disabled={busy} onClick={() => void play()}>{busy ? 'Loading…' : 'Play'}</button>}
          <button onClick={() => void download()}>Download</button>
        </span>
      </div>
      {url && <audio controls autoPlay src={url} style={{ width: '100%', marginTop: 8 }} />}
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

  return (
    <div className={`card job job-${job.state}`}>
      <div className="job-head">
        <strong>{KIND_LABEL[job.kind]}: {fileName(job.target)}</strong>
        <span className="row">
          <span className="badge">{running ? job.phase : job.state}</span>
          {running && !asking && <button onClick={() => setAsking(true)}>Cancel</button>}
        </span>
      </div>
      {running && asking && (
        <div className="warn-box" style={{ marginBottom: 8 }}>
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
          <div className="bar" role="progressbar" aria-valuenow={job.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${job.percent ?? 0}%` }} />
          </div>
          <p className="muted">
            {job.chapter != null && `Chapter ${job.chapter}: ${job.chapter_title} · ${job.chunks_done}/${job.chunks_total} · `}
            {job.percent != null ? `${job.percent.toFixed(0)}%` : job.phase}
            {job.eta ? ` · about ${job.eta} left` : ''}
          </p>
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
        <p className="muted">{job.outputs.length} file{job.outputs.length === 1 ? '' : 's'} made — see Finished audio below.</p>
      )}
      {job.state === 'done' && job.kind === 'voice' && <p className="muted">The voice is ready. Hear a sample before using it.</p>}
      {(job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled') && <p className="warn">{job.detail}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Library({ book, setBook }: { book: string; setBook: (path: string) => void }) {
  const uploads = usePoll(getUploads, 30000)
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

  return (
    <div className="card">
      <h2>Audiobooks</h2>
      <p className="muted">
        Turn a PDF into an audiobook, read in a voice cloned from a short recording. Everything runs on this computer.
      </p>
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
        <button disabled={!typed.trim() || typed.trim() === book} onClick={() => setBook(typed.trim())}>Open</button>
        <PickFiles label="Upload a PDF…" accept=".pdf,application/pdf" className="primary" disabled={uploading !== null} onPick={(f) => void upload(f)} />
      </div>
      {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
      {(error || uploads.error) && <p className="error">{error || uploads.error}</p>}
    </div>
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
    <details>
      <summary>Corrections</summary>
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
      />
      <div className="row">
        <button disabled={!loaded} onClick={() => void save()}>Save corrections</button>
        {note && <span className="muted">{note}</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </details>
  )
}

function Reader({ pdf, chapter }: { pdf: string; chapter: Chapter }) {
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
    <div className="reader">
      <h3>What will be read — {chapter.label}</h3>
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
      {busy && !text && <p className="muted">Reading…</p>}
      {error && <p className="error">{error}</p>}
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

  return (
    <div className="card">
      <h2>{data?.title ?? fileName(pdf)}</h2>
      {data?.author && <p className="muted">{data.author}</p>}
      {overview.error && <p className="error">{overview.error}</p>}

      {data && !data.analysed && (
        <div className="stack">
          <p>This PDF has not been read yet. {data.hint}</p>
          <div className="row">
            <button className="primary" disabled={busy || running} onClick={() => void start('audiobook__start_analysis', { pdf })}>
              Read this book
            </button>
            {running && <span className="muted">Another job is running — one at a time.</span>}
          </div>
        </div>
      )}

      {data?.analysed && (
        <>
          <p className="muted">
            {chapters.length} chapters · about {data.speech} of speech · about {data.render_time} to render on this computer
            {data.citations_removed ? ` · ${data.citations_removed} citations removed` : ''}
          </p>
          <div className="table-wrap">
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
                    <td><input type="checkbox" checked={chosen.has(c.number)} onChange={() => toggle(c.number)} aria-label={`Chapter ${c.number}`} /></td>
                    <td>{c.number}</td>
                    <td>{c.label}{c.appendix && <span className="muted"> · appendix</span>}</td>
                    <td className="num">{c.words.toLocaleString()}</td>
                    <td className="num">{c.speech}</td>
                    <td><button onClick={() => setReading(reading === c.number ? null : c.number)}>{reading === c.number ? 'Hide' : 'Read'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.skipped && Object.keys(data.skipped).length > 0 && (
            <p className="hint">
              Left out: {Object.entries(data.skipped).map(([reason, n]) => `${n} × ${reason}`).join(' · ')}
            </p>
          )}
          {reading != null && chapters.find((c) => c.number === reading) && (
            <Reader key={`${pdf}:${reading}:${version}`} pdf={pdf} chapter={chapters.find((c) => c.number === reading)!} />
          )}

          <h3>Render</h3>
          <div className="row">
            <label className="check">
              Voice
              <select value={voiceName} onChange={(e) => setVoice(e.target.value)} aria-label="Voice">
                {cloned.length > 0 && <optgroup label="Your voices">{cloned.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</optgroup>}
                <optgroup label="Built in">{voices.filter((v) => v.kind === 'preset').map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}</optgroup>
              </select>
            </label>
            <label className="check">
              Speed
              <input type="number" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
            </label>
            <label className="check">
              <input type="checkbox" checked={m4b} onChange={(e) => setM4b(e.target.checked)} />
              Also one .m4b file
            </label>
            <button className="primary" disabled={busy || running || chosen.size === 0 || !voiceName} onClick={() => void render()}>
              Render {everything ? 'all chapters' : `${chosen.size} chapter${chosen.size === 1 ? '' : 's'}`}
            </button>
          </div>
          <p className="hint">
            Hours of work for a whole book, and nothing is lost if it stops: every sentence spoken is kept, so starting it again
            carries on. A different speed re-encodes in seconds.{running && ' Another job is running — one at a time.'}
          </p>
          <Corrections pdf={pdf} onSaved={() => { setVersion((v) => v + 1); void overview.reload() }} />
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Voices({ voices, running, reloadJob }: { voices: Voice[]; running: boolean; reloadJob: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [clip, setClip] = useState<{ name: string; path: string } | null>(null)
  const [consent, setConsent] = useState('')
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
  return (
    <div className="card">
      <h2>Voices</h2>
      {cloned.length === 0 && <p className="muted">No cloned voices yet.</p>}
      <ul className="list">
        {cloned.map((v) => (
          <li key={v.name}>
            <div className="list-main">
              <strong>{v.name}</strong>
              <span className="muted">
                {v.similarity ? `similarity ${v.similarity.toFixed(2)}` : ''}
                {v.consent ? ` · ${v.consent}` : ''}
              </span>
            </div>
            <div className="row">
              <button disabled={busy || running} onClick={() => void start('audiobook__start_voice_sample', { voice: v.name })}>
                Hear a sample
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="hint">Built-in voices work by name too: {voices.filter((v) => v.kind === 'preset').map((v) => v.name).join(', ')}.</p>

      <details>
        <summary>Add a voice</summary>
        <div className="stack" style={{ marginTop: 10 }}>
          <p className="hint">
            About 30 seconds of one person speaking clearly, with no music or background noise. A longer recording is searched for
            its best 30 seconds, which takes a minute or more.
          </p>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="A name — lowercase, e.g. tina" aria-label="Voice name" />
          <div className="row">
            <PickFiles label="Upload a recording…" accept={AUDIO_EXTS.join(',') + ',audio/*'} disabled={uploading !== null} onPick={(f) => void upload(f)} />
            {clip && <span className="muted">{clip.name}</span>}
          </div>
          {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
          <input
            value={consent}
            onChange={(e) => setConsent(e.target.value)}
            placeholder='Whose voice, and that they agreed — e.g. "my own voice"'
            aria-label="Consent"
          />
          <p className="hint">Only clone a voice you own or have the speaker’s permission to use. What you write here is kept with the voice.</p>
          <div className="row">
            <button
              className="primary"
              disabled={busy || running || !name.trim() || !clip || !consent.trim()}
              onClick={() => void start('audiobook__start_voice_clone', { name: name.trim(), recording: clip?.path, consent: consent.trim() })}
            >
              Clone this voice
            </button>
          </div>
        </div>
      </details>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Finished({ refreshKey }: { refreshKey: string }) {
  const books = usePoll(() => call<{ audiobooks: AudioBook[] }>('audiobook__list_audiobooks'), 30000)
  useEffect(() => { void books.reload() }, [refreshKey])
  const list = books.data?.audiobooks ?? []
  if (list.length === 0 && !books.error) return null
  return (
    <div className="card">
      <h2>Finished audio</h2>
      <ul className="list">
        {list.map((b) => (
          <li key={b.book}>
            <div className="list-main"><strong>{b.book === 'voices' ? 'Voice samples' : b.book}</strong><span className="muted">{b.files.length} file{b.files.length === 1 ? '' : 's'}</span></div>
            {b.files.map((f) => <AudioFile key={`${f.path}:${f.modified}`} path={f.path} size={f.megabytes} />)}
          </li>
        ))}
      </ul>
      {books.error && <p className="error">{books.error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function Audiobooks() {
  const [book, setBook] = useState('')
  const status = usePoll(() => call<{ job: BookJob | null }>('audiobook__job_status'), 3000)
  const voiceList = usePoll(() => call<{ voices: Voice[] }>('audiobook__list_voices'), 30000)
  const job = status.data?.job ?? null

  // Chapters finish one by one during a render, so the list of finished audio follows the job.
  const progressKey = job ? `${job.id}:${job.state}:${job.outputs.length}` : ''
  const justFinished = job?.state === 'done' ? job.id : ''
  useEffect(() => { if (justFinished) void voiceList.reload() }, [justFinished])

  return (
    <div className="panel">
      <Library book={book} setBook={setBook} />
      <JobCard job={job} reload={status.reload} />
      {book && (
        <Book key={book} pdf={book} voices={voiceList.data?.voices ?? []} job={job} reloadJob={status.reload} />
      )}
      <Voices voices={voiceList.data?.voices ?? []} running={job?.state === 'running'} reloadJob={status.reload} />
      <Finished refreshKey={progressKey} />
      {(status.error || voiceList.error) && <p className="error">{status.error || voiceList.error}</p>}
    </div>
  )
}
