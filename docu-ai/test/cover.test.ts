import { describe, expect, it } from 'vitest'
import { coverContentStyleRequests, coverInsertRequest } from '../src/emit/cover.js'
import { headingLinkRequests } from '../src/emit/text.js'
import { technical } from '../src/theme/presets/technical.js'

const ENTRIES = [
  { title: 'Chapter One', tabId: 't.ch1' },
  { title: 'Chapter Two', tabId: 't.ch2' },
]

describe('coverInsertRequest', () => {
  it('joins the title, "Contents", and every chapter title with newlines, appended to the cover tab', () => {
    const req = coverInsertRequest('My Book', ENTRIES, technical, 't.cover')
    expect(req.insertText?.endOfSegmentLocation).toEqual({ tabId: 't.cover' })
    expect(req.insertText?.text).toBe('My Book\nContents\nChapter One\nChapter Two')
  })

  it('never sends the insert itself with a numeric location — only endOfSegmentLocation', () => {
    const req = coverInsertRequest('T', [], technical, 't.cover')
    expect(req.insertText?.location).toBeUndefined()
  })
})

describe('coverContentStyleRequests', () => {
  const { requests, entryRanges } = coverContentStyleRequests('My Book', ENTRIES, technical, 't.cover', 1)

  it('styles the title paragraph as TITLE and "Contents" as HEADING_2', () => {
    const styles = requests
      .filter((r) => r.updateParagraphStyle)
      .map((r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType)
    expect(styles).toEqual(['TITLE', 'HEADING_2', 'NORMAL_TEXT', 'NORMAL_TEXT'])
  })

  it('scopes every request to the cover’s own tab', () => {
    for (const r of requests) expect(r.updateParagraphStyle?.range?.tabId).toBe('t.cover')
  })

  it('returns one range per chapter entry, tagged with its chapterIndex, skipping the title and "Contents" heading', () => {
    expect(entryRanges).toHaveLength(2)
    // "My Book" (7) + \n, "Contents" (8) + \n -> entry 1 starts at 1+8+9=18.
    expect(entryRanges[0]?.range.startIndex).toBe(18)
    expect(entryRanges.map((e) => e.chapterIndex)).toEqual([0, 1])
  })

  it('never includes an insertText request — that already happened in phase 2', () => {
    expect(requests.some((r) => r.insertText)).toBe(false)
  })
})

describe('headingLinkRequests', () => {
  const { entryRanges } = coverContentStyleRequests('My Book', ENTRIES, technical, 't.cover', 1)
  const headings = [
    { tabId: 't.ch1', headingId: 'h.one' },
    { tabId: 't.ch2', headingId: 'h.two' },
  ]

  it('points each entry’s link at its own chapter’s heading, via Link.heading not the legacy field', () => {
    const requests = headingLinkRequests(entryRanges, headings)
    expect(requests[0]?.updateTextStyle?.textStyle?.link).toEqual({
      heading: { id: 'h.one', tabId: 't.ch1' },
    })
    expect(requests[1]?.updateTextStyle?.textStyle?.link).toEqual({
      heading: { id: 'h.two', tabId: 't.ch2' },
    })
  })

  it('sets only the link field, letting Docs apply its own default colour and underline', () => {
    const [req] = headingLinkRequests(entryRanges, headings)
    expect(req?.updateTextStyle?.fields).toBe('link')
  })

  it('throws rather than silently mislinking when a chapterIndex has no matching heading', () => {
    expect(() => headingLinkRequests(entryRanges, [headings[0]!])).toThrow(/no heading target/)
  })

  it('resolves an arbitrary chapterIndex, not just positional order — an in-body link can point anywhere', () => {
    const outOfOrder = [{ range: { startIndex: 5, endIndex: 6 }, chapterIndex: 1 }]
    const requests = headingLinkRequests(outOfOrder, headings)
    expect(requests[0]?.updateTextStyle?.textStyle?.link).toEqual({
      heading: { id: 'h.two', tabId: 't.ch2' },
    })
  })
})
