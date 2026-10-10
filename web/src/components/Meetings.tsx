// Meetings, as one flow: Record, Transcribe, Write up. The same tools the model calls in chat, called
// directly -- no model, no waiting on one. A strip across the top says where the flow stands, read
// from the real status of each step (never guessed), and each step jumps to its card.
//
// The polls live here, in one place, because the strip and the cards read the same answers: the
// recorder every 2 s, the transcription job every 5 s, the list of recordings every 15 s.

import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { AUDIO_EXTS, getUploads, isAudio, uploadAudio, type Uploads } from '../api'
import { call } from '../call'
import { toolColor } from '../charts/palette'
import { Ring } from '../charts/Ring'
import { ShareBar } from '../charts/ShareBar'
import { useCountUp } from '../charts/useWidth'
import { useAppState } from '../state'
import { CardHead } from '../ui/CardHead'
import { DropZone } from '../ui/DropZone'
import { Empty } from '../ui/Empty'
import {
  IconActivity, IconAlert, IconCheck, IconChevron, IconDocuments, IconFail, IconMeetings, IconOk,
  IconRefresh, IconSearch, IconSpark, IconStop, IconUpload,
} from '../ui/icons'
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

type Icon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>

export { call }

const IDS = { record: 'meet-record', transcribe: 'meet-transcribe', write: 'meet-write' } as const
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Bring a card into view and put the keyboard there. Instant for people who asked for less motion. */
function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

/** A link from a tool's output becomes a link only if it is a web address; anything else stays text. */
const isWebAddress = (url: string) => /^https?:\/\//i.test(url)

/** A problem, in words, with an icon: colour is never the only thing saying so. */
function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="mt-note error" role="alert">
      <IconFail size={16} aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** One labelled number. A number counts up to its value; a piece of text (a clock, a level) is shown as it is. */
function Fig({ label, value }: { label: string; value: number | string }) {
  const shown = useCountUp(typeof value === 'number' ? value : 0, 600)
  return (
    <div>
      <dt>{label}</dt>
      <dd>{typeof value === 'number' ? Math.round(shown).toLocaleString() : value}</dd>
    </div>
  )
}

// ---- the flow strip --------------------------------------------------------------------------------

type StepState = 'idle' | 'ready' | 'running' | 'done' | 'attention'

interface Step {
  id: string
  label: string
  icon: Icon
  state: StepState
  note: string
  target: string
}

interface FlowInput {
  session: Session | null
  recorderUnreachable: boolean
  elapsed: number
  last: Session | null
  job: Job | null
  audio: string
  transcripts: Recordings['transcripts']
  busy: string
}

/** Where each step stands, from what the tools reported. Nothing here is a guess. */
function flowSteps({ session, recorderUnreachable, elapsed, last, job, audio, transcripts, busy }: FlowInput): Step[] {
  const record: Pick<Step, 'state' | 'note'> =
    session?.state === 'recording' ? { state: 'running', note: `Recording · ${clock(elapsed)}` }
    : session?.state === 'orphaned' ? { state: 'attention', note: 'Interrupted · can recover' }
    : last ? { state: 'done', note: `Saved · ${clock(last.duration_seconds)}` }
    : recorderUnreachable ? { state: 'attention', note: 'Recorder not answering' }
    : { state: 'ready', note: 'Ready to record' }

  const chosen = audio.trim()
  const ofThisJob = job !== null && (chosen === '' || job.audio === chosen)
  const transcribe: Pick<Step, 'state' | 'note'> =
    job?.state === 'running' ? { state: 'running', note: `Transcribing${job.percent != null ? ` · ${Math.round(job.percent)}%` : ''}` }
    : ofThisJob && job?.state === 'failed' ? { state: 'attention', note: 'Failed' }
    : ofThisJob && job?.state === 'interrupted' ? { state: 'attention', note: 'Interrupted' }
    : ofThisJob && job?.state === 'done' ? { state: 'done', note: 'Transcript ready' }
    : chosen ? { state: 'ready', note: 'Audio chosen' }
    : { state: 'idle', note: 'Choose audio' }

  const ready = transcripts.filter((t) => t.timeline)
  const written = ready.filter((t) => t.notes || t.minutes).length
  const write: Pick<Step, 'state' | 'note'> =
    busy.startsWith('notes:') ? { state: 'running', note: 'Writing notes…' }
    : busy.startsWith('minutes:') ? { state: 'running', note: 'Writing minutes…' }
    : busy.startsWith('doc:') ? { state: 'running', note: 'Building the Doc…' }
    : ready.length === 0 ? { state: 'idle', note: 'Needs a transcript' }
    : written === ready.length ? { state: 'done', note: `${written} of ${ready.length} written up` }
    : { state: 'ready', note: `${written} of ${ready.length} written up` }

  return [
    { id: 'record', label: 'Record', icon: IconMeetings, target: IDS.record, ...record },
    { id: 'transcribe', label: 'Transcribe', icon: IconActivity, target: IDS.transcribe, ...transcribe },
    { id: 'write', label: 'Write up', icon: IconSpark, target: IDS.write, ...write },
  ]
}

function Flow({ steps }: { steps: Step[] }) {
  return (
    <nav className="mt-flow" aria-label="Record, transcribe, write up">
      <ol>
        {steps.map((s, i) => (
          <li key={s.id} className={`mt-step is-${s.state}`}>
            <button type="button" onClick={() => jumpTo(s.target)} aria-current={s.state === 'running' ? 'step' : undefined}>
              <span className="mt-mark" aria-hidden>
                {s.state === 'done' ? <IconCheck size={17} strokeWidth={2.6} />
                  : s.state === 'attention' ? <IconAlert size={17} />
                  : s.state === 'running' ? <s.icon size={16} strokeWidth={2.2} />
                  : i + 1}
              </span>
              <span className="mt-step-text">
                <b><span className="sr-only">Step {i + 1}: </span>{s.label}</b>
                <span>{s.note}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

// ---- record ------------------------------------------------------------------------------------------

/** The recorder reports its clock every two seconds. Between reports the clock keeps counting from the
 * last one, so the hero moves a second at a time; each report corrects it, and it never runs backwards. */
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

// ---- transcribe --------------------------------------------------------------------------------------

function Transcriber({ job, status, recordings, uploads, audio, setAudio }: {
  job: Job | null
  status: Poll<{ job: Job | null }>
  recordings: Poll<Recordings>
  uploads: Poll<Uploads>
  audio: string
  setAudio: (a: string) => void
}) {
  const [speakers, setSpeakers] = useState(false)
  const [count, setCount] = useState(4)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const running = job?.state === 'running'

  // An uploaded file is a path like any recording: it lands in the box, ready to transcribe.
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

  // What can be picked in one tap: uploads (newest first), then recordings. Recording names are
  // timestamps and the list is sorted, so its last entries are the newest.
  const choices = [
    ...[...(uploads.data?.audio ?? [])].sort((a, b) => b.at - a.at).map((a) => ({ path: a.path, label: a.name, uploaded: true })),
    ...[...(recordings.data?.audio ?? [])].reverse().map((p) => ({ path: p, label: fileName(p), uploaded: false })),
  ]
  const shown = choices.slice(0, 6)
  const chosen = audio.trim()
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
                <button type="button" onClick={() => jumpTo(IDS.write)}>
                  Write it up
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
                  <p className="hint">{choices.length - shown.length} more in the file box’s list.</p>
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
      </DropZone>
    </section>
  )
}

// ---- write up ----------------------------------------------------------------------------------------

interface Preview { segments: number; words: number; approx_tokens: number }

// Notes and minutes are two outputs of one transcript, made the same way: a model writes,
// every point is checked against the transcript, and docu-ai compiles the file on its own
// -- meet-ai never learns docu-ai exists.
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

/** A count a tool returned, or null: a number that is not there is left out, never shown as 0. */
function counted(output: Record<string, unknown>, key: string): number | null {
  const n = output[key]
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** What a write returned, as figures: how many points held up against the transcript and how many did not,
 * and the counts the tool reported. Only what came back is shown. */
function Result({ kind, r }: { kind: Kind; r: WrittenResult }) {
  const verified = counted(r, 'verified_claims')
  const dropped = counted(r, 'dropped_claims')
  const noun = kind === 'minutes' ? 'points' : 'claims'
  const title = typeof r.title === 'string' && r.title ? r.title : ''
  const items = Array.isArray(r.items) ? r.items.filter((i): i is string => typeof i === 'string') : []
  // The counts a set of notes reports. Minutes report their agenda as a list, shown below.
  const figs: { label: string; value: number }[] = kind === 'minutes'
    ? []
    : [['Decisions', 'decisions'], ['Actions', 'actions'], ['Questions', 'questions']].flatMap(([label, key]) => {
        const value = counted(r, key as string)
        return value === null ? [] : [{ label: label as string, value }]
      })

  return (
    <div className="mt-result">
      {kind === 'minutes' && title && <p className="mt-result-title">“{title}”</p>}
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

interface TranscriptText { text: string; truncated: boolean; end: number; duration: number }

/** The transcript itself, to check a line against. A read-only call, so it is neither
 * audited nor noted for the model -- looking is not acting. */
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
          {shown.length === 0 && needle && <p className="muted">No paragraph mentions “{query.trim()}”.</p>}
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

function WriteUp({ recordings, busy, setBusy }: {
  recordings: Poll<Recordings>
  busy: string
  setBusy: (key: string) => void
}) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const [results, setResults] = useState<Record<string, WrittenResult>>({})
  const [docs, setDocs] = useState<Record<string, BuiltDoc>>({})
  const [error, setError] = useState('')
  const [reading, setReading] = useState('')
  const tools = useAppState().tools

  const ready = recordings.data?.transcripts.filter((t) => t.timeline) ?? []
  const withoutTimeline = (recordings.data?.transcripts.length ?? 0) - ready.length
  const kinds = KINDS.filter((k) => tools.has(k.tool))

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy('')
    }
  }

  const preview = (timeline: string) =>
    run(`preview:${timeline}`, async () => {
      const p = await call<Preview>('meet_ai__preview_notes', { timeline })
      setPreviews((all) => ({ ...all, [timeline]: p }))
    })

  const write = (kind: (typeof KINDS)[number], timeline: string) =>
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

  return (
    <section id={IDS.write} className="mt-slot" tabIndex={-1} aria-label="Notes and minutes">
      <div className="card">
        <CardHead icon={IconSpark} tool="meet-ai" title="Notes and minutes" sub="Written from a transcript; every point must be found in it word for word." />

        {recordings.data === null && !recordings.error && (
          <div className="mt-loading" aria-busy="true">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        )}
        {recordings.data !== null && ready.length === 0 && (
          <Empty icon={IconDocuments} title="Nothing to write up yet">
            No transcripts with a timeline yet. Transcribe a recording first.
          </Empty>
        )}

        {ready.length > 0 && (
          <ul className="mt-transcripts">
            {ready.map((t) => {
              const timeline = t.timeline ?? ''
              const p = previews[timeline]
              const open = reading === t.markdown
              const paths = KINDS.map((k) => results[`${k.kind}:${timeline}`]?.markdown ?? (k.kind === 'notes' ? t.notes : t.minutes) ?? '')
              return (
                <li key={timeline} className="mt-tr">
                  <div className="mt-tr-head">
                    <span className="navtile" style={{ '--tile': toolColor('meet-ai') } as CSSProperties}>
                      <IconDocuments size={17} strokeWidth={2} aria-hidden />
                    </span>
                    <div className="mt-tr-title">
                      <strong className="mt-file">{fileName(t.markdown)}</strong>
                      <span className="mt-tr-badges">
                        {KINDS.map((k, i) => paths[i] && (
                          <span key={k.kind} className="badge ok"><IconCheck size={13} strokeWidth={2.6} aria-hidden />{k.label} written</span>
                        ))}
                      </span>
                    </div>
                    <div className="row mt-tr-actions">
                      {tools.has('meet_ai__read_transcript') && (
                        <button aria-expanded={open} onClick={() => setReading(open ? '' : t.markdown)}>
                          {open ? 'Close transcript' : 'Read transcript'}
                        </button>
                      )}
                      <button disabled={busy === `preview:${timeline}`} onClick={() => void preview(timeline)}>
                        {busy === `preview:${timeline}` ? 'Counting…' : 'Preview'}
                      </button>
                    </div>
                  </div>

                  {open && <TranscriptReader path={t.markdown} />}
                  {p && (
                    <dl className="mt-figs" style={{ '--n': 3 } as CSSProperties} aria-label="What would be sent to the model">
                      <Fig label="Segments" value={p.segments} />
                      <Fig label="Words" value={p.words} />
                      <Fig label="Tokens to send (about)" value={p.approx_tokens} />
                    </dl>
                  )}

                  {kinds.length > 0 && (
                    <div className="mt-outputs">
                      {kinds.map((k) => {
                        const key = `${k.kind}:${timeline}`
                        const r = results[key]
                        const path = r?.markdown ?? (k.kind === 'notes' ? t.notes : t.minutes) ?? ''
                        const doc = path ? docs[path] : undefined
                        return (
                          <div key={k.kind} className="mt-out">
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
                              <button className={path ? '' : 'primary'} disabled={busy !== ''} onClick={() => void write(k, timeline)}>
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
                                    ? <a href={doc.url} target="_blank" rel="noreferrer">Open “{doc.title}” in Google Docs</a>
                                    : <span>“{doc.title}” was built in Google Docs.</span>}
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
                </li>
              )
            })}
          </ul>
        )}

        {withoutTimeline > 0 && ready.length > 0 && (
          <p className="hint">
            {withoutTimeline} more transcript{withoutTimeline === 1 ? ' has' : 's have'} no timeline, so notes cannot be made from {withoutTimeline === 1 ? 'it' : 'them'}.
          </p>
        )}
        {(error || recordings.error) && <Problem>{error || recordings.error}</Problem>}
        <p className="hint">
          Every point carries a quote found word-for-word in the transcript; anything that can't be found is dropped.
          Minutes leave attendance for the secretary — a recording can't show who was present.
        </p>
      </div>
    </section>
  )
}

// ---- the panel -------------------------------------------------------------------------------------

export function Meetings() {
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

  // A transcription that has just finished has just made a transcript: look again now, not at the next poll.
  const reloadRecordings = recordings.reload
  const jobState = job?.state
  const before = useRef(jobState)
  useEffect(() => {
    if (before.current === 'running' && jobState && jobState !== 'running') void reloadRecordings()
    before.current = jobState
  }, [jobState, reloadRecordings])

  // Stopping hands the saved audio to the Transcribe box, and the new file joins the list.
  const stopped = (done: Session) => {
    setLast(done)
    if (done.audio) setAudio(done.audio)
    void reloadRecordings()
  }

  const steps = flowSteps({
    session,
    recorderUnreachable: recording.data === null && recording.error !== '',
    elapsed,
    last,
    job,
    audio,
    transcripts: recordings.data?.transcripts ?? [],
    busy,
  })

  return (
    <div className="grid-2 mt stagger">
      <div className="mt-top" style={{ '--i': 0 } as CSSProperties}>
        <Flow steps={steps} />
      </div>
      <div className="mt-cell" style={{ '--i': 1 } as CSSProperties}>
        <Recorder status={recording} elapsed={elapsed} last={last} setLast={setLast} onStopped={stopped} />
      </div>
      <div className="mt-cell" style={{ '--i': 2 } as CSSProperties}>
        <Transcriber job={job} status={transcription} recordings={recordings} uploads={uploads} audio={audio} setAudio={setAudio} />
      </div>
      <div className="mt-cell mt-wide" style={{ '--i': 3 } as CSSProperties}>
        <WriteUp recordings={recordings} busy={busy} setBusy={setBusy} />
      </div>
    </div>
  )
}
