// Chat: the same conversation the buttons see, in a calmer frame. Tool calls collapse into chips
// between messages, an approval waiting on you is impossible to miss, and an empty page offers things
// to ask instead of a blank box.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AUDIO_EXTS, isAudio, isMarkdown, sendChat, splitDocs, toolLabel, uploadAudio, uploadDocs, type AssistantEvent } from '../api'
import { useAppState } from '../state'
import { BrandMark } from '../ui/Shell'
import { DropZone } from '../ui/DropZone'
import { IconAttach, IconCheck, IconClose, IconCopy, IconSend, IconSpark } from '../ui/icons'
import { PickFiles, UploadProgress } from './Upload'
import { ApprovalCard } from './ApprovalCard'
import '../styles/panels/chat.css'

const SUGGESTIONS = [
  'What is in my inbox?',
  'What is running right now?',
  'Write up my latest meeting as a Google Doc',
  'Turn my newest PDF into an audiobook',
]

function ToolChip({ event }: { event: AssistantEvent }) {
  const fromButton = event.origin === 'button'
  const outcome = event.outcome ?? 'ok'
  return (
    <span className={`tool-line ${outcome}`}>
      <span className="tool-mark" aria-hidden>
        {outcome === 'ok' ? <IconCheck size={12} strokeWidth={3} /> : outcome === 'declined' ? <span>–</span> : <IconClose size={12} strokeWidth={3} />}
      </span>
      {fromButton && <span className="muted">You pressed</span>}
      <span className="tool-name">{toolLabel(event.tool)}</span>
      {outcome === 'declined' && <span className="muted">declined</span>}
      {outcome === 'failed' && <span className="muted">failed</span>}
    </span>
  )
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="ghost copy"
      aria-label={done ? 'Copied' : 'Copy this reply'}
      title={done ? 'Copied' : 'Copy'}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => { setDone(true); window.setTimeout(() => setDone(false), 1600) },
          () => {}, // refused (an insecure page, an older browser): nothing to do, the text is selectable
        )
      }}
    >
      {done ? <IconCheck size={14} aria-hidden /> : <IconCopy size={14} aria-hidden />}
    </button>
  )
}

export function Chat() {
  const { events, pending, busy, connected } = useAppState()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [attached, setAttached] = useState<string[]>([])
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  // An attachment is an upload like any other: the server tells the model about it with the
  // next message, so "transcribe this" or "make this a Doc" needs no path typed out.
  const attach = async (files: File[]) => {
    setError('')
    const audio = files.filter((f) => isAudio(f.name))
    const docs = files.filter((f) => isMarkdown(f.name))
    const other = files.filter((f) => !isAudio(f.name) && !isMarkdown(f.name))
    if (other.length) setError(`Not attached — only audio or markdown: ${other.map((f) => f.name).join(', ')}`)
    try {
      for (const f of audio) {
        setUploading({ name: f.name, fraction: 0 })
        const saved = await uploadAudio(f, (fraction) => setUploading({ name: f.name, fraction }))
        setAttached((a) => [...a, saved.name])
      }
      if (docs.length) {
        const { top, name } = splitDocs(docs)
        setUploading({ name, fraction: 0 })
        const saved = await uploadDocs(top, name, (fraction) => setUploading({ name, fraction }))
        setAttached((a) => [...a, ...saved.files])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(null)
    }
  }

  // Follow the conversation while you are at the bottom; leave you alone if you scrolled up to read.
  useEffect(() => {
    if (atBottom) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length, pending.length, busy, atBottom])

  useEffect(() => {
    const el = bottom.current
    const root = scroller.current
    if (!el || !root) return
    const watch = new IntersectionObserver(([entry]) => setAtBottom(entry?.isIntersecting ?? true), { root, threshold: 0.9 })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const message = draft.trim()
    if (!message || busy) return
    setError('')
    try {
      await sendChat(message)
      setDraft('')
      setAttached([])
      setAtBottom(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  // Consecutive tool calls read as one cluster of chips, not a column of rows.
  const rows: ReactNode[] = []
  let cluster: AssistantEvent[] = []
  const flush = (key: string) => {
    if (cluster.length) rows.push(<div className="tool-cluster" key={key}>{cluster.map((e) => <ToolChip key={e.seq} event={e} />)}</div>)
    cluster = []
  }
  for (const event of events) {
    switch (event.type) {
      case 'tool_finished':
        // Read-only button presses are status polls; they would flood the transcript.
        if (event.origin === 'button' && event.read_only) break
        cluster.push(event)
        break
      case 'user_message':
        flush(`c${event.seq}`)
        rows.push(<div key={event.seq} className="bubble user">{event.text}</div>)
        break
      case 'assistant_text':
        flush(`c${event.seq}`)
        rows.push(
          <div key={event.seq} className="msg assistant-msg">
            <span className="avatar" aria-hidden><BrandMark size={26} /></span>
            <div className="bubble assistant">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text ?? ''}</ReactMarkdown>
              <Copy text={event.text ?? ''} />
            </div>
          </div>,
        )
        break
      case 'approval_needed': {
        flush(`c${event.seq}`)
        const live = pending.find((p) => p.id === event.id)
        if (live) rows.push(<ApprovalCard key={event.seq} approval={live} />)
        break
      }
      case 'turn_error':
        flush(`c${event.seq}`)
        rows.push(<div key={event.seq} className="chat-error" role="alert">Something went wrong: {event.error}</div>)
        break
      default:
        break
    }
  }
  flush('end')

  const typeSuggestion = (text: string) => {
    setDraft(text)
    field.current?.focus()
  }

  return (
    <DropZone
      className="chat"
      accepts={(f) => isAudio(f.name) || isMarkdown(f.name)}
      label="Drop audio or markdown to attach"
      onRefuse={(names) => setError(`Not attached — only audio or markdown: ${names.join(', ')}`)}
      onFiles={(files) => void attach(files)}
      disabled={!connected || uploading !== null}
    >
      <h1 className="sr-only">Chat</h1>
      <div className="transcript" aria-live="polite" ref={scroller}>
        {/* Empty means nothing to show, not no events: a background notice is an event too. */}
        {rows.length === 0 && !busy && pending.length === 0 && (
          <div className="chat-empty">
            <BrandMark size={48} />
            <h2>What can I do for you?</h2>
            <p className="muted">Ask in your own words. Anything that changes something asks you first.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => typeSuggestion(s)}><IconSpark size={14} aria-hidden />{s}</button>
              ))}
            </div>
          </div>
        )}

        {rows}

        {busy && pending.length === 0 && (
          <div className="msg assistant-msg">
            <span className="avatar working" aria-hidden><BrandMark size={26} /></span>
            <div className="thinking" role="status" aria-label="Working"><i /><i /><i /></div>
          </div>
        )}
        {pending
          .filter((p) => !events.some((e) => e.type === 'approval_needed' && e.id === p.id))
          .map((p) => <ApprovalCard key={p.id} approval={p} />)}
        <div ref={bottom} className="chat-end" />
      </div>

      {!atBottom && (
        <button className="to-latest" onClick={() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}>
          Jump to latest
        </button>
      )}

      {(attached.length > 0 || uploading) && (
        <div className="attachments">
          {attached.map((name, i) => <span key={`${name}-${i}`} className="chip"><IconAttach size={13} aria-hidden />{name}</span>)}
          {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
        </div>
      )}

      <form className="composer" onSubmit={(e) => void submit(e)}>
        <PickFiles
          label=""
          ariaLabel="Attach a recording or a markdown file"
          icon={<IconAttach size={18} aria-hidden />}
          accept={[...AUDIO_EXTS, '.md'].join(',') + ',audio/*'}
          multiple
          disabled={!connected || uploading !== null}
          onPick={(files) => void attach(files)}
          className="ghost attach"
        />
        <textarea
          ref={field}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={!connected ? 'Reconnecting…' : busy ? 'Working on the last message…' : 'Message the assistant'}
          disabled={!connected}
          rows={1}
          aria-label="Message"
        />
        <button className="primary send" type="submit" disabled={busy || !draft.trim() || !connected} aria-label="Send">
          <IconSend size={18} aria-hidden />
        </button>
      </form>
      <p className="composer-hint muted small">Enter to send · Shift+Enter for a new line · drop a recording or a markdown file to attach it</p>
      {error && <p className="error composer-error">{error}</p>}
    </DropZone>
  )
}
