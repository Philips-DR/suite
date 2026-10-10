// Buttons for mail. Reading, searching and syncing always; drafting and sending only when
// mail-ai has been given them -- the page asks the server what exists rather than assuming.
//
// A list on the left and the conversation on the right; on a phone the list comes first and a
// conversation takes the whole screen, with a Back button. Replying is a short, visible ladder:
// write, save as a draft in Gmail, then review the whole email and confirm. Nothing is sent until
// the second press, and that press is only offered after the full email has been shown.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { runAction } from '../api'
import { call } from '../call'
import { toolColor } from '../charts/palette'
import { Sparkline } from '../charts/Sparkline'
import { useAppState } from '../state'
import { Empty } from '../ui/Empty'
import { IconAlert, IconBack, IconCheck, IconMail, IconOk, IconRefresh, IconSearch, IconSend } from '../ui/icons'
import { ago } from '../ui/time'
import { usePoll } from '../usePoll'
import '../styles/panels/mail.css'

interface Status { messages: number; threads: number; newest: string; full_sync_complete: boolean }
interface Thread { thread_id: string; subject: string; started_by: string; messages: number; last: string }
interface Message { id: string; from: string; to: string; at: string; body: string }
interface ThreadDetail { thread_id: string; subject: string; messages: Message[] }
interface Draft { draft_id: string; to: string; subject: string; thread_id: string; confirmation: string }
interface Found { id: string; thread_id: string; from_addr: string; subject: string; at: string }

/** One line in the list: a thread, or a message a search found. */
interface Item { id: string; title: string; from: string; count: number; when: string }

const LIST = 40
const DAY = 86_400_000

const when = (iso: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '')
const who = (address: string) => address.replace(/<.*>/, '').replace(/"/g, '').trim() || address

/** "3 h ago" for the last week, then a date: the way a mail list reads. */
function short(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  if (Date.now() - t.getTime() < 7 * DAY) return ago(t)
  const sameYear = t.getFullYear() === new Date().getFullYear()
  return t.toLocaleDateString([], { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

const initial = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
const tintOf = (name: string) => [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 4

/** A sender as a small circle with their initial: a neutral tint from the name, so a person keeps theirs. */
function Avatar({ name }: { name: string }) {
  return <span className="mbox-avatar" data-tint={tintOf(name)} aria-hidden>{initial(name)}</span>
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Conversations by the day of their last message, ending at the newest one listed: the shape of what the list holds. */
function volumeOf(threads: Thread[]): { values: number[]; from: Date; to: Date } | null {
  const stamps = threads.map((t) => new Date(t.last)).filter((d) => !Number.isNaN(d.getTime()))
  if (stamps.length < 5) return null
  const newest = Math.max(...stamps.map((d) => d.getTime()))
  const oldest = Math.min(...stamps.map((d) => d.getTime()))
  const span = Math.round((dayStart(new Date(newest)) - dayStart(new Date(oldest))) / DAY) + 1
  const n = Math.min(30, span)
  if (n < 3) return null // fewer than three days say nothing about a shape
  const last = dayStart(new Date(newest))
  const values = Array.from({ length: n }, () => 0)
  for (const d of stamps) {
    const i = n - 1 - Math.round((last - dayStart(d)) / DAY)
    if (i >= 0 && i < n) values[i] = (values[i] ?? 0) + 1
  }
  return { values, from: new Date(last - (n - 1) * DAY), to: new Date(last) }
}

const dayLabel = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' })

// ---- one email body: text only, folded when it is long -------------------------------------------------

function Body({ text }: { text: string }) {
  const long = text.length > 1400 || text.split('\n').length > 20
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mbox-body">
      {/* Email written by someone else: text only, never markup. */}
      <pre className={long && !expanded ? 'is-folded' : ''}>{text || '(no text)'}</pre>
      {long && (
        <button className="ghost" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Show less' : 'Show the whole message'}
        </button>
      )}
    </div>
  )
}

// ---- the last step: the whole email, then one deliberate press ---------------------------------------

/** Sending is the one thing here that cannot be undone, so it is shown in full first. */
function SendConfirm({ preview, to, onSend, onCancel, sending }: {
  preview: string | null; to: string; onSend: () => void; onCancel: () => void; sending: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.focus({ preventScroll: true })
    box.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  return (
    <div
      ref={box}
      className="mbox-confirm"
      role="group"
      aria-labelledby="mbox-confirm-title"
      aria-describedby="mbox-confirm-warning"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape' && !sending) onCancel() }}
    >
      <div className="mbox-confirm-head">
        <span className="mbox-confirm-kicker" id="mbox-confirm-title"><IconSend size={15} aria-hidden />This will send</span>
        <span className="mbox-confirm-sub">and cannot be undone</span>
      </div>
      <p className="mbox-confirm-to">To <b>{to}</b></p>
      {preview
        ? <pre className="mbox-preview">{preview}</pre>
        : <p className="approval-warning">The email could not be shown. Sending means sending it unseen.</p>}
      <p className="mbox-confirm-warning" id="mbox-confirm-warning"><IconAlert size={16} aria-hidden />Sending cannot be undone. Check who it goes to and what it says.</p>
      <div className="mbox-confirm-actions">
        <button className="primary" disabled={sending} onClick={onSend}><IconSend size={16} aria-hidden />{sending ? 'Sending…' : 'Send'}</button>
        <button disabled={sending} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

type Note = { text: string; at: 'top' | 'reply' }

export function Mail() {
  const { tools } = useAppState()
  const canDraft = tools.has('mail_ai__draft_reply') && tools.has('mail_ai__send_draft')

  const status = usePoll(() => call<Status>('mail_ai__status'), 30000)
  const threads = usePoll(() => call<{ threads: Thread[] }>('mail_ai__list_threads', { limit: LIST }), 30000)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [found, setFound] = useState<Found[] | null>(null)
  const [open, setOpen] = useState<ThreadDetail | null>(null)
  const [view, setView] = useState<'list' | 'thread'>('list') // matters only where the two cannot sit side by side
  const [opening, setOpening] = useState('')
  const [reply, setReply] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirming, setConfirming] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Note | null>(null)
  const [error, setError] = useState<Note | null>(null)

  const listCard = useRef<HTMLElement>(null)
  const threadCard = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const requested = useRef('') // the thread asked for last: an earlier, slower answer must not replace it
  const sendLock = useRef(false) // one send in flight, however fast the presses

  const act = async (label: string, fn: () => Promise<void>) => {
    if (label === 'send') {
      if (sendLock.current) return
      sendLock.current = true
    }
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), at: ['draft', 'send', 'discard'].includes(label) ? 'reply' : 'top' })
    } finally {
      if (label === 'send') sendLock.current = false
      setBusy('')
    }
  }

  const sync = () => act('sync', async () => {
    const r = await call<{ added: number; mode: string }>('mail_ai__sync')
    setNotice({ text: `${r.added} new message${r.added === 1 ? '' : 's'}`, at: 'top' })
    await Promise.all([status.reload(), threads.reload()])
  })

  const search = () => act('search', async () => {
    if (!query.trim()) { setFound(null); return }
    setFound((await call<{ messages: Found[] }>('mail_ai__search', { text: query.trim() })).messages)
    setSearched(query.trim())
  })

  const openThread = (id: string) => act('open', async () => {
    requested.current = id
    setOpening(id)
    try {
      const detail = await call<ThreadDetail>('mail_ai__read_thread', { thread_id: id })
      if (requested.current !== id) return
      setOpen(detail)
      setView('thread')
      setReply(''); setDraft(null); setConfirming(undefined); setNotice(null)
    } finally {
      setOpening((now) => (now === id ? '' : now))
    }
  })

  const select = (id: string) => {
    if (open?.thread_id === id) { setView('thread'); return } // coming back to the one already open keeps its reply
    void openThread(id)
  }

  const back = () => {
    setView('list')
    requestAnimationFrame(() => listCard.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus())
  }

  const makeDraft = () => act('draft', async () => {
    if (!open) return
    setDraft(await call<Draft>('mail_ai__draft_reply', { thread_id: open.thread_id, body: reply.trim() }))
    setNotice({ text: 'Draft saved in Gmail. Nothing has been sent.', at: 'reply' })
  })

  // First press: the server returns the rendered email instead of sending.
  const askSend = () => act('send', async () => {
    if (!draft) return
    const r = await runAction('mail_ai__send_draft', { draft_id: draft.draft_id, confirmation: draft.confirmation })
    setConfirming(r.needs_confirmation ? (r.preview ?? null) : null)
  })

  // Second, confirmed press: the gate re-checks the draft still says what was shown.
  const send = () => act('send', async () => {
    if (!draft) return
    const r = await runAction<{ error?: string }>('mail_ai__send_draft',
      { draft_id: draft.draft_id, confirmation: draft.confirmation }, true)
    if (r.output && typeof r.output === 'object' && 'error' in r.output && r.output.error) throw new Error(String(r.output.error))
    setConfirming(undefined); setDraft(null); setReply('')
    setNotice({ text: 'Sent.', at: 'reply' })
  })

  const discard = () => act('discard', async () => {
    if (!draft) return
    await call('mail_ai__discard_draft', { draft_id: draft.draft_id })
    setDraft(null); setNotice({ text: 'Draft discarded.', at: 'reply' })
  })

  // Where the two panes cannot sit side by side, opening a conversation brings it to the top and into focus.
  useEffect(() => {
    if (view !== 'thread' || !open) return
    const hidden = (listCard.current?.getClientRects().length ?? 1) === 0
    if (!hidden) return
    threadCard.current?.scrollIntoView({ block: 'start' })
    heading.current?.focus({ preventScroll: true })
  }, [view, open?.thread_id])

  const items: Item[] = found
    ? found.map((m) => ({ id: m.thread_id, title: m.subject || '(no subject)', from: who(m.from_addr), count: 0, when: m.at }))
    : (threads.data?.threads ?? []).map((t) => ({ id: t.thread_id, title: t.subject || '(no subject)', from: who(t.started_by), count: t.messages, when: t.last }))

  const volume = useMemo(() => volumeOf(threads.data?.threads ?? []), [threads.data])

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button.mbox-item')]
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }

  const replyBusy = busy === 'draft' || busy === 'send' || busy === 'discard'
  const step = !draft ? 1 : confirming === undefined ? 2 : 3
  const listLoading = threads.data === null && !threads.error
  const topError = (error?.at === 'top' ? error.text : '') || status.error
  const replyError = error?.at === 'reply' ? error.text : ''
  // "Nothing has been sent" is not what to read beside the box that is about to send it.
  const replyNote = notice?.at === 'reply' && confirming === undefined ? notice.text : ''

  return (
    <div className="panel mbox-page">
      <div className={`mbox ${open && view === 'thread' ? 'is-open' : ''}`}>
        {/* ---- the mailbox: its size, a way to refresh it, and the list ---- */}
        <aside className="mbox-side">
          <section className="card mbox-head" aria-label="Mailbox">
            <div className="mbox-head-top">
              <span className="navtile" style={{ '--tile': toolColor('mail-ai') } as CSSProperties}><IconMail size={17} strokeWidth={2} aria-hidden /></span>
              <div className="mbox-head-title">
                <h2>Your mailbox</h2>
                <p className="sub">Read from the synced copy.</p>
              </div>
              <button disabled={busy === 'sync'} onClick={() => void sync()}>
                <IconRefresh size={16} aria-hidden className={busy === 'sync' ? 'mbox-spin' : undefined} />
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
            </div>

            <dl className="mbox-stats" aria-busy={status.data === null}>
              <div>
                <dt>Messages</dt>
                <dd>{status.data ? status.data.messages.toLocaleString() : <span className="skeleton mbox-skel-num" />}</dd>
              </div>
              <div>
                <dt>Conversations</dt>
                <dd>{status.data ? status.data.threads.toLocaleString() : <span className="skeleton mbox-skel-num" />}</dd>
              </div>
              <div>
                <dt>Newest</dt>
                <dd title={status.data ? when(status.data.newest) : undefined}>
                  {status.data ? (status.data.newest ? ago(status.data.newest) : '—') : <span className="skeleton mbox-skel-num" />}
                </dd>
              </div>
            </dl>
            {status.data && status.data.newest && (
              <p className="mbox-newest muted small">Newest message {when(status.data.newest)}</p>
            )}

            {volume && (
              <figure className="mbox-volume">
                <Sparkline values={volume.values} color={toolColor('mail-ai')} width={120} height={34} label={`Conversations by day of last message, ${dayLabel(volume.from)} to ${dayLabel(volume.to)}`} />
                <figcaption className="muted small">The {threads.data?.threads.length ?? 0} latest conversations, by day of their last message: {dayLabel(volume.from)} to {dayLabel(volume.to)}</figcaption>
              </figure>
            )}

            {notice?.at === 'top' && <p className="mbox-note ok" role="status"><IconOk size={16} aria-hidden /><span>{notice.text}</span></p>}
            {topError && <p className="mbox-note bad" role="alert"><IconAlert size={16} aria-hidden /><span>{topError}</span></p>}
          </section>

          <section className="card mbox-listcard" ref={listCard} aria-label="Conversations">
            <div className="mbox-searchbar">
              <form className="mbox-search" role="search" onSubmit={(e) => { e.preventDefault(); void search() }}>
                <label className="mbox-field">
                  <IconSearch size={16} aria-hidden />
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search mail" aria-label="Search mail" />
                </label>
                <button type="submit" disabled={busy === 'search'}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
              </form>
              <p className="mbox-meta" role="status">
                {found ? (
                  <>
                    <span>{found.length} message{found.length === 1 ? '' : 's'} match “{searched}”</span>
                    <button className="ghost" type="button" onClick={() => { setFound(null); setQuery('') }}>Clear</button>
                  </>
                ) : listLoading ? (
                  <span>Loading…</span>
                ) : (
                  <span>{items.length > 0 ? `Latest ${items.length} conversation${items.length === 1 ? '' : 's'}` : ''}</span>
                )}
              </p>
            </div>

            {listLoading ? (
              <ul className="mbox-list" aria-busy="true" aria-label="Loading conversations">
                {Array.from({ length: 7 }, (_, i) => (
                  <li key={i} className="mbox-skel-item">
                    <span className="skeleton mbox-skel-avatar" />
                    <span className="mbox-skel-lines"><span className="skeleton" /><span className="skeleton" /></span>
                  </li>
                ))}
              </ul>
            ) : items.length === 0 ? (
              <Empty icon={found ? IconSearch : IconMail} title={found ? 'Nothing matches.' : 'No mail synced yet.'}>
                {found ? 'Try fewer words, or clear the search to see the latest conversations.' : 'Press Sync now to bring your mailbox in.'}
              </Empty>
            ) : (
              <ul className="mbox-list stagger" onKeyDown={onListKey}>
                {items.map((item, i) => {
                  const on = open?.thread_id === item.id
                  return (
                    <li key={`${item.id}-${i}`} style={{ '--i': Math.min(i, 8) } as CSSProperties}>
                      <button
                        className={`mbox-item ${on ? 'is-on' : ''}`}
                        aria-current={on ? 'true' : undefined}
                        aria-busy={opening === item.id}
                        onClick={() => select(item.id)}
                      >
                        <Avatar name={item.from} />
                        <span className="mbox-item-main">
                          <span className="mbox-item-top">
                            <span className="mbox-from">{item.from}</span>
                            <time className="mbox-when" title={when(item.when)}>{short(item.when)}</time>
                          </span>
                          <span className="mbox-item-sub">
                            <span className="mbox-subject">{item.title}</span>
                            {opening === item.id
                              ? <IconRefresh size={14} aria-label="Opening" className="mbox-spin" />
                              : item.count > 1 && <span className="mbox-count" title={`${item.count} messages`}>{item.count}</span>}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </aside>

        {/* ---- the conversation ---- */}
        <section className="card mbox-thread" ref={threadCard} aria-label="Conversation">
          {!open && opening ? (
            <div className="mbox-opening" aria-busy="true">
              <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
            </div>
          ) : !open ? (
            <Empty icon={IconMail} title="Pick a conversation">Open one from the list to read it here.</Empty>
          ) : (
            <>
              <header className="mbox-thread-head">
                <button className="mbox-back" onClick={back}><IconBack size={16} aria-hidden />Back to the list</button>
                <h2 ref={heading} tabIndex={-1}>{open.subject || '(no subject)'}</h2>
                <p className="muted small">{open.messages.length} message{open.messages.length === 1 ? '' : 's'}</p>
              </header>

              <div className="mbox-messages">
                {open.messages.map((m) => (
                  <article key={m.id} className="mbox-msg">
                    <header>
                      <Avatar name={who(m.from)} />
                      <div className="mbox-msg-who">
                        <strong>{who(m.from)}</strong>
                        {m.to && <span className="muted small" title={m.to}>to {who(m.to)}</span>}
                      </div>
                      <time className="muted small" title={ago(m.at)}>{when(m.at)}</time>
                    </header>
                    <Body text={m.body} />
                  </article>
                ))}
              </div>

              {canDraft ? (
                <section className="mbox-reply" aria-label="Reply" data-step={step}>
                  <ol className="mbox-steps" aria-label="Steps to send a reply">
                    {['Write', 'Saved as a draft', 'Review and send'].map((label, i) => (
                      <li key={label} aria-current={step === i + 1 ? 'step' : undefined} className={step > i + 1 ? 'is-done' : step === i + 1 ? 'is-now' : ''}>
                        <span className="mbox-step-dot">{step > i + 1 ? <IconCheck size={13} strokeWidth={3} aria-hidden /> : i + 1}</span>
                        {label}
                      </li>
                    ))}
                  </ol>

                  {!draft && (
                    <div className="stack">
                      <label className="mbox-label" htmlFor="mbox-reply">Your reply</label>
                      <textarea id="mbox-reply" value={reply} onChange={(e) => setReply(e.target.value)} rows={5} placeholder="Write a reply" aria-label="Reply" />
                      <div className="mbox-actions">
                        <button className="primary" disabled={!reply.trim() || replyBusy} onClick={() => void makeDraft()}>
                          {busy === 'draft' ? 'Saving…' : 'Save as draft'}
                        </button>
                        <span className="hint">A draft is kept in Gmail. Nothing is sent.</span>
                      </div>
                    </div>
                  )}

                  {draft && confirming === undefined && (
                    <div className="mbox-draft">
                      <p className="mbox-draftline">
                        <IconOk size={18} aria-hidden />
                        <span>Draft to {who(draft.to)} saved.</span>
                        <span className="badge">Not sent</span>
                      </p>
                      {reply.trim() && <pre className="mbox-quote">{reply.trim()}</pre>}
                      <div className="mbox-actions">
                        <button disabled={replyBusy} onClick={() => void askSend()}><IconSend size={16} aria-hidden />Send…</button>
                        <button className="ghost" disabled={replyBusy} onClick={() => void discard()}>Discard</button>
                        <span className="hint">“Send…” shows you the whole email first.</span>
                      </div>
                    </div>
                  )}

                  {draft && confirming !== undefined && (
                    <SendConfirm preview={confirming} to={draft.to} sending={busy === 'send'}
                      onSend={() => void send()} onCancel={() => setConfirming(undefined)} />
                  )}

                  {replyNote && <p className="mbox-note ok" role="status"><IconOk size={16} aria-hidden /><span>{replyNote}</span></p>}
                  {replyError && <p className="mbox-note bad" role="alert"><IconAlert size={16} aria-hidden /><span>{replyError}</span></p>}
                </section>
              ) : (
                <p className="mbox-off hint"><IconAlert size={16} aria-hidden />Replying is off. Drafting and sending appear here once they are switched on for mail-ai.</p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
