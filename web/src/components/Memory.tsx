// What the assistant knows about you. Adding and forgetting go through the same remember and
// forget tools the model uses, so they are audited -- and the model sees the change on its
// very next turn.

import { useMemo, useState, type ComponentType } from 'react'
import { call } from '../call'
import { CardHead } from '../ui/CardHead'
import { Empty } from '../ui/Empty'
import { IconFact, IconMemory, IconPerson, IconPlus, IconPreference, IconProject, IconSearch, IconSpelling } from '../ui/icons'
import { ago } from '../ui/time'
import { usePoll } from '../usePoll'
import '../styles/panels/memory.css'

interface Fact { id: string; kind: string; subject: string; content: string; created: string }

type Icon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
const KINDS: { kind: string; label: string; hint: string; icon: Icon }[] = [
  { kind: 'person', label: 'People', hint: 'Who someone is.', icon: IconPerson },
  { kind: 'project', label: 'Projects', hint: 'What you are working on.', icon: IconProject },
  { kind: 'preference', label: 'Preferences', hint: 'How you like things done.', icon: IconPreference },
  { kind: 'spelling', label: 'Spellings', hint: 'Correct spelling, then the misheard forms, comma-separated. Used to fix transcripts.', icon: IconSpelling },
  { kind: 'fact', label: 'Other', hint: 'Anything else worth knowing.', icon: IconFact },
]
const kindInfo = (kind: string) => KINDS.find((k) => k.kind === kind) ?? KINDS[KINDS.length - 1]!

export function Memory() {
  const facts = usePoll(() => call<{ facts: Fact[] }>('assistant__recall'), 20000)
  const [kind, setKind] = useState('person')
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
      await facts.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const add = () => act('add', async () => {
    await call('assistant__remember', { kind, subject: subject.trim(), content: content.trim() })
    setSubject('')
    setContent('')
  })

  const forget = (id: string) => act(id, async () => {
    await call('assistant__forget', { id })
  })

  const all = facts.data?.facts ?? []
  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k.kind, all.filter((f) => f.kind === k.kind).length])), [all])
  const needle = query.trim().toLowerCase()
  const shown = all.filter((f) => (filter === 'all' || f.kind === filter) && (!needle || `${f.subject} ${f.content}`.toLowerCase().includes(needle)))
  const hint = kindInfo(kind).hint
  const loaded = facts.data !== null

  return (
    <div className="panel">
      <div className="card">
        <CardHead icon={IconMemory} tool="assistant" title="Remember something" sub="The assistant reads this at the start of every turn." />
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <div className="seg kindpick wrap" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => {
              const Icon = k.icon
              return (
                <button type="button" key={k.kind} role="radio" aria-checked={kind === k.kind} onClick={() => setKind(k.kind)}>
                  <Icon size={15} aria-hidden />{k.label}
                </button>
              )
            })}
          </div>
          <div className="row">
            <input value={subject} onChange={(e) => setSubject(e.target.value)}
              placeholder={kind === 'spelling' ? 'Correct spelling — e.g. AyaData' : 'About — e.g. Kwame'} aria-label="Subject" />
            <input value={content} onChange={(e) => setContent(e.target.value)}
              placeholder={kind === 'spelling' ? 'Misheard as — e.g. aya data, ayadata' : 'What to remember'} aria-label="Content" />
            <button className="primary" type="submit" disabled={!subject.trim() || !content.trim() || busy === 'add'}>
              <IconPlus size={16} aria-hidden />{busy === 'add' ? 'Saving…' : 'Remember'}
            </button>
          </div>
          {hint && <p className="hint">{hint} Saving the same kind and subject again replaces the old note.</p>}
        </form>
        {(error || facts.error) && <p className="error">{error || facts.error}</p>}
      </div>

      {loaded && all.length > 0 && (
        <div className="memory-filters">
          <div className="seg kindpick" role="radiogroup" aria-label="Show">
            <button role="radio" aria-checked={filter === 'all'} onClick={() => setFilter('all')}>All <b>{all.length}</b></button>
            {KINDS.filter((k) => counts[k.kind]).map((k) => (
              <button key={k.kind} role="radio" aria-checked={filter === k.kind} onClick={() => setFilter(k.kind)}>{k.label} <b>{counts[k.kind]}</b></button>
            ))}
          </div>
          <label className="searchbox">
            <IconSearch size={16} aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search what is remembered" aria-label="Search memory" />
          </label>
        </div>
      )}

      {!loaded && <div className="skeleton" style={{ height: 120 }} aria-hidden />}

      {loaded && all.length === 0 && (
        <div className="card"><Empty icon={IconMemory} title="Nothing remembered yet">Add who someone is, what you are working on, or how a name is spelled. The assistant will use it from the next message on.</Empty></div>
      )}

      {loaded && all.length > 0 && shown.length === 0 && (
        <div className="card"><Empty icon={IconSearch} title="Nothing matches">Try a different word, or show all kinds.</Empty></div>
      )}

      <div className="facts-grid stagger">
        {shown.map((f, i) => {
          const info = kindInfo(f.kind)
          const Icon = info.icon
          return (
            <article key={f.id} className="card fact-card" style={{ '--i': Math.min(i, 12) } as React.CSSProperties}>
              <div className="fact-top">
                <span className="navtile"><Icon size={16} strokeWidth={2} aria-hidden /></span>
                <div className="fact-head">
                  <strong>{f.subject}</strong>
                  <span className="muted small">{info.label}{f.created ? ` · ${ago(f.created)}` : ''}</span>
                </div>
                <button className="ghost" disabled={busy === f.id} onClick={() => void forget(f.id)} aria-label={`Forget ${f.subject}`}>
                  {busy === f.id ? 'Forgetting…' : 'Forget'}
                </button>
              </div>
              {f.kind === 'spelling'
                ? <ul className="chips">{f.content.split(',').map((s) => s.trim()).filter(Boolean).map((s) => <li key={s} className="badge">{s}</li>)}</ul>
                : <p className="fact-body">{f.content}</p>}
            </article>
          )
        })}
      </div>
    </div>
  )
}
