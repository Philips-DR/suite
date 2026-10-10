// Scales and number formats for the charts. One scale places the marks, the ticks and the labels,
// so every label names a value the chart actually reaches.

/**
 * A round maximum and step so the axis ends on a clean number: 0 / 5 / 10 / 15, never 0 / 4.3 / 8.6.
 * With `whole`, steps are whole numbers: a chart of counts must not be labelled 0 / 0.5 / 1.
 */
export function niceMax(max: number, ticks = 4, whole = false): { max: number; step: number } {
  if (!(max > 0)) return { max: ticks, step: 1 } // an empty chart still has an axis
  const rough = max / ticks
  const pow = 10 ** Math.floor(Math.log10(rough))
  const f = rough / pow
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
  if (whole && step < 1) step = 1
  return { max: Math.ceil(max / step) * step, step }
}

export function tickValues(max: number, step: number): number[] {
  const out: number[] = []
  for (let v = 0; v <= max + step / 1000; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

const trim = (n: number) => String(Math.round(n * 10) / 10).replace(/\.0$/, '')

/** 950 -> "950", 1200 -> "1.2K", 4_500_000 -> "4.5M": compact from 1,000 up. */
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e3) return `${trim(n / 1e3)}K`
  return String(Math.round(n * 10) / 10)
}

export const percent = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%')

/** Milliseconds as a person would say them: 340 ms, 2.4 s, 1 min 5 s. */
export function duration(ms: number): string {
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - m * 60)} s`
}
