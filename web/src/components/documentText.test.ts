import { describe, expect, it } from 'vitest'
import { lookFor, madeLine, pagesLine, sharingNames } from './documentText'

describe('lookFor', () => {
  it('reads the real upload names the way a person would', () => {
    expect(lookFor('Cover Letter - Digital Evolution Specialist (GIS)')).toBe('letter')
    expect(lookFor('CV - Digital Evolution Specialist (GIS) v2')).toBe('resume')
    expect(lookFor('CV - ML Engineer')).toBe('resume')
    expect(lookFor('Résumé 2026')).toBe('resume')
    expect(lookFor('My_CV')).toBe('resume')
  })

  it('does not find a letter or a CV inside another word', () => {
    expect(lookFor('October newsletter')).toBe('technical')
    expect(lookFor('cvs-backup notes')).toBe('technical')
    expect(lookFor('API handbook')).toBe('technical')
  })
})

describe('madeLine', () => {
  const ago = (when: string) => `ago(${when.slice(0, 10)})`
  const now = new Date('2026-10-31T12:00:00Z').getTime()

  it('names the day it was made, and an edit long after', () => {
    const line = madeLine('2026-10-14T12:03:44Z', '2026-10-25T09:00:00Z', ago, now)
    expect(line).toMatch(/^Made .+ · edited ago\(2026-10-25\)$/)
  })

  it('leaves out the minute of editing a build does to its own new Doc', () => {
    expect(madeLine('2026-10-14T12:03:44Z', '2026-10-14T12:04:30Z', ago, now)).not.toContain('edited')
  })

  it('tells two documents made on the same day apart by their time', () => {
    const a = madeLine('2026-10-14T09:03:00Z', '2026-10-14T09:03:00Z', ago, now)
    const b = madeLine('2026-10-14T15:41:00Z', '2026-10-14T15:41:00Z', ago, now)
    expect(a).not.toBe(b)
  })

  it('says only what it knows when the date is missing', () => {
    expect(madeLine('', '2026-10-25T09:00:00Z', ago, now)).toBe('Edited ago(2026-10-25)')
    expect(madeLine('', '', ago, now)).toBe('')
  })
})

describe('sharingNames', () => {
  it('counts every document whose name another one has too, as on the real list', () => {
    const names = [...Array(7).fill('Philip Baah Afriyie'), 'Philip Baah Afriyie — CV (AfricaRice)', 'Cover letter', 'cover letter ']
    expect(sharingNames(names)).toBe(9)
  })

  it('is nought when every name is its own', () => {
    expect(sharingNames(['CV - ML Engineer', 'Cover Letter - GIS'])).toBe(0)
  })
})

describe('pagesLine', () => {
  it('says the page count', () => {
    expect(pagesLine({ measured: true, pages: 2, lastPageLines: 30, warnings: [] })).toBe('2 pages')
    expect(pagesLine({ measured: true, pages: 1, lastPageLines: 30, warnings: [] })).toBe('1 page')
  })

  it('says why the pages were not counted, never nothing', () => {
    expect(pagesLine({ measured: false, reason: 'a document of several tabs is not measured' })).toBe(
      'Pages not counted: a document of several tabs is not measured.',
    )
    expect(pagesLine(undefined)).toBe('Pages not counted.')
  })
})
