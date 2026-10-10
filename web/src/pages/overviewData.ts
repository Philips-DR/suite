// What the Overview shows, worked out from the audit log. Pure functions over plain rows, so the
// date arithmetic (the easiest thing here to get quietly wrong) is tested.

import { TOOLS, isTool, toolName, toolOf } from '../charts/palette'
import type { Column, Series } from '../charts/StackedColumns'

export interface Row {
  at: string
  tool: string
  outcome: string
  origin?: string
  duration_ms?: number | null
}

/** A local calendar day as YYYY-MM-DD: "today" means the viewer's today, not UTC's. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** The `n` days ending today, oldest first, each at local midnight. */
export function lastDays(n: number, now: Date = new Date()): Date[] {
  const today = startOfDay(now)
  return Array.from({ length: n }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i)))
}

/** Which series a row belongs to: its tool, or "other" for a server this page does not know. */
export const seriesOf = (row: Row): string => {
  const tool = toolOf(row.tool)
  return isTool(tool) ? tool : 'other'
}

export interface Summary {
  count: number
  ok: number
  failed: number
  declined: number
  medianMs: number | null
}

export function summarise(rows: Row[]): Summary {
  const times = rows.map((r) => r.duration_ms).filter((m): m is number => typeof m === 'number').sort((a, b) => a - b)
  const mid = times.length >> 1
  return {
    count: rows.length,
    ok: rows.filter((r) => r.outcome === 'ok').length,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    declined: rows.filter((r) => r.outcome === 'declined').length,
    medianMs: times.length === 0 ? null : times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2,
  }
}

/** Rows inside [from, to): from is local midnight, so a day is whole. */
export const within = (rows: Row[], from: Date, to: Date): Row[] =>
  rows.filter((r) => {
    const t = new Date(r.at).getTime()
    return t >= from.getTime() && t < to.getTime()
  })

export interface Period {
  days: Date[]
  rows: Row[]
  previous: Row[]
  current: Summary
  before: Summary
  daily: number[]
}

/** The last `n` days, and the `n` before them to compare against. */
export function period(all: Row[], n: number, now: Date = new Date()): Period {
  const days = lastDays(n, now)
  const start = days[0]!
  const end = new Date(days[n - 1]!.getFullYear(), days[n - 1]!.getMonth(), days[n - 1]!.getDate() + 1)
  const prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - n)
  const rows = within(all, start, end)
  const previous = within(all, prevStart, start)
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const k = dayKey(new Date(r.at))
    byDay.set(k, (byDay.get(k) ?? 0) + 1)
  }
  return { days, rows, previous, current: summarise(rows), before: summarise(previous), daily: days.map((d) => byDay.get(dayKey(d)) ?? 0) }
}

const fullDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const shortMonth = new Intl.DateTimeFormat(undefined, { month: 'short' })

/** One column per day with a count per series, in the fixed series order. */
export function columns(days: Date[], rows: Row[], now: Date = new Date()): Column[] {
  const grid = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const k = dayKey(new Date(r.at))
    const cell = grid.get(k) ?? {}
    const s = seriesOf(r)
    cell[s] = (cell[s] ?? 0) + 1
    grid.set(k, cell)
  }
  const today = dayKey(now)
  return days.map((d, i) => {
    const k = dayKey(d)
    const monthChanged = i === 0 || d.getDate() === 1
    return {
      key: k,
      label: k === today ? `Today, ${fullDay.format(d)}` : fullDay.format(d),
      tick: k === today ? 'Today' : monthChanged ? `${d.getDate()} ${shortMonth.format(d)}` : String(d.getDate()),
      values: grid.get(k) ?? {},
    }
  })
}

/** The series worth drawing: the tools that did anything in the period, in their fixed order. */
export function seriesFor(rows: Row[]): Series[] {
  const seen = new Set(rows.map(seriesOf))
  const known: Series[] = TOOLS.filter((t) => seen.has(t)).map((t) => ({ key: t, label: toolName(t), color: `var(--s${TOOLS.indexOf(t) + 1})` }))
  return seen.has('other') ? [...known, { key: 'other', label: 'Other', color: 'var(--s-other)' }] : known
}

/** Change against the period before, as a percentage; null when there is nothing to compare to. */
export function change(now: number, before: number): number | null {
  if (before === 0) return now === 0 ? 0 : null
  return Math.round(((now - before) / before) * 100)
}

/** Median action time per tool, slowest first, for the tools that have timings. */
export function medianByTool(rows: Row[]): { key: string; label: string; ms: number }[] {
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    if (typeof r.duration_ms !== 'number') continue
    const s = seriesOf(r)
    groups.set(s, [...(groups.get(s) ?? []), r])
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: key === 'other' ? 'Other' : toolName(key), ms: summarise(g).medianMs ?? 0 }))
    .sort((a, b) => b.ms - a.ms)
}
