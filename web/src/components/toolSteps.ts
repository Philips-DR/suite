// What Chat and an approval card say about a tool call, in a person's words: its title, what it was asked as labelled
// fields rather than a block of JSON, and what came back. Pure, so it is tested.

import type { AssistantEvent } from '../api'
import { humanise } from '../ui/toolMeta'

/** The title a tool gives itself ("Write a new draft"), else its name in words ("Draft new"). */
export function stepTitle(qualified: string | undefined, titles: Record<string, string>): string {
  if (!qualified) return ''
  return titles[qualified] || humanise(qualified.split('__')[1] ?? qualified)
}

/** "documentId" -> "Document id", "max_pages" -> "Max pages", "to" -> "To". */
export function fieldLabel(key: string): string {
  return humanise(key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase())
}

/** Each argument as a label and the text to show: a string as written, a list of short words joined, anything else
 * as indented JSON. Every value is shown whole; the page wraps it rather than cutting it. */
export function fieldsOf(args: Record<string, unknown> | undefined): [string, string][] {
  return Object.entries(args ?? {}).map(([key, value]) => {
    if (typeof value === 'string') return [fieldLabel(key), value]
    if (typeof value === 'number' || typeof value === 'boolean') return [fieldLabel(key), String(value)]
    if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length <= 80)) return [fieldLabel(key), value.join(', ')]
    return [fieldLabel(key), JSON.stringify(value, null, 2)]
  })
}

// The backend sends at most this much of a result with each event (session.py).
const RESULT_LIMIT = 2000

/** A result as text to read: JSON indented, anything else as it came, and whether the backend cut it short. */
export function resultText(result: string | undefined): { text: string; cut: boolean } {
  if (!result) return { text: '', cut: false }
  const cut = result.length >= RESULT_LIMIT
  try {
    return { text: JSON.stringify(JSON.parse(result), null, 2), cut }
  } catch {
    return { text: result, cut }
  }
}

export interface Step {
  seq: number
  tool: string
  outcome: string
  origin: 'chat' | 'button'
  arguments?: Record<string, unknown>
  result?: string
}

/** A finished call with what it was asked: each `tool_finished` takes the latest `tool_started` of the same tool
 * before it that no other finish has taken. A declined call never started, so it has no arguments here. */
export function pairSteps(events: AssistantEvent[]): Map<number, Step> {
  const started: AssistantEvent[] = []
  const steps = new Map<number, Step>()
  for (const event of events) {
    if (event.type === 'tool_started') started.push(event)
    if (event.type !== 'tool_finished') continue
    let at = started.length - 1
    while (at >= 0 && !(started[at]!.tool === event.tool && (started[at]!.origin ?? 'chat') === (event.origin ?? 'chat'))) at--
    const begun = at >= 0 && event.outcome !== 'declined' ? started.splice(at, 1)[0] : undefined
    steps.set(event.seq, {
      seq: event.seq,
      tool: event.tool ?? '',
      outcome: event.outcome ?? 'ok',
      origin: event.origin === 'button' ? 'button' : 'chat',
      arguments: begun?.arguments,
      result: event.result,
    })
  }
  return steps
}

/** How many of these did not go through: "1 declined · 1 failed", or nothing. */
export function stepsTrouble(steps: Step[]): string {
  const declined = steps.filter((s) => s.outcome === 'declined').length
  const failed = steps.filter((s) => s.outcome === 'failed').length
  return [declined ? `${declined} declined` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ')
}

/** One line for a group of steps: "3 steps", with how many were declined or failed. */
export function stepsSummary(steps: Step[]): string {
  return [`${steps.length} step${steps.length === 1 ? '' : 's'}`, stepsTrouble(steps)].filter(Boolean).join(' · ')
}
