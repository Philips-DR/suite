// Part of a whole, as one horizontal stacked bar (not a pie: close values are hard to compare by
// angle). Segments are separated by a 2px gap of surface colour, and each carries an icon and a
// word in the legend, because a status colour is never the only thing saying what it means.

import type { ComponentType } from 'react'
import { percent } from './scale'

export interface Share {
  key: string
  label: string
  value: number
  color: string
  icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
}

export function ShareBar({ parts, label }: { parts: Share[]; label: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0)
  return (
    <div className="share">
      <div className="share-bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
        {total === 0 && <span className="share-empty" />}
        {parts.filter((p) => p.value > 0).map((p, i) => (
          <span key={p.key} className="share-seg" title={`${p.label}: ${p.value}`}
            style={{ flexGrow: p.value, background: p.color, animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
      <ul className="share-legend">
        {parts.map((p) => {
          const Icon = p.icon
          return (
            <li key={p.key}>
              <span className="share-icon" style={{ background: p.color }}><Icon size={13} strokeWidth={2.6} aria-hidden /></span>
              <span>{p.label}</span>
              <b>{p.value}</b>
              <span className="muted">{percent(p.value, total)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
