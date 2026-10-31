import { describe, expect, it } from 'vitest'
import { audioStem, lengthText, meetingFacts, meetingName, recordedText, stemOf, writeupTitle } from './meetingText'

// A fixed format, so the tests do not depend on the machine's language.
const format = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const members = {
  markdown: '/data/meet-ai/transcripts/20260812_102457.md',
  source: '20260812_102457.m4a',
  recorded: '2026-08-12T10:24',
  duration_seconds: 7510,
  speakers: null,
  meeting: 'third quarter meeting, Akra Tema branch',
}
const voice = {
  markdown: '/data/meet-ai/transcripts/Voice 260915_140601 (no speakers).md',
  source: 'Voice 260915_140601.m4a',
  recorded: null,
  duration_seconds: 7328,
  speakers: 9,
  meeting: null,
}

describe('meetingName', () => {
  it('names a meeting as its minutes did, with a capital', () => {
    expect(meetingName(members, format)).toBe('Third quarter meeting, Akra Tema branch')
  })

  it('names one with no verified name by the time its recording began, read as the recorder wrote it', () => {
    expect(meetingName({ ...members, meeting: null }, format)).toBe('Wed, 12 Aug 2026, 10:24')
  })

  it('falls back to the file name, never a guessed date', () => {
    expect(meetingName(voice, format)).toBe('Voice 260915_140601 (no speakers)')
  })
})

describe('meetingFacts', () => {
  it('gives the date only when the name is not already the date', () => {
    expect(meetingFacts(members, format)).toBe('Wed, 12 Aug 2026, 10:24 · 2 h 05 min')
    expect(meetingFacts({ ...members, meeting: null }, format)).toBe('2 h 05 min')
  })

  it('counts speakers only when they were labelled', () => {
    expect(meetingFacts(voice, format)).toBe('2 h 02 min · 9 speakers')
    expect(meetingFacts({ ...voice, speakers: 1 }, format)).toBe('2 h 02 min · 1 speaker')
  })

  it('says nothing it does not know', () => {
    expect(meetingFacts({ markdown: 'x.md' }, format)).toBe('')
  })
})

describe('lengthText', () => {
  it('reads like a length', () => {
    expect(lengthText(20)).toBe('20 s')
    expect(lengthText(300)).toBe('5 min')
    expect(lengthText(7510)).toBe('2 h 05 min')
    expect(lengthText(3599)).toBe('1 h 00 min')
  })

  it('is empty for an unknown length', () => {
    expect(lengthText(null)).toBe('')
    expect(lengthText(Number.NaN)).toBe('')
  })
})

describe('the rest', () => {
  it('names a Google Doc of notes or minutes the way meet-ai titles them', () => {
    expect(writeupTitle('Minutes', members, format)).toBe('Minutes of the third quarter meeting, Akra Tema branch')
    expect(writeupTitle('Notes', voice, format)).toBe('Notes — Voice 260915_140601 (no speakers)')
  })

  it('takes the folder and extension off a file', () => {
    expect(stemOf('/a/b/20260812_102457.timeline.json')).toBe('20260812_102457')
    expect(audioStem('/data/meet-ai/audio/2026-09-28-000036.flac')).toBe('2026-09-28-000036')
  })

  it('shows no date for an unreadable one', () => {
    expect(recordedText('not a date', format)).toBe('')
  })
})
