import { describe, expect, it } from 'vitest'
import { tabTitle } from '../src/emit/document.js'

// Found building the full 9-chapter real corpus: Chapter 4's H1 was 68 characters and
// addDocumentTab rejected it live with "The tab title cannot be longer than 50 characters."
describe('tabTitle', () => {
  it('leaves a short title untouched', () => {
    expect(tabTitle('Chapter 1 — The API Layer')).toBe('Chapter 1 — The API Layer')
  })

  it('truncates a long title at a word boundary and marks it with an ellipsis', () => {
    const long = 'Chapter 4 — Reporting, Version Control, Automation & Notifications'
    const result = tabTitle(long)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith('…')).toBe(true)
    expect(long.startsWith(result.slice(0, -1))).toBe(true)
  })

  it('never exceeds the limit even with no word boundary to break on', () => {
    const long = 'a'.repeat(80)
    const result = tabTitle(long)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result.endsWith('…')).toBe(true)
  })

  it('is exactly a no-op at the limit itself', () => {
    const exact = 'a'.repeat(50)
    expect(tabTitle(exact)).toBe(exact)
  })
})
