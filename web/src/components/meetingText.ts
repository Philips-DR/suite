// How a meeting is named on the page, from what meet-ai knows of it: the name its minutes verified, else the date its
// recording's file name gives, else the file name. Pure, so it is tested; nothing here guesses a date.

export interface MeetingFacts {
  markdown: string
  source?: string | null
  recorded?: string | null
  duration_seconds?: number | null
  speakers?: number | null
  meeting?: string | null
}

const base = (path: string) => path.split('/').pop() ?? path

/** "Voice 260915_140601 (no speakers)" from its transcript's path. */
export const stemOf = (path: string) => base(path).replace(/(\.timeline\.json|\.md)$/, '')

/** An audio file's name without its folder or extension. */
export const audioStem = (path: string) => base(path).replace(/\.[^.]+$/, '')

/** "20 s", "5 min", "2 h 05 min". Nothing for an unknown length. */
export function lengthText(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const minutes = Math.round(s / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

const whenFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The time a recording began, as its recorder wrote it (local time, so read as local time). */
export function recordedText(recorded: string | null | undefined, format: Intl.DateTimeFormat = whenFormat): string {
  if (!recorded) return ''
  const when = new Date(recorded)
  return Number.isNaN(when.getTime()) ? '' : format.format(when)
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function meetingName(t: MeetingFacts, format?: Intl.DateTimeFormat): string {
  if (t.meeting?.trim()) return capital(t.meeting.trim())
  return recordedText(t.recorded, format) || stemOf(t.markdown)
}

/** The line under the name: its date when the name is not already the date, its length, its speakers. */
export function meetingFacts(t: MeetingFacts, format?: Intl.DateTimeFormat): string {
  const named = Boolean(t.meeting?.trim())
  return [
    named ? recordedText(t.recorded, format) : '',
    lengthText(t.duration_seconds),
    t.speakers ? `${t.speakers} speaker${t.speakers === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
}

/** A Google Doc's name for notes or minutes, as meet-ai names them itself: "Minutes of the …", else by the meeting. */
export function writeupTitle(label: 'Notes' | 'Minutes', t: MeetingFacts, format?: Intl.DateTimeFormat): string {
  if (t.meeting?.trim()) return `${label} of the ${t.meeting.trim()}`
  return `${label} — ${meetingName(t, format)}`
}
