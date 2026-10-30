// Meetings: a master-detail layout. The sidebar lists every transcript (and any live recording or
// transcription); the main area shows the detail of one meeting, or a flow for recording and
// transcribing a new one. The same tools the model calls in chat, called directly — no model,
// no waiting on one. The polls live in the root: recorder every 2 s, transcription every 5 s,
// recordings every 15 s, uploads every 30 s.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { AUDIO_EXTS, deleteUpload, getUploads, isAudio, uploadAudio, type Uploads } from '../api'
import { canRecordInBrowser, useBrowserRecorder } from '../useBrowserRecorder'
import { call } from '../call'
import { toolColor } from '../charts/palette'
import { Ring } from '../charts/Ring'
import { ShareBar } from '../charts/ShareBar'
import { useCountUp } from '../charts/useWidth'
import { useAppState } from '../state'
import { CardHead } from '../ui/CardHead'
import { ConfirmDelete, sizeOf } from '../ui/ConfirmDelete'
import { DropZone } from '../ui/DropZone'
import { Empty } from '../ui/Empty'
import {
  IconActivity, IconAlert, IconCheck, IconChevron, IconDocuments, IconFail, IconMeetings, IconOk,
  IconRefresh, IconSearch, IconSpark, IconStop, IconTrash, IconUpload,
} from '../ui/icons'
import { ago } from '../ui/time'
import { clock, fileName, usePoll } from '../usePoll'
import { PickFiles, UploadProgress } from './Upload'
import '../styles/panels/meetings.css'

interface Session {
  id: string
  state: 'recording' | 'orphaned' | 'stopped'
  source: string
  consent?: string | null
  recorded_seconds?: number
  audio?: string | null
  duration_seconds?: number | null
  max_volume_db?: number | null
  warnings?: string[]
}

interface Job {
  id: string
  audio: string
  state: 'running' | 'done' | 'failed' | 'interrupted'
  phase: string
  percent: number | null
  eta: string | null
  markdown: string
  timeline: string
  detail: string
}

interface Recordings {
  audio: string[]
  transcripts: { markdown: string; timeline: string | null; notes: string | null; minutes?: string | null }[]
}

interface Poll<T> {
  data: T | null
  error: string
  reload: () => Promise<void>
}

export { call }

const IDS = { record: 'meet-record', transcribe: 'meet-transcribe' } as const
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

const isWebAddress = (url: string) => /^https?:\/\//i.test(url)

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="mt-note error" role="alert">
      <IconFail size={16} aria-hidden />
      <span>{children}</span>
    </p>
  )
}

function Fig({ label, value }: { label: string; value: number | string }) {
  const shown = useCountUp(typeof value === 'number' ? value : 0, 600)
  return (
    <div>
      <dt>{label}</dt>
      <dd>{typeof value === 'number' ? Math.round(shown).toLocaleString() : value}</dd>
    </div>
  )
}

// ---- elapsed clock for the recorder ----------------------------------------------------------------

function useElapsed(session: Session | null): number {
  const live = session?.state === 'recording'
  const heard = useRef({ seconds: 0, at: Date.now() })
  const shown = useRef(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!session) return
    heard.current = { seconds: session.recorded_seconds ?? 0, at: Date.now() }
    setNow(Date.now())
  }, [session])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])

  if (!live) {
    shown.current = 0
    return session?.recorded_seconds ?? 0
  }
  const estimate = heard.current.seconds + Math.max(0, (now - heard.current.at) / 1000)
  shown.current = Math.max(shown.current, Math.floor(estimate))
  return shown.current
}

// ---- record (browser microphone) -------------------------------------------------------------------

function BrowserRec({ onRecorded }: { onRecorded: (path: string) => void }) {
  const rec = useBrowserRecorder()
  const recording = rec.state === 'recording'
  const uploading = rec.state === 'uploading'
  const done = rec.state === 'done'

  useEffect(() => {
    if (done && rec.result) onRecorded(rec.result.path)
  }, [done, rec.result, onRecorded])

  return (
    <section id={IDS.record} className="mt-slot" tabIndex={-1} aria-label="Record">
      <div className={`card mt-rec ${recording ? 'is-live' : ''}`}>
        <CardHead icon={IconMeetings} tool="meet-ai" title="Record" sub="Record from this device's microphone; the audio is handed on to Transcribe." />

        {recording ? (
          <div className="mt-live">
            <div className="mt-live-top">
              <span className="mt-onair" role="status"><span className="rec-dot" aria-hidden />Recording</span>
              <span className="mono small muted">Browser microphone</span>
            </div>
            <p className="mt-clock">{clock(rec.elapsed)}</p>
            <button className="danger mt-big" onClick={rec.stop}>
              <IconStop size={16} aria-hidden />
              Stop recording
            </button>
          </div>
        ) : uploading ? (
          <div className="mt-live">
            <p className="mt-clock">{clock(rec.elapsed)}</p>
            <UploadProgress name="Recording" fraction={rec.uploadProgress} />
          </div>
        ) : rec.state === 'stopping' ? (
          <div className="mt-live" aria-busy="true">
            <p className="muted">Finishing…</p>
          </div>
        ) : done && rec.result ? (
          <>
            <div className="mt-saved" role="status">
              <div className="mt-saved-head">
                <span className="badge ok"><IconOk size={14} aria-hidden />Saved</span>
                <strong className="mt-file">{rec.result.name}</strong>
              </div>
              <dl className="mt-figs" style={{ '--n': 1 } as CSSProperties}>
                <Fig label="Duration" value={clock(rec.result.seconds)} />
              </dl>
              <div className="mt-saved-next">
                <span className="muted small">It is in the Transcribe box, ready to go.</span>
                <button type="button" className="ghost" onClick={() => jumpTo(IDS.transcribe)}>
                  Go to Transcribe
                  <IconChevron size={16} aria-hidden />
                </button>
              </div>
            </div>
            <hr />
            <div className="mt-start">
              <button className="primary mt-big" onClick={() => { rec.reset(); rec.start() }}>
                <IconMeetings size={17} aria-hidden />
                Record again
              </button>
            </div>
          </>
        ) : (
          <Empty icon={IconMeetings} title="Ready when the meeting starts" action={
            <div className="mt-start">
              <button className="primary mt-big" disabled={rec.state === 'requesting'} onClick={rec.start}>
                <IconMeetings size={17} aria-hidden />
                {rec.state === 'requesting' ? 'Requesting microphone…' : 'Start recording'}
              </button>
            </div>
          }>
            Uses this device's microphone. The audio is uploaded and handed to the next step.
          </Empty>
        )}

        {rec.error && <Problem>{rec.error}</Problem>}
        <p className="hint">One microphone records everyone in the room together; speaker labels are still inferred.</p>
      </div>
    </section>
  )
}

// ---- record (server microphone) --------------------------------------------------------------------

function Recorder({ status, elapsed, last, setLast, onStopped }: {
  status: Poll<{ session: Session | null }>
  elapsed: number
  last: Session | null
  setLast: (s: Session | null) => void
  onStopped: (done: Session) => void
}) {
  const [consent, setConsent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const session = status.data?.session ?? null
  const recording = session?.state === 'recording'
  const orphaned = session?.state === 'orphaned'
  const checking = status.data === null && !status.error

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await status.reload()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const start = () =>
    act(async () => {
      setLast(null)
      await call('meet_ai__start_recording', consent.trim() ? { consent: consent.trim() } : {})
    })

  const stop = () =>
    act(async () => {
      const done = await call<Session>('meet_ai__stop_recording')
      onStopped(done)
    })

  const startForm = (
    <div className="mt-start">
      <label className="mt-field">
        <span>Who agreed to be recorded <small>(optional)</small></span>
        <input
          value={consent}
          onChange={(e) => setConsent(e.target.value)}
          placeholder='e.g. "verbal, all present"'
        />
      </label>
      <button className="primary mt-big" disabled={busy || checking} onClick={() => void start()}>
        <IconMeetings size={17} aria-hidden />
        Start recording
      </button>
    </div>
  )

  return (
    <section id={IDS.record} className="mt-slot" tabIndex={-1} aria-label="Record">
      <div className={`card mt-rec ${recording ? 'is-live' : ''} ${orphaned ? 'is-orphaned' : ''}`}>
        <CardHead icon={IconMeetings} tool="meet-ai" title="Record" sub="Capture the meeting; the audio is handed on to Transcribe." />

        {recording && session ? (
          <div className="mt-live">
            <div className="mt-live-top">
              <span className="mt-onair" role="status"><span className="rec-dot" aria-hidden />Recording</span>
              <span className="mono small muted mt-id">{session.id}</span>
            </div>
            <p className="mt-clock">{clock(elapsed)}</p>
            <dl className="mt-meta">
              <div><dt>Source</dt><dd>{session.source}</dd></div>
              {session.consent && <div><dt>Consent</dt><dd>{session.consent}</dd></div>}
            </dl>
            <button className="danger mt-big" disabled={busy} onClick={() => void stop()}>
              <IconStop size={16} aria-hidden />
              Stop recording
            </button>
          </div>
        ) : orphaned && session ? (
          <div className="warn-box mt-orphan" role="status">
            <p className="mt-note">
              <IconAlert size={18} aria-hidden />
              <span>
                Recording <strong>{session.id}</strong> was interrupted with {clock(session.recorded_seconds)} on disk.
              </span>
            </p>
            <button className="primary mt-big" disabled={busy} onClick={() => void stop()}>
              Recover it
            </button>
          </div>
        ) : (
          <>
            {last && (
              <div className="mt-saved" role="status">
                <div className="mt-saved-head">
                  <span className="badge ok"><IconOk size={14} aria-hidden />Saved</span>
                  <strong className="mt-file">{fileName(last.audio)}</strong>
                </div>
                <dl className="mt-figs" style={{ '--n': typeof last.max_volume_db === 'number' ? 2 : 1 } as CSSProperties}>
                  <Fig label="Duration" value={clock(last.duration_seconds)} />
                  {typeof last.max_volume_db === 'number' && <Fig label="Peak level" value={`${last.max_volume_db} dB`} />}
                </dl>
                {last.warnings?.map((w) => (
                  <p key={w} className="mt-note warn"><IconAlert size={16} aria-hidden /><span>{w}</span></p>
                ))}
                {last.audio && (
                  <div className="mt-saved-next">
                    <span className="muted small">It is in the Transcribe box, ready to go.</span>
                    <button type="button" className="ghost" onClick={() => jumpTo(IDS.transcribe)}>
                      Go to Transcribe
                      <IconChevron size={16} aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            )}
            {last ? (
              <>
                <hr />
                {startForm}
              </>
            ) : (
              <Empty icon={IconMeetings} title="Ready when the meeting starts" action={startForm}>
                Start recording and the room is captured. When you stop, the audio is handed to the next step.
              </Empty>
            )}
          </>
        )}

        {(error || status.error) && <Problem>{error || status.error}</Problem>}
        <p className="hint">One microphone records everyone in the room together; speaker labels are still inferred.</p>
      </div>
    </section>
  )
}

// ---- transcribe ------------------------------------------------------------------------------------

function Transcriber({ job, status, recordings, uploads, audio, setAudio, onWriteUp }: {
  job: Job | null
  status: Poll<{ job: Job | null }>
  recordings: Poll<Recordings>
  uploads: Poll<Uploads>
  audio: string
  setAudio: (a: string) => void
  onWriteUp: (timeline: string) => void
}) {
  const [speakers, setSpeakers] = useState(false)
  const [count, setCount] = useState(4)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const [asking, setAsking] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const running = job?.state === 'running'

  const remove = async (name: string, path: string) => {
    setRemoving(true)
    setRemoveError('')
    try {
      await deleteUpload('audio', name)
      if (audio.trim() === path) setAudio('')
      setAsking(false)
      await uploads.reload()
    } catch (e) {
      setRemoveError(messageOf(e))
    } finally {
      setRemoving(false)
    }
  }

  const upload = async ([file]: File[]) => {
    if (!file) return
    setError('')
    setUploading({ name: file.name, fraction: 0 })
    try {
      const saved = await uploadAudio(file, (fraction) => setUploading({ name: file.name, fraction }))
      setAudio(saved.path)
      await uploads.reload()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setUploading(null)
    }
  }

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      await call('meet_ai__start_transcription', {
        audio,
        ...(speakers ? { diarize: true, speakers: count } : {}),
      })
      await status.reload()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  const choices = [
    ...[...(uploads.data?.audio ?? [])].sort((a, b) => b.at - a.at).map((a) => ({ path: a.path, label: a.name, uploaded: true })),
    ...[...(recordings.data?.audio ?? [])].reverse().map((p) => ({ path: p, label: fileName(p), uploaded: false })),
  ]
  const shown = choices.slice(0, 6)
  const chosen = audio.trim()
  // Only a file somebody uploaded is deleted here; a recording meet-ai made itself is not an upload.
  const picked = uploads.data?.audio.find((a) => a.path === chosen)
  const JobIcon = job?.state === 'done' ? IconOk : job?.state === 'failed' ? IconFail : IconAlert

  return (
    <section id={IDS.transcribe} className="mt-slot" tabIndex={-1} aria-label="Transcribe">
      <DropZone
        className="card mt-card"
        accepts={(f) => isAudio(f.name)}
        label="Drop audio to upload"
        onRefuse={(names) => setError(`Not uploaded — only audio can be transcribed: ${names.join(', ')}`)}
        onFiles={(files) => void upload(files)}
        disabled={running || uploading !== null}
      >
        <CardHead icon={IconActivity} tool="meet-ai" title="Transcribe" sub="Turn the audio into a transcript, with a timeline to write from." />

        {job && (
          <div className={`job job-${job.state} mt-job`}>
            {!running && <h3 className="mt-label">Latest job</h3>}
            <div className="mt-job-main">
              {running && (
                <div
                  role="progressbar"
                  aria-label="Transcription progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={job.percent != null ? Math.round(job.percent) : undefined}
                >
                  <Ring value={job.percent} size={84} stroke={8} label="Transcription progress">
                    {job.percent != null ? `${Math.round(job.percent)}%` : ''}
                  </Ring>
                </div>
              )}
              <div className="mt-job-text">
                <strong className="mt-file">{fileName(job.audio)}</strong>
                <div className="job-head">
                  <span className="badge">
                    {running ? <IconActivity size={13} aria-hidden /> : <JobIcon size={13} aria-hidden />}
                    {running ? job.phase : job.state}
                  </span>
                </div>
                {running && (
                  <p className="muted">
                    {job.percent != null ? `${job.percent.toFixed(1)}%` : job.phase}
                    {job.eta ? ` · about ${job.eta} left` : ''}
                  </p>
                )}
                {job.state === 'done' && <p className="muted">Transcript ready: {fileName(job.markdown)}</p>}
              </div>
            </div>
            {(job.state === 'failed' || job.state === 'interrupted') && (
              <p className={`mt-note ${job.state === 'failed' ? 'error' : 'warn'}`}>
                <IconAlert size={16} aria-hidden />
                <span>{job.detail}</span>
              </p>
            )}
            {running && <p className="hint">Long jobs keep going when you close this page.</p>}
            {job.state === 'done' && (
              <div className="mt-job-next">
                <button type="button" onClick={() => onWriteUp(job.timeline)}>
                  View meeting
                  <IconChevron size={16} aria-hidden />
                </button>
              </div>
            )}
          </div>
        )}

        {!running && (
          <div className="mt-form">
            <label className="mt-field">
              <span>Audio file</span>
              <input
                list="audio-files"
                value={audio}
                onChange={(e) => setAudio(e.target.value)}
                placeholder="Audio file — pick one, or paste a path"
              />
            </label>
            <datalist id="audio-files">
              {recordings.data?.audio.map((a) => <option key={a} value={a}>{fileName(a)}</option>)}
              {uploads.data?.audio.map((a) => <option key={a.path} value={a.path}>{a.name} (uploaded)</option>)}
            </datalist>

            {shown.length > 0 && (
              <div className="mt-picks-wrap">
                <h3 className="mt-label">Recordings and uploads</h3>
                <div className="mt-picks">
                  {shown.map((c) => (
                    <button
                      key={c.path}
                      type="button"
                      className="mt-pick"
                      aria-pressed={chosen === c.path}
                      title={c.path}
                      onClick={() => setAudio(c.path)}
                    >
                      {chosen === c.path && <IconCheck size={15} strokeWidth={2.6} aria-hidden />}
                      <span className="mt-pick-name">{c.label}</span>
                      {c.uploaded && <span className="mt-tag">uploaded</span>}
                    </button>
                  ))}
                </div>
                {choices.length > shown.length && (
                  <p className="hint">{choices.length - shown.length} more in the file box's list.</p>
                )}
                {picked && (
                  <button type="button" className="ghost mt-pick-delete" onClick={() => { setRemoveError(''); setAsking(true) }}>
                    <IconTrash size={14} aria-hidden />Delete “{picked.name}”
                  </button>
                )}
              </div>
            )}

            <div className="mt-upload">
              <PickFiles
                label="Upload audio…"
                icon={<IconUpload size={16} aria-hidden />}
                accept={AUDIO_EXTS.join(',') + ',audio/*'}
                disabled={uploading !== null}
                onPick={(files) => void upload(files)}
              />
              <span className="mt-drop-hint muted small">or drop an audio file on this card</span>
            </div>
            {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}

            <div className="mt-speakers">
              <label className="check">
                <input type="checkbox" checked={speakers} onChange={(e) => setSpeakers(e.target.checked)} />
                Label speakers
              </label>
              {speakers && (
                <label className="check">
                  people present
                  <input type="number" min={1} max={30} value={count} onChange={(e) => setCount(Number(e.target.value))} />
                </label>
              )}
            </div>
            {speakers && <p className="hint">Give the real headcount — guessing over-splits badly.</p>}

            <button className="primary mt-big" disabled={busy || !audio.trim()} onClick={() => void start()}>
              <IconActivity size={17} aria-hidden />
              {busy ? 'Starting…' : 'Transcribe'}
            </button>
          </div>
        )}
        {(error || status.error) && <Problem>{error || status.error}</Problem>}
        {asking && picked && (
          <ConfirmDelete
            title={`Delete “${picked.name}”?`}
            facts={[['Size', sizeOf(picked.bytes)], ['Uploaded', ago(picked.at * 1000)]]}
            keeps="The recording is removed from this computer. Transcripts and notes already made from it are not touched."
            verb="Delete"
            busy={removing}
            error={removeError}
            onConfirm={() => void remove(picked.name, picked.path)}
            onCancel={() => setAsking(false)}
          />
        )}
      </DropZone>
    </section>
  )
}

// ---- transcript reader (read-only) -----------------------------------------------------------------

interface TranscriptText { text: string; truncated: boolean; end: number; duration: number }

function TranscriptReader({ path }: { path: string }) {
  const [paragraphs, setParagraphs] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    call<TranscriptText>('meet_ai__read_transcript', { transcript: path })
      .then((t) => {
        setParagraphs(t.text.split('\n\n'))
        setTruncated(t.truncated)
      })
      .catch((e: unknown) => setError(messageOf(e)))
  }, [path])

  const needle = query.trim().toLowerCase()
  const shown = (paragraphs ?? []).filter((p) => !needle || p.toLowerCase().includes(needle))

  const highlight = (text: string) => {
    if (!needle) return text
    const parts: (string | ReactElement)[] = []
    let from = 0
    const lower = text.toLowerCase()
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
      parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>)
      from = at + needle.length
    }
    parts.push(text.slice(from))
    return parts
  }

  return (
    <div className="mt-reader">
      <div className="mt-search">
        <IconSearch size={16} aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" />
      </div>
      {error && <Problem>{error}</Problem>}
      {!paragraphs && !error && (
        <div className="mt-reader-loading" aria-busy="true">
          <p className="muted small">Loading…</p>
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {paragraphs && (
        <p className="muted small" aria-live="polite">
          {needle ? `${shown.length} of ${paragraphs.length} paragraphs match` : `${paragraphs.length} paragraphs`}
          {truncated && ' · very long transcript: only the first part is shown'}
        </p>
      )}
      {paragraphs && (
        <div className="mt-reader-text" tabIndex={0} aria-label="Transcript">
          {shown.length === 0 && needle && <p className="muted">No paragraph mentions "{query.trim()}".</p>}
          {shown.map((p, i) => {
            const stamped = /^\[(\d\d:\d\d:\d\d)\]\s*(.*)$/s.exec(p)
            const rest = stamped ? stamped[2] ?? '' : p
            const who = /^(Speaker \d+):\s*(.*)$/s.exec(rest)
            return (
              <p key={i} className={stamped ? 'has-stamp' : undefined}>
                {stamped && <span className="stamp">{stamped[1]}</span>}
                <span className="mt-line">
                  {who && <b className="mt-who">{highlight(`${who[1]}:`)} </b>}
                  {highlight(who ? who[2] ?? '' : rest)}
                </span>
              </p>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- write-up types and result display -------------------------------------------------------------

interface Preview { segments: number; words: number; approx_tokens: number }

interface Written {
  markdown: string
  verified_claims: number
  dropped_claims: number
  summary: string
}

interface BuiltDoc {
  url: string
  title: string
  residue: string[]
}

type Kind = 'notes' | 'minutes'
type WrittenResult = Written & Record<string, unknown>

const KINDS: { kind: Kind; label: string; tool: string; working: string }[] = [
  { kind: 'notes', label: 'Notes', tool: 'meet_ai__generate_notes', working: 'Writing notes…' },
  { kind: 'minutes', label: 'Minutes', tool: 'meet_ai__generate_minutes', working: 'Writing minutes…' },
]

function counted(output: Record<string, unknown>, key: string): number | null {
  const n = output[key]
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function Result({ kind, r }: { kind: Kind; r: WrittenResult }) {
  const verified = counted(r, 'verified_claims')
  const dropped = counted(r, 'dropped_claims')
  const noun = kind === 'minutes' ? 'points' : 'claims'
  const title = typeof r.title === 'string' && r.title ? r.title : ''
  const items = Array.isArray(r.items) ? r.items.filter((i): i is string => typeof i === 'string') : []
  const figs: { label: string; value: number }[] = kind === 'minutes'
    ? []
    : [['Decisions', 'decisions'], ['Actions', 'actions'], ['Questions', 'questions']].flatMap(([label, key]) => {
        const value = counted(r, key as string)
        return value === null ? [] : [{ label: label as string, value }]
      })

  return (
    <div className="mt-result">
      {kind === 'minutes' && title && <p className="mt-result-title">"{title}"</p>}
      {(verified !== null || dropped !== null) && (
        <div>
          <h3 className="mt-label">Checked against the transcript</h3>
          <ShareBar
            label={`Verified and dropped ${noun}`}
            parts={[
              { key: 'verified', label: `Verified ${noun}`, value: verified ?? 0, color: 'var(--ok-fill)', icon: IconOk },
              { key: 'dropped', label: `Dropped ${noun}`, value: dropped ?? 0, color: 'var(--warn-fill)', icon: IconAlert },
            ]}
          />
        </div>
      )}
      {(dropped ?? 0) > 0 && (
        <p className="mt-note warn">
          <IconAlert size={16} aria-hidden />
          <span>{dropped} dropped: quote not found in the transcript</span>
        </p>
      )}
      {figs.length > 0 && <dl className="mt-figs" style={{ '--n': figs.length } as CSSProperties}>{figs.map((f) => <Fig key={f.label} label={f.label} value={f.value} />)}</dl>}
      {items.length > 0 && (
        <details open={items.length <= 6}>
          <summary>Agenda items ({items.length})</summary>
          <ol className="mt-agenda">{items.map((item, i) => <li key={i}>{item}</li>)}</ol>
        </details>
      )}
    </div>
  )
}

// ---- meeting card (one row in the sidebar list) ----------------------------------------------------

function MeetingCard({ transcript, selected, onSelect }: {
  transcript: Recordings['transcripts'][0]
  selected: boolean
  onSelect: () => void
}) {
  const name = fileName(transcript.markdown)
  const hasTimeline = Boolean(transcript.timeline)
  const hasNotes = Boolean(transcript.notes)
  const hasMinutes = Boolean(transcript.minutes)

  return (
    <li role="option" aria-selected={selected}>
      <button type="button" className={`mt-mcard${selected ? ' is-selected' : ''}`} onClick={onSelect}>
        <strong className="mt-mcard-title">{name}</strong>
        <div className="mt-mcard-chips">
          {hasNotes && <span className="badge ok"><IconCheck size={12} strokeWidth={2.6} aria-hidden />Notes</span>}
          {hasMinutes && <span className="badge ok"><IconCheck size={12} strokeWidth={2.6} aria-hidden />Minutes</span>}
          {hasTimeline && !hasNotes && !hasMinutes && <span className="badge">Ready to write up</span>}
          {!hasTimeline && <span className="badge warn"><IconAlert size={13} aria-hidden />No timeline</span>}
        </div>
      </button>
    </li>
  )
}

// ---- meeting detail (one transcript: read, write notes/minutes, build a doc) -----------------------

function MeetingDetail({ transcript, onBack, busy, setBusy, recordings }: {
  transcript: Recordings['transcripts'][0]
  onBack: () => void
  busy: string
  setBusy: (key: string) => void
  recordings: Poll<Recordings>
}) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const [results, setResults] = useState<Record<string, WrittenResult>>({})
  const [docs, setDocs] = useState<Record<string, BuiltDoc>>({})
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const tools = useAppState().tools
  const timeline = transcript.timeline ?? ''
  const kinds = KINDS.filter((k) => tools.has(k.tool))

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key)
    setError('')
    try { await work() }
    catch (e) { setError(messageOf(e)) }
    finally { setBusy('') }
  }

  const preview = () =>
    run(`preview:${timeline}`, async () => {
      const p = await call<Preview>('meet_ai__preview_notes', { timeline })
      setPreviews((all) => ({ ...all, [timeline]: p }))
    })

  const write = (kind: (typeof KINDS)[number]) =>
    run(`${kind.kind}:${timeline}`, async () => {
      const r = await call<WrittenResult>(kind.tool, { timeline })
      setResults((all) => ({ ...all, [`${kind.kind}:${timeline}`]: r }))
      await recordings.reload()
    })

  const makeDoc = (path: string) =>
    run(`doc:${path}`, async () => {
      const built = await call<BuiltDoc>('docu_ai__build', { path })
      setDocs((all) => ({ ...all, [path]: built }))
    })

  const p = previews[timeline]

  return (
    <div className="panel mt-detail">
      <button type="button" className="mt-back ghost" onClick={onBack}>
        <IconChevron size={16} aria-hidden />
        Meetings
      </button>

      <div className="card">
        <CardHead icon={IconDocuments} tool="meet-ai" title={fileName(transcript.markdown)} />

        <div className="mt-mcard-chips" style={{ marginTop: -4 }}>
          {transcript.notes && <span className="badge ok"><IconCheck size={12} strokeWidth={2.6} aria-hidden />Notes</span>}
          {transcript.minutes && <span className="badge ok"><IconCheck size={12} strokeWidth={2.6} aria-hidden />Minutes</span>}
          {!transcript.notes && !transcript.minutes && transcript.timeline && <span className="badge">Not written up yet</span>}
        </div>

        {tools.has('meet_ai__read_transcript') && (
          <div className="row">
            <button aria-expanded={reading} onClick={() => setReading(!reading)}>
              {reading ? 'Close transcript' : 'Read transcript'}
            </button>
            {timeline && (
              <button disabled={busy === `preview:${timeline}`} onClick={() => void preview()}>
                {busy === `preview:${timeline}` ? 'Counting…' : 'Preview'}
              </button>
            )}
          </div>
        )}

        {reading && <TranscriptReader path={transcript.markdown} />}

        {p && (
          <dl className="mt-figs" style={{ '--n': 3 } as CSSProperties} aria-label="What would be sent to the model">
            <Fig label="Segments" value={p.segments} />
            <Fig label="Words" value={p.words} />
            <Fig label="Tokens (about)" value={p.approx_tokens} />
          </dl>
        )}
      </div>

      {!timeline && (
        <p className="mt-note warn">
          <IconAlert size={16} aria-hidden />
          <span>This transcript has no timeline, so notes and minutes cannot be made from it.</span>
        </p>
      )}

      {timeline && kinds.length > 0 && (
        <div className="mt-outputs">
          {kinds.map((k) => {
            const key = `${k.kind}:${timeline}`
            const r = results[key]
            const path = r?.markdown ?? (k.kind === 'notes' ? transcript.notes : transcript.minutes) ?? ''
            const doc = path ? docs[path] : undefined
            return (
              <div key={k.kind} className="card mt-out">
                <div className="mt-out-head">
                  <h3 className="mt-label">{k.label}</h3>
                  {path
                    ? <span className="badge ok"><IconCheck size={13} strokeWidth={2.6} aria-hidden />written</span>
                    : <span className="badge">not written yet</span>}
                </div>
                {path && <p className="mt-file muted small">{fileName(path)}</p>}

                {r && <Result kind={k.kind} r={r} />}
                {busy === key && (
                  <p className="mt-working" role="status">
                    <IconRefresh size={16} className="mt-spin" aria-hidden />
                    The model reads the transcript, then every point is checked against it.
                  </p>
                )}

                <div className="row">
                  <button className={path ? '' : 'primary'} disabled={busy !== ''} onClick={() => void write(k)}>
                    <IconSpark size={16} aria-hidden />
                    {busy === key ? k.working : path ? 'Write again' : `Write ${k.kind}`}
                  </button>
                  {path && (
                    <button className="primary" disabled={busy !== ''} onClick={() => void makeDoc(path)}>
                      <IconDocuments size={16} aria-hidden />
                      {busy === `doc:${path}` ? 'Building the Doc…' : 'Make a Google Doc'}
                    </button>
                  )}
                </div>

                {doc && (
                  <div className="mt-doc">
                    <span className="navtile" style={{ '--tile': toolColor('docu-ai') } as CSSProperties}>
                      <IconDocuments size={16} strokeWidth={2} aria-hidden />
                    </span>
                    <div>
                      {isWebAddress(doc.url)
                        ? <a href={doc.url} target="_blank" rel="noreferrer">Open "{doc.title}" in Google Docs</a>
                        : <span>"{doc.title}" was built in Google Docs.</span>}
                      {doc.residue.length > 0 && (
                        <p className="mt-note warn">
                          <IconAlert size={16} aria-hidden />
                          <span>markdown residue: {doc.residue.join('; ')}</span>
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="hint">
        Every point carries a quote found word-for-word in the transcript; anything that can't be found is dropped.
        Minutes leave attendance for the secretary — a recording can't show who was present.
      </p>

      {(error || recordings.error) && <Problem>{error || recordings.error}</Problem>}
    </div>
  )
}

// ---- the panel -------------------------------------------------------------------------------------

const HAS_BROWSER_MIC = canRecordInBrowser()

export function Meetings() {
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list')
  const [selected, setSelected] = useState('')
  const [audio, setAudio] = useState('')
  const [last, setLast] = useState<Session | null>(null)
  const [busy, setBusy] = useState('')

  const recording = usePoll(() => call<{ session: Session | null }>('meet_ai__recording_status'), 2000)
  const transcription = usePoll(() => call<{ job: Job | null }>('meet_ai__transcription_status'), 5000)
  const recordings = usePoll(() => call<Recordings>('meet_ai__list_recordings'), 15000)
  const uploads = usePoll(getUploads, 30000)

  const session = recording.data?.session ?? null
  const job = transcription.data?.job ?? null
  const elapsed = useElapsed(session)
  const transcripts = recordings.data?.transcripts ?? []

  const reloadRecordings = recordings.reload
  const reloadUploads = uploads.reload
  const jobState = job?.state
  const before = useRef(jobState)
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    if (before.current === 'running' && jobState && jobState !== 'running') {
      const goDetail = viewRef.current === 'new' && jobState === 'done' && job
      void reloadRecordings().then(() => {
        if (goDetail && job?.timeline) {
          setSelected(job.timeline)
          setView('detail')
        }
      })
    }
    before.current = jobState
  }, [jobState, job, reloadRecordings])

  const stopped = (done: Session) => {
    setLast(done)
    if (done.audio) setAudio(done.audio)
    void reloadRecordings()
  }

  const onBrowserRecorded = useCallback((path: string) => {
    setAudio(path)
    void reloadUploads()
  }, [reloadUploads])

  const selectMeeting = useCallback((timeline: string) => {
    setSelected(timeline)
    setView('detail')
  }, [])

  const goNew = useCallback(() => setView('new'), [])
  const goList = useCallback(() => { setView('list'); setSelected('') }, [])

  const selectedTranscript = transcripts.find((t) => t.timeline === selected)
  const isRecording = session?.state === 'recording'
  const isOrphaned = session?.state === 'orphaned'
  const isTranscribing = job?.state === 'running'
  const reversed = [...transcripts].reverse()

  return (
    <div className="mt" data-view={view}>
      {/* ---- sidebar: meeting list ---- */}
      <div className="mt-sidebar">
        <div className="mt-list-head">
          <button type="button" className="primary mt-new-btn" onClick={goNew}>
            + New
          </button>
        </div>

        {(isRecording || isOrphaned) && (
          <button type="button" className={`mt-mcard ${isRecording ? 'is-live' : 'is-attention'}`} onClick={goNew}>
            <strong className="mt-mcard-title">{isRecording ? 'Recording' : 'Interrupted recording'}</strong>
            <span className="mt-mcard-meta">{isRecording ? clock(elapsed) : `${clock(session?.recorded_seconds)} on disk`}</span>
            <div className="mt-mcard-chips">
              <span className={`badge ${isRecording ? '' : 'warn'}`}>
                {isRecording && <span className="rec-dot" aria-hidden />}
                {isRecording ? 'Recording' : 'Can recover'}
              </span>
            </div>
          </button>
        )}

        {isTranscribing && job && (
          <button type="button" className="mt-mcard is-busy" onClick={goNew}>
            <strong className="mt-mcard-title">{fileName(job.audio)}</strong>
            <span className="mt-mcard-meta">
              Transcribing{job.percent != null ? ` · ${Math.round(job.percent)}%` : ''}
            </span>
            <div className="mt-mcard-chips">
              <span className="badge"><IconActivity size={12} aria-hidden />{job.phase}</span>
            </div>
          </button>
        )}

        {reversed.length > 0 ? (
          <ul className="mt-meetings" role="listbox" aria-label="Meetings">
            {reversed.map((t) => (
              <MeetingCard
                key={t.markdown}
                transcript={t}
                selected={selected === t.timeline}
                onSelect={() => t.timeline ? selectMeeting(t.timeline) : selectMeeting(t.markdown)}
              />
            ))}
          </ul>
        ) : !isRecording && !isOrphaned && !isTranscribing ? (
          <Empty icon={IconMeetings} title="No meetings yet" action={
            <button className="primary mt-big" onClick={goNew}>Record your first meeting</button>
          }>
            Record a meeting or upload audio. Transcribe it, then generate notes, minutes, and a Google Doc.
          </Empty>
        ) : null}
      </div>

      {/* ---- main: detail or new meeting ---- */}
      <div className="mt-main">
        {view === 'new' ? (
          <div className="panel mt-new-flow">
            <button type="button" className="mt-back ghost" onClick={goList}>
              <IconChevron size={16} aria-hidden />
              Meetings
            </button>

            {HAS_BROWSER_MIC
              ? <BrowserRec onRecorded={onBrowserRecorded} />
              : <Recorder status={recording} elapsed={elapsed} last={last} setLast={setLast} onStopped={stopped} />}

            {!isRecording && (
              <>
                <div className="mt-or"><span>or</span></div>
                <Transcriber
                  job={job}
                  status={transcription}
                  recordings={recordings}
                  uploads={uploads}
                  audio={audio}
                  setAudio={setAudio}
                  onWriteUp={selectMeeting}
                />
              </>
            )}
          </div>
        ) : view === 'detail' && selectedTranscript ? (
          <MeetingDetail
            key={selected}
            transcript={selectedTranscript}
            onBack={goList}
            busy={busy}
            setBusy={setBusy}
            recordings={recordings}
          />
        ) : view === 'detail' && !selectedTranscript ? (
          <div className="panel mt-detail">
            <button type="button" className="mt-back ghost" onClick={goList}>
              <IconChevron size={16} aria-hidden />
              Meetings
            </button>
            <div className="mt-empty-main" aria-busy="true">
              <p className="muted">Loading…</p>
              <div className="skeleton" style={{ height: 120 }} />
            </div>
          </div>
        ) : (
          <div className="mt-empty-main">
            <Empty icon={IconMeetings} title="Select a meeting">
              Choose one from the list, or start a new one.
            </Empty>
          </div>
        )}
      </div>
    </div>
  )
}
