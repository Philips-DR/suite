import { describe, expect, it } from 'vitest'
import { flattenInline, plainText } from '../src/emit/inline.js'
import type { Inline } from '../src/plan/types.js'

describe('flattenInline', () => {
  it('passes plain text through untouched', () => {
    expect(flattenInline([{ kind: 'text', text: 'hello' }])).toEqual([
      { text: 'hello', marks: [], href: undefined },
    ])
  })

  it('marks a bold span and recurses into its children', () => {
    const nodes: Inline[] = [{ kind: 'bold', children: [{ kind: 'text', text: 'strong' }] }]
    expect(flattenInline(nodes)).toEqual([{ text: 'strong', marks: ['bold'], href: undefined }])
  })

  it('combines nested marks, e.g. bold italic', () => {
    const nodes: Inline[] = [
      { kind: 'bold', children: [{ kind: 'italic', children: [{ kind: 'text', text: 'x' }] }] },
    ]
    expect(flattenInline(nodes)[0]?.marks.sort()).toEqual(['bold', 'italic'])
  })

  it('tags an inline code span with the code mark', () => {
    expect(flattenInline([{ kind: 'code', text: 'x = 1' }])).toEqual([
      { text: 'x = 1', marks: ['code'], href: undefined },
    ])
  })

  it('carries the href across every run inside a link, including nested marks', () => {
    const nodes: Inline[] = [
      {
        kind: 'link',
        href: 'https://example.com',
        children: [{ kind: 'text', text: 'see ' }, { kind: 'bold', children: [{ kind: 'text', text: 'here' }] }],
      },
    ]
    const runs = flattenInline(nodes)
    expect(runs).toEqual([
      { text: 'see ', marks: [], href: 'https://example.com' },
      { text: 'here', marks: ['bold'], href: 'https://example.com' },
    ])
  })

  it('carries chapterIndex across every run inside a chapterLink, leaving href unset', () => {
    const nodes: Inline[] = [
      {
        kind: 'chapterLink',
        chapterIndex: 2,
        children: [{ kind: 'text', text: 'see ' }, { kind: 'bold', children: [{ kind: 'text', text: 'ch. 3' }] }],
      },
    ]
    const runs = flattenInline(nodes)
    expect(runs).toEqual([
      { text: 'see ', marks: [], href: undefined, chapterLink: 2 },
      { text: 'ch. 3', marks: ['bold'], href: undefined, chapterLink: 2 },
    ])
  })

  it('does not merge a chapterLink run into an adjacent run with identical marks but no link', () => {
    const nodes: Inline[] = [
      { kind: 'chapterLink', chapterIndex: 0, children: [{ kind: 'text', text: 'x' }] },
      { kind: 'text', text: 'x' },
    ]
    expect(flattenInline(nodes)).toHaveLength(2)
  })

  it('turns a hard break into a literal \\v', () => {
    const nodes: Inline[] = [{ kind: 'text', text: 'a' }, { kind: 'break' }, { kind: 'text', text: 'b' }]
    expect(plainText(flattenInline(nodes))).toBe('a\vb')
  })

  it('merges adjacent runs that share identical styling', () => {
    const nodes: Inline[] = [
      { kind: 'bold', children: [{ kind: 'text', text: 'foo' }, { kind: 'text', text: 'bar' }] },
    ]
    expect(flattenInline(nodes)).toEqual([{ text: 'foobar', marks: ['bold'], href: undefined }])
  })

  it('does not merge runs across a style change, even with identical text', () => {
    const nodes: Inline[] = [
      { kind: 'text', text: 'x' },
      { kind: 'bold', children: [{ kind: 'text', text: 'x' }] },
    ]
    expect(flattenInline(nodes)).toHaveLength(2)
  })

  it('drops zero-length text and code runs rather than emitting an empty style range', () => {
    expect(flattenInline([{ kind: 'text', text: '' }, { kind: 'text', text: 'a' }])).toEqual([
      { text: 'a', marks: [], href: undefined },
    ])
  })

  it('resolves a link nested in a link to the inner href', () => {
    const nodes: Inline[] = [
      {
        kind: 'link',
        href: 'https://outer.example',
        children: [{ kind: 'link', href: 'https://inner.example', children: [{ kind: 'text', text: 'x' }] }],
      },
    ]
    expect(flattenInline(nodes)[0]?.href).toBe('https://inner.example')
  })
})

describe('plainText', () => {
  it('concatenates run text with no separators', () => {
    expect(
      plainText([
        { text: 'a', marks: [], href: undefined, chapterLink: undefined },
        { text: 'b', marks: ['code'], href: undefined, chapterLink: undefined },
      ]),
    ).toBe('ab')
  })
})
