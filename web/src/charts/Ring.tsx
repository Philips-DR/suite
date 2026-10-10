import { useId } from 'react'

/** Progress as a ring: a track in the same hue, the arc growing with the value. */
export function Ring({ value, size = 64, stroke = 7, label, children }: {
  value: number | null
  size?: number
  stroke?: number
  label: string
  children?: React.ReactNode
}) {
  const id = useId()
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = value === null ? 0.28 : Math.max(0, Math.min(100, value)) / 100
  return (
    <div className={`ring ${value === null ? 'indeterminate' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={id}>
        <title id={id}>{label}</title>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="ring-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="ring-arc"
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-label">{children}</span>
    </div>
  )
}
