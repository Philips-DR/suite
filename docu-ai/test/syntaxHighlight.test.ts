import { describe, expect, it } from 'vitest'
import { highlightCode } from '../src/plan/syntaxHighlight.js'

describe('highlightCode', () => {
  it('returns undefined for a language lowlight has no grammar for, rather than throwing', () => {
    expect(highlightCode('not-a-real-language', 'whatever')).toBeUndefined()
  })

  it('tokenizes a registered language into kind/text pairs', () => {
    const tokens = highlightCode('python', 'x = 1')
    expect(tokens).toBeDefined()
    expect(tokens?.map((t) => t.text).join('')).toBe('x = 1')
    expect(tokens?.some((t) => t.kind === 'number' && t.text === '1')).toBe(true)
  })

  it('registers dockerfile, unlike lowlight’s smaller "common" bundle', () => {
    const tokens = highlightCode('dockerfile', 'FROM node:20')
    expect(tokens).toBeDefined()
    expect(tokens?.some((t) => t.kind === 'keyword' && t.text === 'FROM')).toBe(true)
  })

  it('reassembles to the exact original source with no characters lost or duplicated', () => {
    const code = 'def f(x):\n    return x + 1\n'
    const tokens = highlightCode('python', code)!
    expect(tokens.map((t) => t.text).join('')).toBe(code)
  })

  it('takes the first hljs-* class when a span carries more than one', () => {
    // Python's `self` is a real two-class case found in the real corpus: ["hljs-variable",
    // "language_"] — the second class has no hljs- prefix and must be ignored, not concatenated.
    const tokens = highlightCode('python', 'return self.x\n')!
    const self = tokens.find((t) => t.text === 'self')
    expect(self?.kind).toBe('variable')
  })

  it('leaves unclassified text (whitespace, punctuation) with kind undefined', () => {
    const tokens = highlightCode('python', 'def f(x):')!
    expect(tokens.some((t) => t.kind === undefined && t.text.length > 0)).toBe(true)
  })
})
