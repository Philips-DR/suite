import { describe, expect, it } from 'vitest'
import { change, columns, dayKey, lastDays, medianByTool, period, seriesFor, summarise, type Row } from './overviewData'

// A fixed "now" in the middle of a day, so a bug in day boundaries shows up.
const NOW = new Date(2026, 9, 10, 14, 30) // Sat 10 Oct 2026, 14:30 local
const at = (day: number, hour = 12, month = 9) => new Date(2026, month, day, hour).toISOString()
const row = (over: Partial<Row> = {}): Row => ({ at: at(10), tool: 'meet_ai__list_recordings', outcome: 'ok', duration_ms: 100, ...over })

describe('days', () => {
  it('ends today, oldest first, at local midnight', () => {
    const days = lastDays(3, NOW)
    expect(days.map(dayKey)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10'])
    expect(days.every((d) => d.getHours() === 0)).toBe(true)
  })

  it('crosses a month boundary', () => {
    expect(lastDays(3, new Date(2026, 10, 1, 9)).map(dayKey)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01'])
  })
})

describe('period', () => {
  it('counts the viewer\'s days, and compares with the same number of days before', () => {
    const rows = [row({ at: at(10, 0) }), row({ at: at(10, 23) }), row({ at: at(9) }), row({ at: at(5) }), row({ at: at(4) }), row({ at: at(1) })]
    const p = period(rows, 3, NOW) // 8,9,10 now; 5,6,7 before
    expect(p.current.count).toBe(3)
    expect(p.before.count).toBe(1)
    expect(p.daily).toEqual([0, 1, 2])
  })

  it('includes everything that happened today, even after the current time', () => {
    expect(period([row({ at: at(10, 23) })], 7, NOW).current.count).toBe(1)
  })

  it('leaves out tomorrow and before the window', () => {
    expect(period([row({ at: at(11, 1) }), row({ at: at(2) })], 3, NOW).current.count).toBe(0)
  })
})

describe('summarise', () => {
  it('counts outcomes and takes the median time, not the mean', () => {
    const s = summarise([row({ duration_ms: 10 }), row({ duration_ms: 20 }), row({ duration_ms: 9000, outcome: 'failed' }), row({ outcome: 'declined', duration_ms: null })])
    expect(s).toMatchObject({ count: 4, ok: 2, failed: 1, declined: 1, medianMs: 20 })
  })

  it('has no median when nothing was timed', () => {
    expect(summarise([row({ duration_ms: null })]).medianMs).toBeNull()
    expect(summarise([]).medianMs).toBeNull()
  })

  it('averages the middle pair for an even count', () => {
    expect(summarise([row({ duration_ms: 10 }), row({ duration_ms: 30 })]).medianMs).toBe(20)
  })
})

describe('change', () => {
  it('is a signed percentage against the period before', () => {
    expect(change(15, 10)).toBe(50)
    expect(change(5, 10)).toBe(-50)
  })
  it('has nothing to say when there was nothing before', () => {
    expect(change(4, 0)).toBeNull()
    expect(change(0, 0)).toBe(0)
  })
})

describe('columns and series', () => {
  const rows = [
    row({ tool: 'meet_ai__x' }), row({ tool: 'meet_ai__y' }), row({ tool: 'audiobook__job_status' }),
    row({ tool: 'assistant__remember', at: at(9) }), row({ tool: 'brand_new__thing' }),
  ]

  it('gives each day a count per tool, with unknown servers folded into "other"', () => {
    const cols = columns(lastDays(2, NOW), rows, NOW)
    expect(cols[1]!.values).toEqual({ 'meet-ai': 2, audiobook: 1, other: 1 })
    expect(cols[0]!.values).toEqual({ assistant: 1 })
    expect(cols[1]!.tick).toBe('Today')
  })

  it('draws only the tools that did something, in their fixed order, with their own colours', () => {
    const s = seriesFor(rows)
    expect(s.map((x) => x.key)).toEqual(['meet-ai', 'assistant', 'audiobook', 'other'])
    // Colour follows the entity: audiobook is slot 5 whether or not slot 2 and 3 are on screen.
    expect(s.find((x) => x.key === 'audiobook')!.color).toBe('var(--s5)')
    expect(s.find((x) => x.key === 'meet-ai')!.color).toBe('var(--s1)')
    expect(s.find((x) => x.key === 'other')!.color).toBe('var(--s-other)')
  })

  it('shows a month when it starts or changes', () => {
    const cols = columns(lastDays(3, new Date(2026, 10, 2, 9)), [], new Date(2026, 10, 2, 9))
    expect(cols.map((c) => c.tick)).toEqual([expect.stringMatching(/^31 /), expect.stringMatching(/^1 /), 'Today'])
  })
})

describe('medianByTool', () => {
  it('ranks tools by their median time, slowest first', () => {
    const out = medianByTool([row({ tool: 'meet_ai__a', duration_ms: 50 }), row({ tool: 'audiobook__a', duration_ms: 4000 }), row({ tool: 'meet_ai__b', duration_ms: 70 })])
    expect(out.map((o) => [o.key, o.ms])).toEqual([['audiobook', 4000], ['meet-ai', 60]])
  })
})
