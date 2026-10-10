// Stacked columns: a magnitude per day, split by tool. Built to the dataviz mark specs:
//   - columns at most 24px thick, never filling their slot; 4px rounded at the data end, square on
//     the baseline;
//   - a 2px gap of surface colour between stacked segments (no outlines);
//   - hairline, solid gridlines one step off the surface; ticks rounded and compact;
//   - one tooltip listing every series at the pointed-at day, values first; the same readout on the
//     keyboard (arrow keys) as on hover;
//   - a legend that also isolates a series, carrying each series' total so identity is never colour
//     alone. A table view (ChartCard) is the WCAG-clean twin of the whole chart.

import { useMemo, useRef, useState } from 'react'
import { compact, niceMax, tickValues } from './scale'
import { useWidth } from './useWidth'

export interface Series { key: string; label: string; color: string }
export interface Column { key: string; label: string; tick: string; values: Record<string, number> }

const M = { top: 14, right: 6, bottom: 30, left: 34 }
const MAX_BAR = 24
const GAP = 2

/** A bar with its top corners rounded and its base square. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, h, w / 2))
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

export function StackedColumns({
  columns, series, height = 232, selected = null, onSelect, label, unit = 'actions', dimmed = false,
}: {
  columns: Column[]
  series: Series[]
  height?: number
  selected?: string | null
  onSelect?: (key: string | null) => void
  label: string
  unit?: string
  dimmed?: boolean
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [only, setOnly] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => (only ? series.filter((s) => s.key === only) : series), [series, only])
  const totalOf = (c: Column) => visible.reduce((n, s) => n + (c.values[s.key] ?? 0), 0)

  const innerW = Math.max(40, width - M.left - M.right)
  const innerH = height - M.top - M.bottom
  const band = innerW / Math.max(1, columns.length)
  const barW = Math.min(MAX_BAR, Math.max(3, band * 0.62))
  const { max, step } = niceMax(Math.max(0, ...columns.map(totalOf)), 4, true) // counts: whole-number ticks
  const k = innerH / max
  const y = (v: number) => M.top + innerH - v * k
  const everything = columns.reduce((n, c) => n + totalOf(c), 0)

  // Label every n-th day so labels never touch.
  const every = Math.max(1, Math.ceil(36 / band))

  const seriesTotals = series.map((s) => ({ ...s, total: columns.reduce((n, c) => n + (c.values[s.key] ?? 0), 0) }))

  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const i = Math.floor((e.clientX - box.left - M.left) / band)
    setHover(i >= 0 && i < columns.length ? i : null)
  }

  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.min(columns.length - 1, (h ?? -1) + 1)) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, (h ?? columns.length) - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setHover(0) }
    else if (e.key === 'End') { e.preventDefault(); setHover(columns.length - 1) }
    else if (e.key === 'Escape') setHover(null)
    else if ((e.key === 'Enter' || e.key === ' ') && hover !== null) {
      e.preventDefault()
      onSelect?.(selected === columns[hover]!.key ? null : columns[hover]!.key)
    }
  }

  const hc = hover !== null ? columns[hover] : undefined
  const tipLeft = hover !== null ? M.left + band * (hover + 0.5) : 0
  const flip = hover !== null && tipLeft > width * 0.55

  return (
    <div className={`chart ${dimmed ? 'is-loading' : ''}`} ref={ref}>
      <ul className="legend" aria-label="Series">
        {seriesTotals.map((s) => (
          <li key={s.key}>
            <button
              className="legend-item"
              aria-pressed={only === null ? undefined : only === s.key}
              title={only === s.key ? 'Show every series again' : `Show only ${s.label}`}
              onClick={() => setOnly(only === s.key ? null : s.key)}
              style={{ opacity: only !== null && only !== s.key ? 0.45 : 1 }}
            >
              <i className="swatch" style={{ background: s.color }} aria-hidden />
              <span>{s.label}</span>
              <b>{s.total}</b>
            </button>
          </li>
        ))}
      </ul>

      <div
        ref={wrap}
        className="chart-plot"
        tabIndex={0}
        role="group"
        aria-label={`${label}. Use the left and right arrow keys to move between days.`}
        onKeyDown={key}
        onBlur={() => setHover(null)}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} onPointerMove={move} onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHover(null) }} role="img" aria-label={label}>
          {tickValues(max, step).map((v) => (
            <g key={v}>
              <line className="grid-line" x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} />
              <text className="tick" x={M.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">{compact(v)}</text>
            </g>
          ))}
          <line className="axis-line" x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} />

          {hover !== null && <rect className="hover-band" x={M.left + band * hover} y={M.top} width={band} height={innerH} />}

          {columns.map((c, i) => {
            const cx = M.left + band * (i + 0.5) - barW / 2
            let cum = 0
            const live = visible.filter((s) => (c.values[s.key] ?? 0) > 0)
            const dim = selected !== null && selected !== c.key
            return (
              <g key={c.key} className="col" style={{ opacity: dim ? 0.35 : 1 }}>
                {live.map((s, j) => {
                  const v = c.values[s.key] ?? 0
                  const top = y(cum + v)
                  const h = Math.max(2, v * k - (j === 0 ? 0 : GAP))
                  cum += v
                  const last = j === live.length - 1
                  return (
                    <path
                      key={s.key}
                      className="seg"
                      d={last ? barPath(cx, top, barW, h, 4) : `M${cx},${top}h${barW}v${h}h${-barW}Z`}
                      style={{ fill: s.color, animationDelay: `${i * 22}ms` }}
                    />
                  )
                })}
                {(i === columns.length - 1 || (i % every === 0 && columns.length - 1 - i >= every)) && (
                  <text className="tick" x={M.left + band * (i + 0.5)} y={height - 8} textAnchor="middle">{c.tick}</text>
                )}
              </g>
            )
          })}

          {/* A transparent, generous target over each day: the hit area is the whole slot, never the bar. */}
          {columns.map((c, i) => (
            <rect
              key={c.key}
              x={M.left + band * i}
              y={M.top}
              width={band}
              height={innerH}
              fill="transparent"
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={() => { setHover(i); onSelect?.(selected === c.key ? null : c.key) }}
            />
          ))}
        </svg>

        {everything === 0 && <div className="chart-empty">No activity in this period yet.</div>}

        {hc && (
          <div className="tip" style={{ left: tipLeft, transform: `translateX(${flip ? 'calc(-100% - 14px)' : '14px'})` }} role="status">
            <div className="tip-title">{hc.label}</div>
            {visible.filter((s) => (hc.values[s.key] ?? 0) > 0).map((s) => (
              <div className="tip-row" key={s.key}>
                <i className="tip-key" style={{ background: s.color }} aria-hidden />
                <b>{hc.values[s.key]}</b>
                <span>{s.label}</span>
              </div>
            ))}
            <div className="tip-row total"><span>Total</span><b>{totalOf(hc)} {unit}</b></div>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {hc ? `${hc.label}: ${totalOf(hc)} ${unit}. ${visible.filter((s) => (hc.values[s.key] ?? 0) > 0).map((s) => `${s.label} ${hc.values[s.key]}`).join(', ')}` : ''}
      </p>
    </div>
  )
}
