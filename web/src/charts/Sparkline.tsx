// A sparkline in the de-emphasis grey, with the current period in the accent: a 2px line, a faint
// wash under it, and an 8px end dot carrying a 2px ring of the surface so it stays legible.

import { useId } from 'react'

export function Sparkline({ values, color = 'var(--brand)', width = 120, height = 38, label }: {
  values: number[]
  color?: string
  width?: number
  height?: number
  label: string
}) {
  const id = useId()
  const pad = 5
  const max = Math.max(1, ...values)
  const n = values.length
  if (n < 2) return null
  const x = (i: number) => pad + (i / (n - 1)) * (width - pad * 2)
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2)
  const points = values.map((v, i) => [x(i), y(v)] as const)
  const line = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')
  const area = `${line}L${x(n - 1)},${height - pad}L${x(0)},${height - pad}Z`
  const last = points[n - 1]!
  const lastSeg = `M${points[n - 2]![0].toFixed(1)},${points[n - 2]![1].toFixed(1)}L${last[0].toFixed(1)},${last[1].toFixed(1)}`
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} aria-describedby={id}>
      <path d={area} style={{ fill: 'var(--ink-3)', opacity: 0.08 }} />
      <path d={line} className="spark-line" pathLength={1} />
      <path d={lastSeg} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinecap="round" />
      <circle className="spark-dot" cx={last[0]} cy={last[1]} r={4} style={{ fill: color, stroke: 'var(--surface)' }} strokeWidth={2} />
      <desc id={id}>{values.join(', ')}</desc>
    </svg>
  )
}
