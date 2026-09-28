import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AUDIO_EXTS, isAudio, isMarkdown, sendChat, splitDocs, toolLabel, uploadAudio, uploadDocs, type AssistantEvent } from '../api'
import { PickFiles, UploadProgress } from './Upload'
import { useAppState } from '../state'
import { ApprovalCard } from './ApprovalCard'

function ToolLine({ event }: { event: AssistantEvent }) {
  const fromButton = event.origin === 'button'
  const mark = event.outcome === 'ok' ? '✓' : event.outcome === 'declined' ? '–' : '✕'
  return (
    <div className={`tool-line ${event.outcome ?? ''}`}>
      <span className="tool-mark" aria-hidden>{mark}</span>
      {fromButton ? 'You pressed ' : ''}
      <span className="tool-name">{toolLabel(event.tool)}</span>
      {event.outcome === 'declined' && <span className="muted"> — declined</span>}
      {event.outcome === 'failed' && <span className="muted"> — failed</span>}
    </div>
  )
}

export function Chat() {
  const { events, pending, busy, connected } = useAppState()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [attached, setAttached] = useState<string[]>([])
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length, pending.length])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const message = draft.trim()
    if (!message || busy) return
    setError('')
    try {
      await sendChat(message)
      setDraft('')
      setAttached([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <section className="chat">
      <div className="transcript" aria-live="polite">
        {events.length === 0 && (
          <div className="empty">
            <p>Ask for anything the tools can do.</p>
            <p className="muted">"Record this meeting." · "What's in my inbox?" · "Write up yesterday's meeting as a Doc."</p>
          </div>
        )}

        {events.map((event) => {
          switch (event.type) {
            case 'user_message':
              return <div key={event.seq} className="bubble user">{event.text}</div>
            case 'assistant_text':
              return (
                <div key={event.seq} className="bubble assistant">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text ?? ''}</ReactMarkdown>
                </div>
              )
            case 'tool_finished':
              // Read-only button presses are status polls; they would flood the transcript.
              if (event.origin === 'button' && event.read_only) return null
              return <ToolLine key={event.seq} event={event} />
            case 'approval_needed': {
              const live = pending.find((p) => p.id === event.id)
              return live ? <ApprovalCard key={event.seq} approval={live} /> : null
            }
            case 'turn_error':
              return <div key={event.seq} className="error">Something went wrong: {event.error}</div>
            default:
              return null
          }
        })}

        {busy && pending.length === 0 && <div className="thinking">Working…</div>}
        {pending
          .filter((p) => !events.some((e) => e.type === 'approval_needed' && e.id === p.id))
          .map((p) => <ApprovalCard key={p.id} approval={p} />)}
        <div ref={bottom} />
      </div>

      {(attached.length > 0 || uploading) && (
        <div className="attachments">
          {attached.map((name, i) => <span key={`${name}-${i}`} className="chip">📎 {name}</span>)}
          {uploading && <UploadProgress name={uploading.name} fraction={uploading.fraction} />}
        </div>
      )}
      <form className="composer" onSubmit={(e) => void submit(e)}>
        <PickFiles
          label="Attach"
          accept={[...AUDIO_EXTS, '.md'].join(',') + ',audio/*'}
          multiple
          disabled={!connected || uploading !== null}
          onPick={(files) => void attach(files)}
          className="attach"
        />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={busy ? 'Working on the last message…' : 'Message the assistant'}
          disabled={!connected}
          rows={2}
          aria-label="Message"
        />
        <button className="primary" type="submit" disabled={busy || !draft.trim() || !connected}>
          Send
        </button>
      </form>
      {error && <p className="error composer-error">{error}</p>}
    </section>
  )
}

