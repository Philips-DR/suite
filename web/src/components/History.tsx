// Every tool call, from the audit log -- newest first, across restarts. The Activity panel is
// this run's live view; this is the durable record.
//
// The filters sit above everything they scope: the tiles, the two charts and the table all read the
// same narrowed rows. Picking a day on the outcomes chart or an action on the slowest-actions chart
// narrows the table further, and the page says so, with one button to undo it.

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { getHistory, toolLabel, type AuditRow } from '../api'
import { ChartCard, DataTable } from '../charts/ChartCard'
import { HBars } from '../charts/HBars'
import { toolColor, toolName, TOOLS, toolOf } from '../charts/palette'
import { duration } from '../charts/scale'
import { Sparkline } from '../charts/Sparkline'
import { StackedColumns, type Series } from '../charts/StackedColumns'
import { useCountUp } from '../charts/useWidth'
import { columns, dayKey, lastDays, seriesOf, summarise } from '../pages/overviewData'
import { Empty } from '../ui/Empty'
import { IconAlert, IconChevron, IconClose, IconFail, IconHistory, IconOk, IconRefresh, IconSearch } from '../ui/icons'
import { ago } from '../ui/time'
import { usePoll } from '../usePoll'
import '../styles/panels/history.css'

const LIMIT = 300
const PAGE = 25
const SLOWEST = 8

type Outcome = 'all' | 'ok' | 'failed' | 'declined'
type By = 'all' | 'you' | 'assistant'

const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ok', label: 'Succeeded' },
  { id: 'failed', label: 'Failed' },
  { id: 'declined', label: 'Declined' },
]
const BYS: { id: By; label: string }[] = [
  { id: 'all', label: 'Anyone' },
  { id: 'you', label: 'You' },
  { id: 'assistant', label: 'Assistant' },
]

/** A log row with the two things every filter and chart needs worked out once. */
interface Entry extends AuditRow {
  t: number
  day: string
  who: 'you' | 'assistant'
}

const thisYear = new Date().getFullYear()
const sameYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const otherYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (t: number) => (new Date(t).getFullYear() === thisYear ? sameYear : otherYear).format(t)

/** "audiobook · start render" -> "start render": the tool is already said by the bar's colour and the table. */
const actionName = (qualified: string) => (qualified.split('__')[1] ?? qualified).replace(/_/g, ' ')

const MS_DAY = 86_400_000

// ---- small pieces ---------------------------------------------------------------------------------

function Tile({ label, value, format = (n) => Math.round(n).toLocaleString(), suffix, foot, tone = 'flat', icon: Icon, spark, sparkLabel, hero = false, index }: {
  label: string
  value: number | null
  format?: (n: number) => string
  suffix?: string
  foot?: string
  tone?: 'good' | 'bad' | 'flat'
  icon?: typeof IconOk
  spark?: number[]
  sparkLabel?: string
  hero?: boolean
  index: number
}) {
  const shown = useCountUp(value ?? 0)
  return (
    <div className={`card stat ${hero ? 'hero' : ''}`} style={{ '--i': index } as CSSProperties}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value === null ? '—' : format(shown)}
        {suffix && value !== null && <small>{suffix}</small>}
      </span>
      <div className="stat-foot">
        {foot ? <span className={`stat-delta ${tone}`}>{Icon && <Icon size={14} aria-hidden />}{foot}</span> : <span />}
        {spark && <Sparkline values={spark} label={sparkLabel ?? label} width={hero ? 150 : 96} />}
      </div>
    </div>
  )
}

function OutcomeBadge({ outcome, error }: { outcome: string; error?: string | null }) {
  const title = error || undefined
  if (outcome === 'ok') return <span className="badge ok" title={title}><IconOk size={14} aria-hidden />Succeeded</span>
  if (outcome === 'failed') return <span className="badge bad" title={title}><IconFail size={14} aria-hidden />Failed</span>
  if (outcome === 'declined') return <span className="badge warn" title={title}><IconAlert size={14} aria-hidden />Declined</span>
  return <span className="badge" title={title}>{outcome}</span>
}

function Skeleton() {
  return (
    <div className="hist-skeleton" aria-busy="true" aria-label="Loading the log">
      <div className="kpis">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card skeleton hist-skel-tile" />)}
      </div>
      <div className="card">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton hist-skel-row" />)}
      </div>
    </div>
  )
}

// ---- the page --------------------------------------------------------------------------------------

export function History() {
  const rows = usePoll(() => getHistory(LIMIT), 15000)

  const [tools, setTools] = useState<string[]>([])
  const [outcome, setOutcome] = useState<Outcome>('all')
  const [by, setBy] = useState<By>('all')
  const [text, setText] = useState('')
  const [day, setDay] = useState<string | null>(null)
  const [action, setAction] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [filtersOpen, setFiltersOpen] = useState(false) // phone only: the filters fold away behind one button

  const entries = useMemo<Entry[]>(
    () => (rows.data ?? []).map((r) => {
      const t = new Date(r.at).getTime()
      return { ...r, t, day: dayKey(new Date(t)), who: r.origin === 'button' ? 'you' : 'assistant' }
    }),
    [rows.data],
  )

  // Paging starts over whenever the question changes, never when the log merely refreshes.
  useEffect(() => { setShown(PAGE) }, [tools, outcome, by, text, day, action])

  const needle = text.trim().toLowerCase()
  const base = useMemo(
    () => entries.filter((e) =>
      (tools.length === 0 || tools.includes(seriesOf(e))) &&
      (outcome === 'all' || e.outcome === outcome) &&
      (by === 'all' || e.who === by) &&
      (needle === '' || `${toolLabel(e.tool)} ${e.tool} ${e.outcome} ${e.who} ${e.error ?? ''}`.toLowerCase().includes(needle))),
    [entries, tools, outcome, by, needle],
  )
  // Each chart ignores the narrowing it offers itself, or picking a day would leave one column.
  const forDays = useMemo(() => (action ? base.filter((e) => e.tool === action) : base), [base, action])
  const forActions = useMemo(() => (day ? base.filter((e) => e.day === day) : base), [base, day])
  const view = useMemo(() => base.filter((e) => (!day || e.day === day) && (!action || e.tool === action)), [base, day, action])

  // The days the chart spans: as far back as the loaded log goes, within a week to a month.
  const days = useMemo(() => {
    const oldest = entries.reduce((m, e) => Math.min(m, e.t), Date.now())
    const span = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(oldest).setHours(0, 0, 0, 0)) / MS_DAY) + 1
    return lastDays(Math.min(30, Math.max(7, span)))
  }, [entries])

  const outcomeSeries = useMemo<Series[]>(() => {
    const known: Series[] = [
      { key: 'ok', label: 'Succeeded', color: 'var(--ok-fill)' },
      { key: 'failed', label: 'Failed', color: 'var(--bad-fill)' },
      { key: 'declined', label: 'Declined', color: 'var(--warn-fill)' },
    ]
    return entries.some((e) => !['ok', 'failed', 'declined'].includes(e.outcome)) ? [...known, { key: 'other', label: 'Other', color: 'var(--s-other)' }] : known
  }, [entries])

  const cols = useMemo(() => {
    const grid = new Map<string, Record<string, number>>()
    for (const e of forDays) {
      const key = ['ok', 'failed', 'declined'].includes(e.outcome) ? e.outcome : 'other'
      const cell = grid.get(e.day) ?? {}
      cell[key] = (cell[key] ?? 0) + 1
      grid.set(e.day, cell)
    }
    return columns(days, []).map((c) => ({ ...c, values: grid.get(c.key) ?? {} }))
  }, [days, forDays])

  const daily = useMemo(() => cols.map((c) => Object.values(c.values).reduce((n, v) => n + v, 0)), [cols])

  const slowest = useMemo(() => {
    const groups = new Map<string, Entry[]>()
    for (const e of forActions) {
      if (typeof e.duration_ms !== 'number') continue
      groups.set(e.tool, [...(groups.get(e.tool) ?? []), e])
    }
    const named = [...groups.entries()].map(([tool, g]) => ({ tool, n: g.length, ms: summarise(g).medianMs ?? 0 }))
    const clash = (tool: string) => named.filter((x) => actionName(x.tool) === actionName(tool)).length > 1
    return named
      .sort((a, b) => b.ms - a.ms)
      .slice(0, SLOWEST)
      .map((x) => ({ ...x, label: clash(x.tool) ? toolLabel(x.tool) : actionName(x.tool) }))
  }, [forActions])

  const summary = useMemo(() => summarise(view), [view])
  const decided = summary.ok + summary.failed
  const rate = decided > 0 ? Math.round((summary.ok / decided) * 100) : null
  const attention = summary.failed + summary.declined

  const present = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) counts.set(seriesOf(e), (counts.get(seriesOf(e)) ?? 0) + 1)
    return [...TOOLS.filter((t) => counts.has(t)), ...(counts.has('other') ? ['other'] : [])].map((key) => ({ key, n: counts.get(key) ?? 0 }))
  }, [entries])

  const toggleTool = (key: string) => setTools((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]))
  const narrowedByCharts = day !== null || action !== null
  const filtered = tools.length > 0 || outcome !== 'all' || by !== 'all' || needle !== '' || narrowedByCharts
  const activeCount = tools.length + (outcome !== 'all' ? 1 : 0) + (by !== 'all' ? 1 : 0) + (needle ? 1 : 0)
  const clearAll = () => { setTools([]); setOutcome('all'); setBy('all'); setText(''); setDay(null); setAction(null) }
  const dayLabel = day ? cols.find((c) => c.key === day)?.label ?? day : null
  const loaded = rows.data !== null

  if (!loaded && !rows.error) return <div className="panel"><Skeleton /></div>

  if (!loaded) {
    return (
      <div className="panel">
        <div className="card">
          <Empty icon={IconAlert} title="The log could not be loaded" action={<button onClick={() => void rows.reload()}><IconRefresh size={16} aria-hidden />Try again</button>}>
            <span className="error">{rows.error}</span>
          </Empty>
        </div>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="panel">
        <div className="card">
          <Empty icon={IconHistory} title="Nothing has run yet">
            Every tool call, whether you pressed a button or the assistant made it, is listed here and kept across restarts.
          </Empty>
        </div>
      </div>
    )
  }

  const rangeNote = `the ${days.length} days up to today`
  const page = view.slice(0, shown)

  return (
    <div className="panel hist">
      {/* ---- filters: above everything they scope ---- */}
      <section className="card hist-filters" aria-labelledby="hist-filters-title">
        <h2 id="hist-filters-title" className="sr-only">Filter the log</h2>
        <div className="hist-filter-top">
          <label className="hist-search">
            <IconSearch size={16} aria-hidden />
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search tool, action, error" aria-label="Search the log" />
          </label>
          <button
            className="hist-toggle"
            aria-expanded={filtersOpen}
            aria-controls="hist-filter-body"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            Filters{activeCount > 0 && <span className="chip">{activeCount}</span>}
            <IconChevron size={16} aria-hidden className="hist-toggle-icon" />
          </button>
        </div>

        <div id="hist-filter-body" className={`hist-filter-body ${filtersOpen ? 'is-open' : ''}`}>
          <div className="hist-group hist-group-tools">
            <h3 id="hist-tools-label">Tool</h3>
            <div className="hist-chips" role="group" aria-labelledby="hist-tools-label">
              {present.map(({ key, n }) => (
                <button key={key} className="hist-chip" aria-pressed={tools.includes(key)} onClick={() => toggleTool(key)}>
                  <i className="swatch" style={{ background: toolColor(key) }} aria-hidden />
                  {key === 'other' ? 'Other' : toolName(key)}
                  <b>{n}</b>
                </button>
              ))}
            </div>
          </div>
          <div className="hist-group">
            <h3 id="hist-outcome-label">Result</h3>
            <div className="seg" role="radiogroup" aria-labelledby="hist-outcome-label">
              {OUTCOMES.map((o) => (
                <button key={o.id} role="radio" aria-checked={outcome === o.id} onClick={() => setOutcome(o.id)}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="hist-group">
            <h3 id="hist-by-label">Run by</h3>
            <div className="seg" role="radiogroup" aria-labelledby="hist-by-label">
              {BYS.map((o) => (
                <button key={o.id} role="radio" aria-checked={by === o.id} onClick={() => setBy(o.id)}>{o.label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="hist-status" role="status">
          <span>
            {filtered ? <>Showing <b>{view.length}</b> of {entries.length} actions</> : <>All <b>{entries.length}</b> actions</>}
            {entries.length >= LIMIT && !filtered ? ` (the latest ${LIMIT})` : ''}
          </span>
          {narrowedByCharts && (
            <span className="hist-scope">
              Narrowed by a chart:
              {dayLabel && <button className="hist-pill" onClick={() => setDay(null)} aria-label={`Remove the day filter, ${dayLabel}`}>{dayLabel}<IconClose size={14} aria-hidden /></button>}
              {action && <button className="hist-pill" onClick={() => setAction(null)} aria-label={`Remove the action filter, ${actionName(action)}`}>{actionName(action)}<IconClose size={14} aria-hidden /></button>}
            </span>
          )}
          {filtered && <button className="ghost" onClick={clearAll}>Clear filters</button>}
        </div>
        {rows.error && <p className="error small">Could not refresh: {rows.error}</p>}
      </section>

      {/* ---- figures for the rows in view ---- */}
      <div className="kpis hist-kpis stagger">
        <Tile index={0} hero label={filtered ? 'Actions in view' : 'Actions logged'} value={view.length}
          foot={filtered ? `${entries.length} loaded in all` : entries.length >= LIMIT ? `The latest ${LIMIT}` : 'The whole log'}
          spark={daily} sparkLabel={`Actions per day over ${rangeNote}`} />
        <Tile index={1} label="Success rate" value={rate} format={(n) => String(Math.round(n))} suffix="%"
          foot={decided > 0 ? `${summary.ok} of ${decided} finished` : 'Nothing finished yet'}
          tone={rate === null ? 'flat' : rate === 100 ? 'good' : 'flat'} icon={rate === 100 ? IconOk : undefined} />
        <Tile index={2} label="Median time" value={summary.medianMs} format={(n) => duration(n)} foot="A typical action" />
        <Tile index={3} label="Needed a look" value={attention}
          foot={attention === 0 ? 'Nothing failed or was declined' : `${summary.failed} failed, ${summary.declined} declined`}
          tone={attention === 0 ? 'good' : 'bad'} icon={attention === 0 ? IconOk : IconAlert} />
      </div>

      {/* ---- two charts that answer something about the log ---- */}
      <div className="grid-split hist-charts">
        <ChartCard
          title="Results by day"
          sub={`How each action ended, over ${rangeNote}. Pick a day to narrow the table.`}
          actions={day ? <button className="ghost" onClick={() => setDay(null)}>Show all days</button> : undefined}
          table={<DataTable head={['Day', ...outcomeSeries.map((s) => s.label), 'Total']} rows={cols.map((c) => [c.label, ...outcomeSeries.map((s) => c.values[s.key] ?? 0), outcomeSeries.reduce((n, s) => n + (c.values[s.key] ?? 0), 0)])} />}
        >
          <StackedColumns columns={cols} series={outcomeSeries} label={`Actions per day by result, over ${rangeNote}`} selected={day} onSelect={setDay} />
        </ChartCard>

        <ChartCard
          title="Slowest actions"
          sub={`Median time per action, the ${SLOWEST} slowest; the table view counts the runs. Pick a bar to narrow the table.`}
          actions={action ? <button className="ghost" onClick={() => setAction(null)}>Show all</button> : undefined}
          table={<DataTable head={['Action', 'Median', 'Runs']} rows={slowest.map((s) => [toolLabel(s.tool), duration(s.ms), s.n])} />}
        >
          {slowest.length === 0 ? (
            <div className="empty compact"><strong>No timings in view</strong><span>Actions that report how long they took are ranked here.</span></div>
          ) : (
            <HBars
              label="Median time per action, slowest first"
              max={slowest[0]!.ms * 1.3}
              items={slowest.map((s) => ({
                key: s.tool,
                label: s.label,
                value: s.ms,
                display: duration(s.ms),
                sub: `${toolLabel(s.tool)}: median of ${s.n} run${s.n === 1 ? '' : 's'}`,
                color: toolColor(toolOf(s.tool)),
                selected: action === null ? undefined : action === s.tool,
              }))}
              onToggle={(key) => setAction((now) => (now === key ? null : key))}
            />
          )}
        </ChartCard>
      </div>

      {/* ---- the record ---- */}
      <section className="card hist-record" aria-label="The log">
        <div className="card-head">
          <div>
            <h2>Every action</h2>
            <p className="sub">Newest first. Hover a result for the error behind it.</p>
          </div>
          <span className="muted small hist-live">Refreshes every 15 seconds</span>
        </div>

        {view.length === 0 ? (
          <Empty icon={IconSearch} title="No actions match"
            action={<button onClick={clearAll}>Clear filters</button>}>
            Nothing in the loaded log fits every filter at once.
          </Empty>
        ) : (
          <div className="table-wrap stack-rows hist-table" role="region" aria-label="Every action, newest first" tabIndex={0}>
            <table>
              <thead>
                <tr><th>When</th><th>What</th><th>By</th><th>Result</th><th className="num">Took</th></tr>
              </thead>
              <tbody>
                {page.map((e, i) => (
                  <tr key={`${e.at}-${e.tool}-${i}`}>
                    <td data-label="When" className="hist-when" title={ago(e.t)}>{when(e.t)}</td>
                    <td data-label="What" className="hist-what">
                      <span className="hist-tool">
                        <i className="hist-dot" style={{ background: toolColor(toolOf(e.tool)) }} aria-hidden />
                        <span className="mono">{toolLabel(e.tool)}</span>
                      </span>
                      {e.error && <span className="hist-err" title={e.error}>{e.error}</span>}
                    </td>
                    <td data-label="By" className="hist-by">{e.who === 'you' ? 'You' : 'Assistant'}</td>
                    <td data-label="Result"><OutcomeBadge outcome={e.outcome} error={e.error} /></td>
                    <td data-label="Took" className="num hist-took">{typeof e.duration_ms === 'number' ? duration(e.duration_ms) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {view.length > shown && (
          <div className="hist-more">
            <button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, view.length - shown)} more</button>
            <span className="muted small">Showing {shown} of {view.length}</span>
          </div>
        )}
      </section>
    </div>
  )
}
