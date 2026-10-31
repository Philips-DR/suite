import { describe, expect, it } from 'vitest'
import { cleanBody, firstWords } from './mailText'

describe('cleanBody', () => {
  it('folds a newsletter run of blank lines to one, as the real one with 122 in a row', () => {
    const text = `96                   ${'\n'.repeat(122)}Security Incident Update${'\n'.repeat(17)}Dear Binancian,\n\n\nWe are writing.`
    expect(cleanBody(text)).toBe('96\n\nSecurity Incident Update\n\nDear Binancian,\n\nWe are writing.')
  })

  it('counts a line of spaces or invisible padding as empty', () => {
    expect(cleanBody('a\n   \n ‌͏\n\t\nb')).toBe('a\n\nb')
  })

  it('keeps a single blank line between paragraphs and the indentation inside a line', () => {
    expect(cleanBody('Hi,\n\n  > quoted\nThanks')).toBe('Hi,\n\n  > quoted\nThanks')
  })

  it('drops blank lines at the start and the end, and Windows line ends', () => {
    expect(cleanBody('\r\n\r\nHello\r\n\r\n\r\n')).toBe('Hello')
  })

  it('leaves empty text empty', () => {
    expect(cleanBody('')).toBe('')
    expect(cleanBody('\n\n \n')).toBe('')
  })
})

describe('firstWords', () => {
  it('puts the opening on one line', () => {
    expect(firstWords('Dear Ann,\n\n\nThe review moved\nto Tuesday.')).toBe('Dear Ann, The review moved to Tuesday.')
  })

  it('cuts at a word, not inside one, and says it was cut', () => {
    const cut = firstWords('one two three four five six seven', 20)
    expect(cut).toBe('one two three four…')
  })

  it('keeps a short text whole', () => {
    expect(firstWords('Tuesday works.', 140)).toBe('Tuesday works.')
  })
})
