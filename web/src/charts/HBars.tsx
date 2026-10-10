// Horizontal bars for comparing a magnitude across named things: thin (10px), square at the baseline,
// 4px rounded at the data end, the value at the tip. One series, so one colour: the bars are nominal
// categories and colouring them by size would spend the identity channel on what length already says.
// With `onToggle` the bars are controls, and the selected ones keep the colour while the rest go grey
// (emphasis), so a chart can double as a chooser.

export interface HBarItem {
  key: string
  label: string
  value: number
  display: string
  sub?: string
  selected?: boolean
  /** This bar's own colour, when each bar is a different entity with a fixed colour. */
  color?: string
}

export function HBars({ items, color = 'var(--s1)', onToggle, max, label }: {
  items: HBarItem[]
  color?: string
  onToggle?: (key: string) => void
  max?: number
  label: string
}) {
  const top = Math.max(1, max ?? Math.max(...items.map((i) => i.value)))
  const scale = top * 1.18 // leaves room for the value at the end of the longest bar
  return (
    <ul className="hbars" aria-label={label}>
      {items.map((item, i) => {
        const pct = Math.max(item.value > 0 ? 1.5 : 0, (item.value / scale) * 100)
        const dim = onToggle !== undefined && item.selected === false
        const body = (
          <>
            <span className="hbar-label" title={item.label}>{item.label}</span>
            <span className="hbar-plot">
              <span
                className="hbar-fill"
                style={{ width: `${pct}%`, background: dim ? 'var(--s-other)' : item.color ?? color, animationDelay: `${i * 28}ms`, opacity: dim ? 0.55 : 1 }}
              />
              <span className="hbar-value" style={{ left: `calc(${pct}% + 8px)` }}>{item.display}</span>
            </span>
          </>
        )
        return (
          <li key={item.key}>
            {onToggle ? (
              <button className="hbar-row" role="checkbox" aria-checked={item.selected !== false} title={item.sub ?? item.label} onClick={() => onToggle(item.key)}>
                {body}
              </button>
            ) : (
              <div className="hbar-row" title={item.sub ?? item.label}>{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
