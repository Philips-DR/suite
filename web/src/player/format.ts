// How the player says a length of time: as a clock for the eye, in words for a screen reader.

const pad = (n: number) => String(n).padStart(2, '0')
const whole = (seconds: number) => (Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0)

/** 75 → "1:15", 3725 → "1:02:05". Anything that is not a positive number reads as "0:00". */
export function clock(seconds: number): string {
  const s = whole(seconds)
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** 75 → "1 minute 15 seconds". */
export function spoken(seconds: number): string {
  const s = whole(seconds)
  const parts = [[Math.floor(s / 3600), 'hour'], [Math.floor((s % 3600) / 60), 'minute'], [s % 60, 'second']] as const
  const said = parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`)
  return said.length ? said.join(' ') : '0 seconds'
}
