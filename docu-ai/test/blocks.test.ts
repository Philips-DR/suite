import { describe, expect, it } from 'vitest'
import { compileBlocks } from '../src/emit/blocks.js'
import { plain } from '../src/plan/types.js'
import type { Block } from '../src/plan/types.js'

describe('compileBlocks — headings and paragraphs', () => {
  it('maps heading level directly to HEADING_N', () => {
    const blocks: Block[] = [{ kind: 'heading', level: 2, children: plain('x') }]
    expect(compileBlocks(blocks).textBlocks[0]?.style).toBe('HEADING_2')
  })

  it('passes a paragraph through as NORMAL_TEXT with its runs intact', () => {
    const blocks: Block[] = [{ kind: 'paragraph', children: plain('hello') }]
    const { textBlocks } = compileBlocks(blocks)
    expect(textBlocks[0]).toEqual({ runs: plain('hello'), style: 'NORMAL_TEXT' })
  })
})

describe('compileBlocks — lists', () => {
  it('prefixes each item with depth-many tabs, expressed as a plain leading run', () => {
    const blocks: Block[] = [
      {
        kind: 'list',
        items: [
          { depth: 0, ordered: false, children: plain('top') },
          { depth: 1, ordered: false, children: plain('mid') },
        ],
      },
    ]
    const { textBlocks } = compileBlocks(blocks)
    expect(textBlocks[0]?.runs).toEqual(plain('top'))
    expect(textBlocks[1]?.runs).toEqual([{ kind: 'text', text: '\t' }, { kind: 'text', text: 'mid' }])
  })

  it('records one ListRun spanning every item, tagged with the list’s own ordered flag', () => {
    const blocks: Block[] = [
      {
        kind: 'list',
        items: [
          { depth: 0, ordered: true, children: plain('a') },
          { depth: 0, ordered: true, children: plain('b') },
          { depth: 1, ordered: true, children: plain('c') },
        ],
      },
    ]
    expect(compileBlocks(blocks).listRuns).toEqual([{ ordered: true, start: 0, end: 3 }])
  })

  // Found live in 01-api-layer.md: an ordered top-level step ("5. Applies...") with unordered
  // sub-bullets nested under it. createParagraphBullets picks one glyph family per call, so forcing
  // the whole range into the outer list's `ordered: true` rendered the nested bullets as "a./b./c."
  // instead of discs — wrong relative to the source, even though it read as plausible on the page.
  it('splits one list into multiple ListRuns at each ordered/unordered transition', () => {
    const blocks: Block[] = [
      {
        kind: 'list',
        items: [
          { depth: 0, ordered: true, children: plain('1') },
          { depth: 0, ordered: true, children: plain('2') },
          { depth: 1, ordered: false, children: plain('a') },
          { depth: 1, ordered: false, children: plain('b') },
          { depth: 0, ordered: true, children: plain('3') },
        ],
      },
    ]
    expect(compileBlocks(blocks).listRuns).toEqual([
      { ordered: true, start: 0, end: 2 },
      { ordered: false, start: 2, end: 4 },
      { ordered: true, start: 4, end: 5 },
    ])
  })

  it('keeps two separate lists as two separate ListRuns', () => {
    const list = (): Block => ({ kind: 'list', items: [{ depth: 0, ordered: false, children: plain('x') }] })
    const { listRuns } = compileBlocks([list(), { kind: 'paragraph', children: plain('between') }, list()])
    expect(listRuns).toEqual([
      { ordered: false, start: 0, end: 1 },
      { ordered: false, start: 2, end: 3 },
    ])
  })
})

describe('compileBlocks — rules', () => {
  it('emits a single-space placeholder and records its index', () => {
    const { textBlocks, ruleIndices } = compileBlocks([{ kind: 'rule' }])
    expect(textBlocks[0]).toEqual({ runs: [{ kind: 'text', text: ' ' }], style: 'NORMAL_TEXT' })
    expect(ruleIndices).toEqual([0])
  })
})

describe('compileBlocks — fenced code blocks', () => {
  it('emits ONE paragraph for the whole block, lines joined by a hard break', () => {
    // One paragraph (not one per line) is what lets a single shading/border/keepLinesTogether
    // application cover the whole block with no per-line gaps — the M1 gap M2 exists to close.
    const blocks: Block[] = [{ kind: 'code-block', lang: 'python', code: 'a = 1\nb = 2' }]
    const { textBlocks, codeBlockIndices } = compileBlocks(blocks)
    expect(textBlocks).toEqual([
      {
        runs: [{ kind: 'text', text: 'a = 1' }, { kind: 'break' }, { kind: 'text', text: 'b = 2' }],
        style: 'NORMAL_TEXT',
      },
    ])
    expect(codeBlockIndices).toEqual([0])
  })

  it('turns a blank code line into a single space rather than an empty segment', () => {
    const blocks: Block[] = [{ kind: 'code-block', lang: undefined, code: 'a\n\nb' }]
    const { textBlocks } = compileBlocks(blocks)
    expect(textBlocks[0]?.runs).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'break' },
      { kind: 'text', text: ' ' },
      { kind: 'break' },
      { kind: 'text', text: 'b' },
    ])
  })

  it('records the code block’s own index, not one per line', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', children: plain('before') },
      { kind: 'code-block', lang: undefined, code: 'x\ny\nz' },
      { kind: 'paragraph', children: plain('after') },
    ]
    expect(compileBlocks(blocks).codeBlockIndices).toEqual([1])
  })
})

describe('compileBlocks — degraded tables', () => {
  it('joins cells with spaces, never a pipe character', () => {
    const blocks: Block[] = [
      { kind: 'table', align: [undefined, undefined], rows: [[plain('a'), plain('b')]] },
    ]
    const { textBlocks } = compileBlocks(blocks)
    const text = (textBlocks[0]!.runs[0] as { kind: 'text'; text: string }).text
    expect(text).toBe('a   b')
    expect(text).not.toContain('|')
  })

  it('substitutes a space for a wholly empty cell, never an empty paragraph', () => {
    const blocks: Block[] = [{ kind: 'table', align: [undefined], rows: [[[]]] }]
    expect(() => compileBlocks(blocks)).not.toThrow()
  })
})

describe('compileBlocks — blockquotes', () => {
  it('recurses into a blockquote’s children as ordinary blocks', () => {
    const blocks: Block[] = [{ kind: 'blockquote', children: [{ kind: 'paragraph', children: plain('q') }] }]
    expect(compileBlocks(blocks).textBlocks).toEqual([{ runs: plain('q'), style: 'NORMAL_TEXT' }])
  })

  it('records a QuoteRun spanning every block the quote produced', () => {
    const blocks: Block[] = [
      {
        kind: 'blockquote',
        children: [
          { kind: 'paragraph', children: plain('one') },
          { kind: 'paragraph', children: plain('two') },
        ],
      },
    ]
    expect(compileBlocks(blocks).quoteRuns).toEqual([{ depth: 1, start: 0, end: 2 }])
  })

  it('increments depth for a nested blockquote and records both as separate runs', () => {
    const blocks: Block[] = [
      {
        kind: 'blockquote',
        children: [
          { kind: 'paragraph', children: plain('outer') },
          { kind: 'blockquote', children: [{ kind: 'paragraph', children: plain('inner') }] },
        ],
      },
    ]
    // Depth-first recursion means the inner quote's run is pushed before the outer's — order that
    // doesn't matter downstream, since compileDocument re-sorts by depth before applying either.
    expect(compileBlocks(blocks).quoteRuns).toEqual([
      { depth: 2, start: 1, end: 2 },
      { depth: 1, start: 0, end: 2 }, // the outer quote's range covers the nested content too
    ])
  })

  it('records no QuoteRun for an empty blockquote', () => {
    expect(compileBlocks([{ kind: 'blockquote', children: [] }]).quoteRuns).toEqual([])
  })

  it('keeps content outside any blockquote out of quoteRuns', () => {
    const blocks: Block[] = [
      { kind: 'paragraph', children: plain('plain') },
      { kind: 'blockquote', children: [{ kind: 'paragraph', children: plain('quoted') }] },
    ]
    expect(compileBlocks(blocks).quoteRuns).toEqual([{ depth: 1, start: 1, end: 2 }])
  })
})
