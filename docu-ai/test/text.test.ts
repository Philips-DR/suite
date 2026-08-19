import { describe, expect, it } from 'vitest'
import { BODY_START, renderTextBlocks } from '../src/emit/text.js'
import { plain } from '../src/plan/types.js'
import { technical } from '../src/theme/presets/technical.js'

describe('renderTextBlocks', () => {
  it('starts at index 1, because index 0 is not a valid location', () => {
    const { requests } = renderTextBlocks([{ runs: plain('Hello'), style: 'TITLE' }], technical)
    expect(requests[0].insertText?.location?.index).toBe(BODY_START)
    expect(BODY_START).toBe(1)
  })

  it('separates paragraphs with \\n without terminating the last one', () => {
    // A trailing \n would leave an empty paragraph at the end of the document: the fresh document
    // already supplies the newline that closes the final paragraph.
    const { requests } = renderTextBlocks(
      [
        { runs: plain('One'), style: 'HEADING_1' },
        { runs: plain('Two'), style: 'NORMAL_TEXT' },
      ],
      technical,
    )
    expect(requests[0].insertText?.text).toBe('One\nTwo')
  })

  it('accounts for the paragraph newline when advancing the cursor', () => {
    const { ranges, endIndex } = renderTextBlocks(
      [
        { runs: plain('One'), style: 'HEADING_1' }, // [1, 4), \n at 4
        { runs: plain('Two'), style: 'NORMAL_TEXT' }, // [5, 8)
      ],
      technical,
    )
    expect(ranges).toEqual([
      { startIndex: 1, endIndex: 4 },
      { startIndex: 5, endIndex: 8 },
    ])
    expect(endIndex).toBe(9)
  })

  // CLAUDE.md: indices are UTF-16 code units, which is what String.length returns. Counting code
  // points instead would put every subsequent range one unit short per astral character.
  it('measures astral characters as two UTF-16 units, not one', () => {
    const { ranges } = renderTextBlocks(
      [
        { runs: plain('ok 👍'), style: 'NORMAL_TEXT' }, // 3 + 2 = 5 units
        { runs: plain('next'), style: 'NORMAL_TEXT' },
      ],
      technical,
    )
    expect(ranges[0]).toEqual({ startIndex: 1, endIndex: 6 })
    expect(ranges[1]?.startIndex).toBe(7)
    expect([...'ok 👍'].length).toBe(4) // the wrong answer, kept here so the intent is unmistakable
  })

  it('never styles a range that reaches the final newline', () => {
    const { requests, ranges } = renderTextBlocks([{ runs: plain('Solo'), style: 'TITLE' }], technical)
    expect(ranges[0]).toEqual({ startIndex: 1, endIndex: 5 })
    expect(requests[1].updateParagraphStyle?.fields).toBe('named_style_type')
  })

  it('rejects a block whose flattened text contains a newline', () => {
    expect(() =>
      renderTextBlocks([{ runs: plain('a\nb'), style: 'NORMAL_TEXT' }], technical),
    ).toThrow(/must not contain/)
  })

  it('rejects a block with no text, which has no valid style range', () => {
    expect(() => renderTextBlocks([{ runs: plain(''), style: 'NORMAL_TEXT' }], technical)).toThrow(
      /no text/,
    )
  })

  it('propagates tabId onto the location and every paragraph range', () => {
    const { requests, ranges } = renderTextBlocks([{ runs: plain('Hi'), style: 'TITLE' }], technical, {
      tabId: 't1',
    })
    expect(requests[0].insertText?.location?.tabId).toBe('t1')
    expect(ranges[0]?.tabId).toBe('t1')
  })

  it('returns nothing for no blocks', () => {
    expect(renderTextBlocks([], technical)).toEqual({ requests: [], ranges: [], endIndex: 1 })
  })

  it('costs zero requests for plain prose beyond the paragraph style', () => {
    const { requests } = renderTextBlocks([{ runs: plain('just words'), style: 'NORMAL_TEXT' }], technical)
    expect(requests.some((r) => r.updateTextStyle)).toBe(false)
  })

  it('styles a bold run without touching the surrounding plain text', () => {
    const { requests, ranges } = renderTextBlocks(
      [{ runs: [{ kind: 'text', text: 'a ' }, { kind: 'bold', children: [{ kind: 'text', text: 'b' }] }], style: 'NORMAL_TEXT' }],
      technical,
    )
    const styleReqs = requests.filter((r) => r.updateTextStyle)
    expect(styleReqs).toHaveLength(1)
    expect(styleReqs[0]?.updateTextStyle?.range).toEqual({
      startIndex: ranges[0]!.startIndex! + 2,
      endIndex: ranges[0]!.endIndex,
    })
    expect(styleReqs[0]?.updateTextStyle?.textStyle?.bold).toBe(true)
    expect(styleReqs[0]?.updateTextStyle?.fields).toBe('bold')
  })

  it('applies the theme code spec to an inline code run', () => {
    const { requests } = renderTextBlocks(
      [{ runs: [{ kind: 'code', text: 'x' }], style: 'NORMAL_TEXT' }],
      technical,
    )
    const req = requests.find((r) => r.updateTextStyle)?.updateTextStyle
    expect(req?.textStyle?.weightedFontFamily?.fontFamily).toBe('Roboto Mono')
    expect(req?.textStyle?.backgroundColor).toBeDefined()
  })

  it('sets only the link field and lets Docs apply its own default colour and underline', () => {
    const { requests } = renderTextBlocks(
      [{ runs: [{ kind: 'link', href: 'https://x.example', children: [{ kind: 'text', text: 'x' }] }], style: 'NORMAL_TEXT' }],
      technical,
    )
    const req = requests.find((r) => r.updateTextStyle)?.updateTextStyle
    expect(req?.textStyle).toEqual({ link: { url: 'https://x.example' } })
    expect(req?.fields).toBe('link')
  })

  it('keeps run-style requests after every paragraph-style request', () => {
    // A convention, not a correctness requirement (ranges don't overlap either way) — but it keeps
    // snapshot diffs readable as "structure, then decoration."
    const { requests } = renderTextBlocks(
      [{ runs: [{ kind: 'bold', children: [{ kind: 'text', text: 'b' }] }], style: 'HEADING_1' }],
      technical,
    )
    const kinds = requests.map((r) => Object.keys(r)[0])
    expect(kinds.indexOf('updateParagraphStyle')).toBeLessThan(kinds.indexOf('updateTextStyle'))
  })
})
