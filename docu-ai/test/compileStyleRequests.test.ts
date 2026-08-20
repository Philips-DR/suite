import { describe, expect, it } from 'vitest'
import type { docs_v1 } from 'googleapis'
import { compileChapterStyleRequests } from '../src/emit/compile.js'
import type { Segment } from '../src/emit/blocks.js'
import { plain } from '../src/plan/types.js'
import { technical } from '../src/theme/presets/technical.js'

const TAB_ID = 't.chapter1'

function fakeParagraph(start: number, text: string): docs_v1.Schema$StructuralElement {
  return {
    startIndex: start,
    endIndex: start + text.length + 1, // readback includes the trailing \n; see test comment below
    paragraph: { elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text } }] },
  }
}

function fakeCell(start: number, text: string): docs_v1.Schema$TableCell {
  return {
    startIndex: start - 1,
    endIndex: start + text.length + 1,
    content: [
      {
        startIndex: start,
        endIndex: start + text.length + 1,
        paragraph: { elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text } }] },
      },
    ],
  }
}

/**
 * Three segments, chosen to test the one thing that makes M3's orchestration different from M1/M2:
 * a list AFTER a table must sort before that table's own cell fills in the length-changing phase,
 * since it sits at a larger index — even though both are "length-changing" and even though the table
 * was compiled first. Getting this ordering wrong is exactly the kind of bug a snapshot of either
 * phase alone would miss, since it only shows up once the two are merged and sorted together.
 */
const segments: Segment[] = [
  {
    kind: 'text',
    textBlocks: [{ runs: plain('H'), style: 'HEADING_1' }],
    listRuns: [],
    ruleIndices: [],
    codeBlockIndices: [],
    quoteRuns: [],
  },
  {
    kind: 'table',
    table: {
      kind: 'table',
      align: [undefined],
      rows: [[plain('Head')], [plain('X')]],
    },
  },
  {
    kind: 'text',
    textBlocks: [
      { runs: plain('a'), style: 'NORMAL_TEXT' },
      { runs: plain('b'), style: 'NORMAL_TEXT' },
    ],
    listRuns: [{ ordered: false, start: 0, end: 2 }],
    ruleIndices: [],
    codeBlockIndices: [],
    quoteRuns: [],
  },
]

/** A document with just this one tab — the shape `tabBody` expects, not a bare `.body`. */
function fakeDoc(content: docs_v1.Schema$StructuralElement[], tabId = TAB_ID): docs_v1.Schema$Document {
  return { tabs: [{ tabProperties: { tabId }, documentTab: { body: { content } } }] }
}

function fakeChapterContent(): docs_v1.Schema$StructuralElement[] {
  return [
    fakeParagraph(1, 'H'),
    {
      startIndex: 10,
      endIndex: 17,
      table: {
        rows: 2,
        columns: 1,
        tableRows: [
          { tableCells: [fakeCell(12, 'Head')] },
          { tableCells: [fakeCell(15, 'X')] },
        ],
      },
    },
    fakeParagraph(20, 'a'),
    fakeParagraph(22, 'b'),
  ]
}

describe('compileChapterStyleRequests — text and table segments in lockstep', () => {
  const result = compileChapterStyleRequests(fakeDoc(fakeChapterContent()), TAB_ID, segments, technical)

  it('styles the heading using the real readback startIndex, not a placeholder', () => {
    const headingReq = result.contentRequests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    expect(headingReq?.updateParagraphStyle?.range).toEqual({ startIndex: 1, endIndex: 2, tabId: TAB_ID })
  })

  it('scopes every request it builds to this chapter’s own tab', () => {
    for (const r of [...result.contentRequests, ...result.lengthChangingRequests]) {
      const tabId =
        r.updateParagraphStyle?.range?.tabId ??
        r.updateTextStyle?.range?.tabId ??
        r.insertText?.location?.tabId ??
        r.pinTableHeaderRows?.tableStartLocation?.tabId ??
        r.updateTableCellStyle?.tableRange?.tableCellLocation?.tableStartLocation?.tabId ??
        r.createParagraphBullets?.range?.tabId
      expect(tabId).toBe(TAB_ID)
    }
  })

  it('builds table structure requests (pin/shade/indent-reset) from the readback element', () => {
    expect(result.contentRequests.some((r) => r.pinTableHeaderRows)).toBe(true)
    expect(result.contentRequests.some((r) => r.updateTableCellStyle)).toBe(true)
  })

  it('puts the list’s bullet request ahead of the table’s own cell fills in the global sort', () => {
    // The list sits at index 20, after the table (whose cells sit at 12 and 15) — even though the
    // table compiled first, the bullet must apply first: descending by ABSOLUTE position, not by
    // which segment produced the request. "bold" here is the header cell's own [fill, then style]
    // pair travelling together, immediately after its fill — see the next test for that in detail.
    const kinds = result.lengthChangingRequests.map((r) =>
      r.createParagraphBullets ? 'bullet' : r.insertText ? `fill:${r.insertText.location?.index}` : 'bold',
    )
    expect(kinds).toEqual(['bullet', 'fill:15', 'fill:12', 'bold'])
  })

  it('bolds the header cell’s fill but not the data cell’s', () => {
    const headFill = result.lengthChangingRequests.find((r) => r.insertText?.location?.index === 12)
    const dataFill = result.lengthChangingRequests.find((r) => r.insertText?.location?.index === 15)
    expect(headFill?.insertText?.text).toBe('Head')
    expect(dataFill?.insertText?.text).toBe('X')
    // The bold style request for the header cell immediately follows its own fill in the array.
    const headFillIndex = result.lengthChangingRequests.indexOf(headFill!)
    expect(result.lengthChangingRequests[headFillIndex + 1]?.updateTextStyle?.textStyle?.bold).toBe(true)
  })
})

describe('compileChapterStyleRequests — ignores structural noise around real content', () => {
  // Found live at real-corpus scale, not in any small hand-built probe: every fresh document's body
  // opens with an implicit sectionBreak before any content. It's easy to miss by hand (neither
  // .paragraph nor .table matches, so it silently vanishes from an "if paragraph ... else if table"
  // walk) but throws a lockstep count off by exactly one once it's not filtered out.
  it('skips a leading sectionBreak rather than miscounting it as the first paragraph', () => {
    const withSectionBreak = fakeDoc([{ sectionBreak: {} }, ...fakeChapterContent()])
    expect(() => compileChapterStyleRequests(withSectionBreak, TAB_ID, segments, technical)).not.toThrow()
    const result = compileChapterStyleRequests(withSectionBreak, TAB_ID, segments, technical)
    const headingReq = result.contentRequests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    expect(headingReq?.updateParagraphStyle?.range).toMatchObject({ startIndex: 1, endIndex: 2 })
  })
})

describe('compileChapterStyleRequests — defensive checks', () => {
  it('throws a clear error when the readback has fewer paragraphs than the segment expects', () => {
    const shortDoc = fakeDoc([fakeParagraph(1, 'H')])
    expect(() => compileChapterStyleRequests(shortDoc, TAB_ID, segments, technical)).toThrow(/expected/)
  })

  it('throws when a table segment lines up against a non-table readback element', () => {
    const wrongDoc = fakeDoc([fakeParagraph(1, 'H'), fakeParagraph(5, 'not a table')])
    expect(() => compileChapterStyleRequests(wrongDoc, TAB_ID, segments, technical)).toThrow(/expected a table/)
  })

  it('throws a clear error when the requested tabId isn’t in the readback at all', () => {
    const doc = fakeDoc(fakeChapterContent(), 't.other-chapter')
    expect(() => compileChapterStyleRequests(doc, TAB_ID, segments, technical)).toThrow(/no body found for tab/)
  })
})
