import { describe, expect, it } from 'vitest'
import { parseHash } from './useRoute'
import { ago, clock } from './time'

describe('parseHash', () => {
  it('opens the page the URL names', () => {
    expect(parseHash('#meetings')).toBe('meetings')
    expect(parseHash('#audiobooks')).toBe('audiobooks')
    expect(parseHash('#chat')).toBe('chat')
  })
  it('still understands the old two-mode URLs', () => {
    expect(parseHash('#buttons/mail')).toBe('mail')
    expect(parseHash('#buttons/settings')).toBe('settings')
    expect(parseHash('#buttons')).toBe('overview')
  })
  it('falls back to the overview for nothing, or for a page that does not exist', () => {
    expect(parseHash('')).toBe('overview')
    expect(parseHash('#nope')).toBe('overview')
    expect(parseHash('#buttons/nope')).toBe('overview')
  })
})

describe('ago', () => {
  const now = new Date('2026-10-10T12:00:00Z').getTime()
  const before = (seconds: number) => new Date(now - seconds * 1000)
  it('says how long ago, in the unit a person would use', () => {
    expect(ago(before(10), now)).toBe('just now')
    expect(ago(before(5 * 60), now)).toBe('5 min ago')
    expect(ago(before(3 * 3600), now)).toBe('3 h ago')
    expect(ago(before(2 * 86400), now)).toBe('2 d ago')
  })
  it('never says a time is in the future', () => {
    expect(ago(new Date(now + 60_000), now)).toBe('just now')
  })
})

describe('clock', () => {
  it('shows minutes and seconds, adding hours only when there are some', () => {
    expect([0, 59, 125, 3599, 3600, 3725].map(clock)).toEqual(['00:00', '00:59', '02:05', '59:59', '1:00:00', '1:02:05'])
    expect(clock(null)).toBe('00:00')
  })
})
