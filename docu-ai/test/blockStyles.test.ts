import { describe, expect, it } from 'vitest'
import type { docs_v1 } from 'googleapis'
import { codeBlockStyleRequests, quoteStyleRequest } from '../src/emit/blocks.js'
import { technical } from '../src/theme/presets/technical.js'

const RANGE: docs_v1.Schema$Range = { startIndex: 10, endIndex: 40 }

describe('codeBlockStyleRequests', () => {
  // Always exactly [paragraph style, text style] by design — see codeBlockStyleRequests's own doc
  // comment — so asserting that shape once here is more honest than optional-chaining every use below.
  const requests = codeBlockStyleRequests(RANGE, technical)
  const paragraphReq = requests[0]!
  const textReq = requests[1]!

  it('returns exactly a paragraph-style request and a text-style request, same range', () => {
    expect(paragraphReq.updateParagraphStyle?.range).toEqual(RANGE)
    expect(textReq?.updateTextStyle?.range).toEqual(RANGE)
  })

  it('supplies all four borders identically, since a code block is a box, not an accent bar', () => {
    const style = paragraphReq.updateParagraphStyle?.paragraphStyle
    expect(style?.borderTop).toEqual(style?.borderBottom)
    expect(style?.borderBottom).toEqual(style?.borderLeft)
    expect(style?.borderLeft).toEqual(style?.borderRight)
  })

  it('zeroes indentStart/indentEnd, overriding the narrower prose measure every named style inherits', () => {
    const style = paragraphReq.updateParagraphStyle?.paragraphStyle
    expect(style?.indentStart).toEqual({ magnitude: 0, unit: 'PT' })
    expect(style?.indentEnd).toEqual({ magnitude: 0, unit: 'PT' })
  })

  it('sets keepLinesTogether, so a modest block cannot split across a page boundary', () => {
    expect(paragraphReq.updateParagraphStyle?.paragraphStyle?.keepLinesTogether).toBe(true)
  })

  it('never sets a per-run backgroundColor on the text style — the paragraph shading is the background', () => {
    expect(textReq?.updateTextStyle?.textStyle?.backgroundColor).toBeUndefined()
    expect(textReq?.updateTextStyle?.fields).not.toContain('background_color')
  })

  it('uses the theme’s codeBlock font, matching the residue lint’s exemption font', () => {
    expect(textReq?.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily).toBe(
      technical.codeBlock.text.font,
    )
  })

  it('sets the block’s own base foreground colour when not highlighted', () => {
    expect(textReq?.updateTextStyle?.fields).toContain('foreground_color')
    expect(textReq?.updateTextStyle?.textStyle?.foregroundColor).toBeDefined()
  })
})

describe('codeBlockStyleRequests — highlighted (M7)', () => {
  // The real trap this guards against: renderTextBlocks' own per-run foreground_color requests for
  // a highlighted block's tokens are issued BEFORE this one (see compile.ts), so a block-wide
  // foreground_color here would silently overwrite every token's own colour — same field, later
  // request wins, no error from either side. Confirmed live before this test was written.
  const highlighted = codeBlockStyleRequests(RANGE, technical, true)
  const highlightedTextReq = highlighted[1]!

  it('drops foreground_color from the mask entirely when the block is highlighted', () => {
    expect(highlightedTextReq.updateTextStyle?.fields).not.toContain('foreground_color')
    expect(highlightedTextReq.updateTextStyle?.textStyle?.foregroundColor).toBeUndefined()
  })

  it('keeps every other text field (font, size, weight) untouched by the highlighted flag', () => {
    const fields = highlightedTextReq.updateTextStyle?.fields?.split(',')
    expect(fields).toEqual(expect.arrayContaining(['weighted_font_family', 'font_size', 'bold', 'italic']))
    expect(highlightedTextReq.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily).toBe(
      technical.codeBlock.text.font,
    )
  })
})

describe('quoteStyleRequest', () => {
  const ranges: docs_v1.Schema$Range[] = [
    { startIndex: 1, endIndex: 5 },
    { startIndex: 6, endIndex: 10 },
    { startIndex: 11, endIndex: 15 },
  ]

  it('spans from the first paragraph’s start to the last paragraph’s end', () => {
    const req = quoteStyleRequest(ranges, { depth: 1, start: 0, end: 3 }, technical)
    expect(req.updateParagraphStyle?.range).toEqual({ startIndex: 1, endIndex: 15 })
  })

  // Not indentStart: verified live that Docs' PDF export ignores it completely, at any magnitude,
  // named-style or per-paragraph, with or without a border — see the note on BlockquoteSpec. A
  // thicker, more padded border is what's actually provable on the page, so depth scales that instead.
  it('never sends indentStart — it is a proven no-op in Docs’ PDF export', () => {
    const req = quoteStyleRequest(ranges, { depth: 1, start: 0, end: 1 }, technical)
    expect(req.updateParagraphStyle?.paragraphStyle?.indentStart).toBeUndefined()
    expect(req.updateParagraphStyle?.fields).not.toContain('indent_start')
  })

  it('scales border width and padding with depth, so nested quotes get a visibly heavier bar', () => {
    const depth1 = quoteStyleRequest(ranges, { depth: 1, start: 0, end: 1 }, technical)
    const depth2 = quoteStyleRequest(ranges, { depth: 2, start: 0, end: 1 }, technical)
    const b1 = depth1.updateParagraphStyle?.paragraphStyle?.borderLeft
    const b2 = depth2.updateParagraphStyle?.paragraphStyle?.borderLeft
    expect(b1?.width).toEqual({ magnitude: technical.blockquote.borderWidthPt, unit: 'PT' })
    expect(b2?.width?.magnitude).toBeGreaterThan(b1?.width?.magnitude ?? 0)
    expect(b2?.padding?.magnitude).toBeGreaterThan(b1?.padding?.magnitude ?? 0)
  })

  it('keeps the same border colour regardless of depth — only width/padding scale', () => {
    const depth1 = quoteStyleRequest(ranges, { depth: 1, start: 0, end: 1 }, technical)
    const depth2 = quoteStyleRequest(ranges, { depth: 2, start: 0, end: 1 }, technical)
    expect(depth1.updateParagraphStyle?.paragraphStyle?.borderLeft?.color).toEqual(
      depth2.updateParagraphStyle?.paragraphStyle?.borderLeft?.color,
    )
  })

  it('throws rather than silently styling the wrong paragraphs when the run is out of range', () => {
    expect(() => quoteStyleRequest(ranges, { depth: 1, start: 5, end: 6 }, technical)).toThrow(
      /out of range/,
    )
  })
})
