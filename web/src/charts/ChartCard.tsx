// The frame every chart sits in: a title, one line saying what is plotted, and the table view that
// is the accessible twin of the chart (every value reachable without hovering or seeing colour).

import { useState, type ReactNode } from 'react'
import { IconChart, IconTable } from '../ui/icons'

export function ChartCard({ title, sub, actions, children, table, className = '' }: {
  title: string
  sub?: string
  actions?: ReactNode
  children: ReactNode
  table?: ReactNode
  className?: string
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  return (
    <figure className={`card chartcard ${className}`}>
      <figcaption className="card-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="sub">{sub}</p>}
        </div>
        <div className="row">
          {actions}
          {table && (
            <button className="ghost" onClick={() => setView(view === 'chart' ? 'table' : 'chart')} aria-pressed={view === 'table'}>
              {view === 'chart' ? <IconTable size={16} aria-hidden /> : <IconChart size={16} aria-hidden />}
              {view === 'chart' ? 'Table' : 'Chart'}
            </button>
          )}
        </div>
      </figcaption>
      {view === 'chart' ? children : <div className="table-wrap">{table}</div>}
    </figure>
  )
}

export function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table>
      <thead><tr>{head.map((h, i) => <th key={h} className={i > 0 ? 'num' : ''}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((cell, j) => <td key={j} className={j > 0 ? 'num' : ''}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}
