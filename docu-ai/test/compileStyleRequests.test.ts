import { describe, expect, it } from 'vitest'
import type { docs_v1 } from 'googleapis'
import { compileChapterContentRequests, compileChapterLengthChangingRequests } from '../src/emit/compile.js'
import type { Segment } from '../src/emit/blocks.js'
import { plain } from '../src/plan/types.js'
import { technical } from '../src/theme/presets/technical.js'

const NO_HEADINGS: Array<{ tabId: string; headingId: string }> = []

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

describe('compileChapterContentRequests / compileChapterLengthChangingRequests — text and table segments in lockstep', () => {
  const doc = fakeDoc(fakeChapterContent())
  const content = compileChapterContentRequests(doc, TAB_ID, segments, technical)
  const lengthChangingRequests = compileChapterLengthChangingRequests(doc, TAB_ID, segments, technical, NO_HEADINGS)

  it('styles the heading using the real readback startIndex, not a placeholder', () => {
    const headingReq = content.contentRequests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    expect(headingReq?.updateParagraphStyle?.range).toEqual({ startIndex: 1, endIndex: 2, tabId: TAB_ID })
  })

  it('scopes every request it builds to this chapter’s own tab', () => {
    for (const r of [...content.contentRequests, ...lengthChangingRequests]) {
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
    expect(content.contentRequests.some((r) => r.pinTableHeaderRows)).toBe(true)
    expect(content.contentRequests.some((r) => r.updateTableCellStyle)).toBe(true)
  })

  it('puts the list’s bullet request ahead of the table’s own cell fills in the global sort', () => {
    // The list sits at index 20, after the table (whose cells sit at 12 and 15) — even though the
    // table compiled first, the bullet must apply first: descending by ABSOLUTE position, not by
    // which segment produced the request. "bold" here is the header cell's own [fill, then style]
    // pair travelling together, immediately after its fill — see the next test for that in detail.
    const kinds = lengthChangingRequests.map((r) =>
      r.createParagraphBullets ? 'bullet' : r.insertText ? `fill:${r.insertText.location?.index}` : 'bold',
    )
    expect(kinds).toEqual(['bullet', 'fill:15', 'fill:12', 'bold'])
  })

  it('bolds the header cell’s fill but not the data cell’s', () => {
    const headFill = lengthChangingRequests.find((r) => r.insertText?.location?.index === 12)
    const dataFill = lengthChangingRequests.find((r) => r.insertText?.location?.index === 15)
    expect(headFill?.insertText?.text).toBe('Head')
    expect(dataFill?.insertText?.text).toBe('X')
    // The bold style request for the header cell immediately follows its own fill in the array.
    const headFillIndex = lengthChangingRequests.indexOf(headFill!)
    expect(lengthChangingRequests[headFillIndex + 1]?.updateTextStyle?.textStyle?.bold).toBe(true)
  })
})

describe('compileChapterContentRequests / compileChapterLengthChangingRequests — ignore structural noise around real content', () => {
  // Found live at real-corpus scale, not in any small hand-built probe: every fresh document's body
  // opens with an implicit sectionBreak before any content. It's easy to miss by hand (neither
  // .paragraph nor .table matches, so it silently vanishes from an "if paragraph ... else if table"
  // walk) but throws a lockstep count off by exactly one once it's not filtered out. Both functions
  // share the same matching helper (compile.ts's matchSegmentsToElements), but each is tested here to
  // confirm neither reimplements it divergently.
  const withSectionBreak = fakeDoc([{ sectionBreak: {} }, ...fakeChapterContent()])

  it('compileChapterContentRequests skips a leading sectionBreak rather than miscounting it', () => {
    expect(() => compileChapterContentRequests(withSectionBreak, TAB_ID, segments, technical)).not.toThrow()
    const content = compileChapterContentRequests(withSectionBreak, TAB_ID, segments, technical)
    const headingReq = content.contentRequests.find(
      (r) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1',
    )
    expect(headingReq?.updateParagraphStyle?.range).toMatchObject({ startIndex: 1, endIndex: 2 })
  })

  it('compileChapterLengthChangingRequests skips a leading sectionBreak rather than miscounting it', () => {
    expect(() =>
      compileChapterLengthChangingRequests(withSectionBreak, TAB_ID, segments, technical, NO_HEADINGS),
    ).not.toThrow()
  })
})

describe('compileChapterContentRequests / compileChapterLengthChangingRequests — image segments (M8)', () => {
  const imageSegments: Segment[] = [
    {
      kind: 'text',
      textBlocks: [{ runs: plain('Before'), style: 'NORMAL_TEXT' }],
      listRuns: [],
      ruleIndices: [],
      codeBlockIndices: [],
      quoteRuns: [],
    },
    {
      kind: 'image',
      image: { kind: 'image', src: 'https://example.com/x.png', alt: 'x', title: undefined },
      naturalWidth: 100,
      naturalHeight: 50,
    },
    {
      kind: 'text',
      textBlocks: [{ runs: plain('After'), style: 'NORMAL_TEXT' }],
      listRuns: [],
      ruleIndices: [],
      codeBlockIndices: [],
      quoteRuns: [],
    },
  ]

  // The image's own paragraph: [inlineObjectElement, textRun("\n")] — matches the live-verified shape
  // from emit/image.ts's imageInsertRequests (leading/trailing '\n' flanking the image itself).
  function fakeImageParagraph(start: number): docs_v1.Schema$StructuralElement {
    return {
      startIndex: start,
      endIndex: start + 2,
      paragraph: {
        elements: [
          { startIndex: start, endIndex: start + 1, inlineObjectElement: { inlineObjectId: 'kix.abc' } },
          { startIndex: start + 1, endIndex: start + 2, textRun: { content: '\n' } },
        ],
      },
    }
  }

  const doc = fakeDoc([fakeParagraph(1, 'Before'), fakeImageParagraph(8), fakeParagraph(10, 'After')])

  it('produces no content requests and no length-changing requests for the image itself', () => {
    const content = compileChapterContentRequests(doc, TAB_ID, imageSegments, technical)
    expect(content.contentRequests.every((r) => !r.insertInlineImage)).toBe(true)
    const lengthChanging = compileChapterLengthChangingRequests(doc, TAB_ID, imageSegments, technical, NO_HEADINGS)
    expect(lengthChanging).toEqual([])
  })

  it('does not let the image’s one-element paragraph throw off the following text segment’s real start', () => {
    const content = compileChapterContentRequests(doc, TAB_ID, imageSegments, technical)
    const afterReq = content.contentRequests.find((r) => r.updateParagraphStyle?.range?.startIndex === 10)
    expect(afterReq).toBeDefined()
  })

  it('throws a clear error if a non-paragraph element sits where the image’s own paragraph should', () => {
    // Not simply removing the image's element: with a shared cursor, that just shifts every element
    // after it by one, surfacing as the NEXT segment's own count mismatch instead — a real, valid
    // failure, just not the one this test means to isolate. A table standing in for the image's own
    // paragraph is what actually exercises image's own "must be a paragraph" check.
    const wrongKindDoc = fakeDoc([
      fakeParagraph(1, 'Before'),
      { startIndex: 8, endIndex: 10, table: { rows: 1, columns: 1 } },
      fakeParagraph(10, 'After'),
    ])
    expect(() => compileChapterContentRequests(wrongKindDoc, TAB_ID, imageSegments, technical)).toThrow(
      /expected the image.s own paragraph element/,
    )
  })
})

describe('compileChapterContentRequests / compileChapterLengthChangingRequests — defensive checks', () => {
  it('throws a clear error when the readback has fewer paragraphs than the segment expects', () => {
    const shortDoc = fakeDoc([fakeParagraph(1, 'H')])
    expect(() => compileChapterContentRequests(shortDoc, TAB_ID, segments, technical)).toThrow(/expected/)
    expect(() =>
      compileChapterLengthChangingRequests(shortDoc, TAB_ID, segments, technical, NO_HEADINGS),
    ).toThrow(/expected/)
  })

  it('throws when a table segment lines up against a non-table readback element', () => {
    const wrongDoc = fakeDoc([fakeParagraph(1, 'H'), fakeParagraph(5, 'not a table')])
    expect(() => compileChapterContentRequests(wrongDoc, TAB_ID, segments, technical)).toThrow(/expected a table/)
  })

  it('throws a clear error when the requested tabId isn’t in the readback at all', () => {
    const doc = fakeDoc(fakeChapterContent(), 't.other-chapter')
    expect(() => compileChapterContentRequests(doc, TAB_ID, segments, technical)).toThrow(/no body found for tab/)
  })
})
